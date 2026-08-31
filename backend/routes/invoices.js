/**
 * Billing — Gaurav.
 *
 *   GET  /api/invoices                 the bill queue
 *   GET  /api/invoices/:id             one invoice with its lines
 *   POST /api/invoices                 raise one against a verified order (R02, R04)
 *   GET  /api/invoices/credit-notes    credit notes
 *   POST /api/invoices/credit-notes    raise one
 *   POST /api/invoices/credit-notes/:id/issue   post it to the ledger
 *
 * Nothing here reads agents or agent_commissions. Agent identity and commission
 * stay off the printed document (R21), and the way that is guaranteed is that
 * the billing path has no reason to join those tables at all.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { money, transition, notify, nextDocNumber, recomputeBalance } = require('../utils/workflow');
const { businessDay } = require('../utils/businessDay');
const { qualifyingValue } = require('../utils/pricing');
const { creditPurchase } = require('../utils/scheme');
const { creditInvoice: creditGrowth } = require('../utils/growthScheme');
const {
  enqueue: tallyEnqueue, salesInvoiceXml, creditNoteXml, config: tallyConfig,
} = require('../utils/tally');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/invoices — what is waiting to be billed, and what already was
router.get('/', requirePermission('billing.view'), async (req, res, next) => {
  try {
    const [pending] = await pool.query(
      `SELECT o.order_id, o.total_amount, c.name AS party, o.status
         FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.status = 'verified'
        ORDER BY o.order_id`
    );

    const [issued] = await pool.query(
      `SELECT i.id, i.invoice_no, i.order_id, i.party_name, i.grand_total, i.invoice_date, i.status
         FROM invoices i
        ORDER BY i.id DESC
        LIMIT 50`
    );

    res.json({ awaiting: pending, invoices: issued });
  } catch (err) {
    next(err);
  }
});

// GET /api/invoices/credit-notes
router.get('/credit-notes', requirePermission('billing.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT cn.*, c.name AS party, i.invoice_no
         FROM credit_notes cn
         JOIN customers c ON c.masterid = cn.customer_id
         LEFT JOIN invoices i ON i.id = cn.invoice_id
        ORDER BY cn.status = 'issued', cn.id DESC
        LIMIT 100`
    );
    res.json({ credit_notes: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices/credit-notes
router.post('/credit-notes', requirePermission('billing.create'), async (req, res, next) => {
  const { customer_id, invoice_id, return_id, amount, reason } = req.body || {};

  if (!Number.isInteger(Number(customer_id))) {
    return res.status(400).json({ error: 'customer_id is required' });
  }
  const value = money(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'A credit note needs an amount greater than zero' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const noteNo = await nextDocNumber(conn, {
      table: 'credit_notes',
      column: 'note_no',
      prefix: 'CN-',
      width: 3,
    });

    const [result] = await conn.query(
      `INSERT INTO credit_notes (note_no, customer_id, invoice_id, return_id, amount, reason, note_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        noteNo,
        Number(customer_id),
        invoice_id ? Number(invoice_id) : null,
        return_id ? Number(return_id) : null,
        value,
        reason || null,
        businessDay(),
      ]
    );

    await conn.commit();
    res.status(201).json({ message: 'Credit note raised', id: result.insertId, note_no: noteNo });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/invoices/credit-notes/:id/issue
router.post('/credit-notes/:id/issue', requirePermission('billing.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Guarded on the current status inside the UPDATE rather than read-then-write:
    // two clerks issuing the same note would otherwise both succeed and the
    // party's ledger would be credited twice.
    const [result] = await conn.query(
      `UPDATE credit_notes SET status = 'issued', issued_by = ?, issued_at = NOW()
        WHERE id = ? AND status = 'pending'`,
      [req.user.id, Number(req.params.id)]
    );

    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(409).json({ error: 'That note is not pending — it may already be issued.' });
    }

    // Issuing is the moment the credit becomes money the party may set against
    // their account, so it is the moment the balance moves — not when the note
    // was raised.
    const [[note]] = await conn.query(
      `SELECT n.*, c.name AS party_name FROM credit_notes n
         JOIN customers c ON c.masterid = n.customer_id WHERE n.id = ?`,
      [Number(req.params.id)]
    );
    await recomputeBalance(conn, note.customer_id);

    // Section 14 lists two credit-note flows — "Credit Notes (on approval)" and
    // "Cash Discount Credit Notes (auto, FIFO calculation)" — and both arrive
    // here, because issuing is the single moment a note becomes money the party
    // may set against their account. The `kind` distinguishes them so the Tally
    // status screen can report the automatic ones separately.
    await tallyEnqueue(conn, {
      kind: note.origin === 'cash_discount' ? 'cash_discount_note' : 'credit_note',
      refType: 'credit_note',
      refId: note.id,
      payload: creditNoteXml({ note, company: tallyConfig().company }),
      userId: req.user.id,
    });

    await conn.commit();
    res.json({ message: 'Credit note issued' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/invoices/:id
router.get('/:id', requirePermission('billing.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [[invoice]] = await pool.query('SELECT * FROM invoices WHERE id = ?', [id]);
    if (!invoice) return res.status(404).json({ error: 'No such invoice' });

    const [lines] = await pool.query('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [id]);
    res.json({ invoice, lines });
  } catch (err) {
    next(err);
  }
});

// POST /api/invoices — raise an invoice against a verified order
router.post('/', requirePermission('billing.create'), async (req, res, next) => {
  const orderId = Number(req.body?.order_id);
  const overrides = Array.isArray(req.body?.lines) ? req.body.lines : [];

  if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'order_id is required' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[order]] = await conn.query(
      `SELECT o.order_id, o.status, o.customer_id, o.customer_type,
              o.scheme_member_id, o.so_number,
              c.name AS party_name, c.gst_number
         FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.order_id = ? FOR UPDATE`,
      [orderId]
    );

    if (!order) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such order' });
    }

    // R02: verification is mandatory before an invoice exists. Enforced here and
    // not only in the UI, because this is the boundary that actually holds.
    if (order.status !== 'verified') {
      await conn.rollback();
      return res.status(409).json({
        error: `An order must be verified before it can be billed. This one is ${order.status}.`,
        code: 'NOT_VERIFIED',
      });
    }

    // The billed quantity is what Ajit counted, not what the SO said: a short
    // pick bills short, which is the whole reason the count happens first.
    const [lines] = await conn.query(
      `SELECT oi.id, oi.item_id, oi.item_name, oi.hsn, oi.rate, oi.discount, oi.gst_percent,
              oi.scheme_weightage,
              COALESCE(v.counted_qty, oi.qty) AS billed_qty
         FROM order_items oi
         LEFT JOIN order_verifications v ON v.order_item_id = oi.id
        WHERE oi.order_id = ?
        ORDER BY oi.id`,
      [orderId]
    );

    if (!lines.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'That order has no lines to bill' });
    }

    // R04: the rate is Gaurav's to edit. Only the rate — quantity comes from the
    // count and the item identity comes from the order.
    const rateById = new Map(
      overrides
        .filter((line) => Number.isInteger(Number(line.order_item_id)))
        .map((line) => [Number(line.order_item_id), Number(line.rate)])
    );

    // Cost is read to flag a below-cost line. It is a warning, not a block: a
    // distress sale and a correction against a credit note are both legitimate,
    // and Gaurav is the person trusted with the call. It simply cannot happen
    // quietly.
    const [costs] = await conn.query(
      `SELECT pi.item_id, MAX(pi.rate) AS cost
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id AND p.status = 'posted'
        WHERE pi.item_id IN (?)
        GROUP BY pi.item_id`,
      [lines.map((l) => l.item_id)]
    );
    const costById = new Map(costs.map((row) => [row.item_id, Number(row.cost)]));

    let subTotal = 0;
    let gstTotal = 0;
    const billed = [];

    for (const line of lines) {
      const qtyBilled = Number(line.billed_qty);
      if (qtyBilled <= 0) continue; // nothing arrived; nothing to charge for

      const override = rateById.get(line.id);
      const rate = Number.isFinite(override) && override >= 0 ? money(override) : Number(line.rate);
      const discount = Number(line.discount) || 0;
      const gstPercent = Number(line.gst_percent) || 0;

      const net = money(qtyBilled * rate * (1 - discount / 100));
      const gst = money(net * (gstPercent / 100));

      subTotal = money(subTotal + net);
      gstTotal = money(gstTotal + gst);

      const cost = costById.get(line.item_id);
      billed.push({
        item_id: line.item_id,
        item_name: line.item_name,
        hsn: line.hsn,
        qty: qtyBilled,
        rate,
        discount,
        gst_percent: gstPercent,
        gst_amount: gst,
        total: money(net + gst),
        below_cost: cost !== undefined && rate < cost,
        // Kept for the two things written after the invoice exists: the
        // qualifying value the electrician's scheme earns, and the rate the
        // next salesman is shown as "previous".
        net,
        scheme_weightage: line.scheme_weightage,
      });
    }

    if (!billed.length) {
      await conn.rollback();
      return res.status(409).json({
        error: 'Every line counted zero. There is nothing to bill.',
        code: 'NOTHING_TO_BILL',
      });
    }

    const invoiceNo = await nextDocNumber(conn, {
      table: 'invoices',
      column: 'invoice_no',
      prefix: 'INV-',
      width: 4,
    });

    const [inserted] = await conn.query(
      `INSERT INTO invoices
         (invoice_no, order_id, customer_id, party_name, party_gstin, invoice_date,
          sub_total, gst_amount, grand_total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo,
        orderId,
        order.customer_id,
        order.party_name,
        order.gst_number || null,
        businessDay(),
        subTotal,
        gstTotal,
        money(subTotal + gstTotal),
        req.user.id,
      ]
    );

    const invoiceId = inserted.insertId;

    for (const line of billed) {
      await conn.query(
        `INSERT INTO invoice_items
           (invoice_id, item_id, item_name, hsn, qty, rate, discount, gst_percent, gst_amount, total, below_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invoiceId, line.item_id, line.item_name, line.hsn, line.qty, line.rate,
          line.discount, line.gst_percent, line.gst_amount, line.total, line.below_cost,
        ]
      );
    }

    const result = await transition(conn, {
      orderId,
      to: 'invoiced',
      expectedFrom: 'verified',
      userId: req.user.id,
      note: invoiceNo,
    });

    if (!result.ok) {
      await conn.rollback();
      return res.status(409).json({ error: result.message, code: result.reason });
    }

    // "The previous rate (last sale price for this item) is displayed alongside
    // for reference." Written here rather than at order time: the order rate is
    // a proposal Gaurav may still edit, and what the next salesman needs to see
    // is what the party was actually billed.
    for (const line of billed) {
      await conn.query(
        `INSERT INTO item_rate_history
           (item_id, customer_id, customer_type, rate, qty, invoice_id, billed_on)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [line.item_id, order.customer_id, order.customer_type, line.rate,
          line.qty, invoiceId, businessDay()]
      );
    }

    // KL Utsav qualifying value moves on billing, not on ordering (3.2):
    // "added to the member's cumulative total after the order is billed."
    // Weighted per item — wire counts half — and computed on the net value
    // before GST, which is what the scheme document specifies.
    let schemeCredited = null;
    if (order.scheme_member_id) {
      const qualifying = billed.reduce(
        (a, l) => money(a + qualifyingValue({ scheme_weightage: l.scheme_weightage }, l.net)), 0);
      schemeCredited = await creditPurchase(conn, {
        memberId: order.scheme_member_id,
        orderId,
        invoiceId,
        amount: qualifying,
        note: `Invoice ${invoiceNo}`,
      });
    }

    // Section 14: "Sales Invoices (on creation)" and 4.5: "The invoice is
    // automatically synced to Tally on creation."
    //
    // Enqueued, not posted. Tally lives on an office desktop that is closed at
    // night; billing a customer must not depend on it being switched on, and a
    // push attempted inline would either fail the invoice or be lost silently.
    const [invLines] = await conn.query(
      `SELECT ii.*, i.unit FROM invoice_items ii
         LEFT JOIN items i ON i.masterid = ii.item_id WHERE ii.invoice_id = ?`,
      [invoiceId]
    );
    const [[invRow]] = await conn.query('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    await tallyEnqueue(conn, {
      kind: 'sales_invoice',
      refType: 'invoice',
      refId: invoiceId,
      payload: salesInvoiceXml({
        invoice: invRow, lines: invLines, company: tallyConfig().company }),
      userId: req.user.id,
    });

    // The Lemac dealer growth schemes (monthly / quarterly / yearly). Accrues
    // only for a dealer, only on items carrying the scheme's own validity flag,
    // and on the net value before GST — all three from the Lemac sheet. Returns
    // an empty list when no growth scheme is active, which is the state the
    // schemes are seeded in.
    const growth = await creditGrowth(conn, {
      invoiceId,
      customerId: order.customer_id,
      customerType: order.customer_type,
      invoiceDate: businessDay(),
    });

    // The invoice is what the party now owes, so the cached balance moves with
    // it — in this transaction, never as a follow-up write.
    await recomputeBalance(conn, order.customer_id);

    const underCost = billed.filter((line) => line.below_cost);
    if (underCost.length) {
      await notify(conn, {
        tone: 'warning',
        title: 'Billed below cost',
        body: `${invoiceNo} — ${underCost.map((l) => l.item_name).join(', ')} priced under purchase cost.`,
        actor: req.user.name,
        refType: 'invoice',
        refId: invoiceId,
      });
    }

    await conn.commit();
    res.status(201).json({
      message: 'Invoice created',
      invoice_id: invoiceId,
      invoice_no: invoiceNo,
      sub_total: subTotal,
      gst_amount: gstTotal,
      grand_total: money(subTotal + gstTotal),
      below_cost_lines: underCost.length,
      // Null unless the party was an electrician on the KL Utsav scheme.
      // Carries the new total and the slab it has reached, so the biller can
      // tell the customer at the counter.
      scheme: schemeCredited,
      // One entry per live growth scheme this dealer accrued on. Empty for a
      // non-dealer, and empty while the Lemac schemes are inactive.
      growth,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
