/**
 * Purchase — Sonu. The only thing that adds stock without an order behind it.
 *
 *   GET  /api/purchases                     recent dockets
 *   GET  /api/purchases/rate-alerts         what suppliers have moved
 *   GET  /api/purchases/item-context/:id    5.1 — shown beside the line, at entry
 *   POST /api/purchases                     enter and post one
 *
 * Posting writes `receipt` movements and recomputes items.qty in the same
 * transaction. items.qty is a cache of the ledger and is never written on its
 * own.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { money, qty, moveStock, notify, usersWithGrant, usersWhoCan } = require('../utils/workflow');
const { userCan } = require('../utils/permissions');
const { numericId } = require('../middleware/params');
const { allRates } = require('../utils/pricing');
const {
  enqueue: tallyEnqueue, purchaseXml, config: tallyConfig,
} = require('../utils/tally');
const { businessDay, requestedDay } = require('../utils/businessDay');

// 5.1 — "Beyond the set %: reason mandatory from a fixed list." No figure is
// given, same treatment as every other unstated threshold in this project:
// left disabled (0) until Yash names one.
const RATE_CHANGE_REASON_THRESHOLD = Number(process.env.PURCHASE_RATE_REASON_THRESHOLD) || 0;
const RATE_CHANGE_REASONS = [
  'company_price_revision', 'different_pack_size', 'different_supplier',
  'freight_treated_differently', 'entry_correction',
];

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/purchases
router.get('/', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS entered_by
         FROM purchases p
         LEFT JOIN users u ON u.id = p.created_by
        ORDER BY p.id DESC
        LIMIT 50`
    );
    res.json({ purchases: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/purchases/rate-alerts
 *
 * What each item was last bought at, against the time before. Read from the
 * stored last_rate rather than recomputed from the item master, so the alert
 * survives the master's cost being updated afterwards.
 *
 * A rise is the bad outcome here — this is the buyer's view, not a stock
 * ticker — and the screen colours it accordingly.
 */
router.get('/rate-alerts', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT pi.item_id, pi.item_name, pi.rate AS new_rate, pi.last_rate AS old_rate,
              p.supplier_name, p.purchase_date,
              ROUND(((pi.rate - pi.last_rate) / NULLIF(pi.last_rate, 0)) * 100, 1) AS change_percent
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id
         JOIN (
           SELECT pi2.item_id, MAX(pi2.id) AS latest
             FROM purchase_items pi2
             JOIN purchases p2 ON p2.id = pi2.purchase_id AND p2.status = 'posted'
            GROUP BY pi2.item_id
         ) newest ON newest.latest = pi.id
        WHERE pi.last_rate IS NOT NULL AND pi.last_rate <> pi.rate
        ORDER BY ABS((pi.rate - pi.last_rate) / NULLIF(pi.last_rate, 0)) DESC
        LIMIT 50`
    );

    res.json({
      alerts: rows.map((row) => ({
        ...row,
        direction: Number(row.new_rate) > Number(row.old_rate) ? 'up' : 'down',
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/purchases/item-context/:id — 5.1, "shown beside the line, at
 * entry": the last purchase rate, its date and supplier, plus today's
 * selling rates so a broken margin is visible before the entry is saved.
 * The client computes margin-at-typed-rate locally from `selling_rates`
 * rather than round-tripping on every keystroke.
 */
router.get('/item-context/:id', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const itemId = Number(req.params.id);
    const [[item]] = await pool.query('SELECT * FROM items WHERE masterid = ?', [itemId]);
    if (!item) return res.status(404).json({ error: 'No such item' });

    const [[last]] = await pool.query(
      `SELECT pi.rate, p.purchase_date, p.supplier_name
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id AND p.status = 'posted'
        WHERE pi.item_id = ?
        ORDER BY p.purchase_date DESC, pi.id DESC
        LIMIT 1`,
      [itemId]
    );

    res.json({
      item_id: itemId,
      name: item.name,
      last_purchase: last
        ? { rate: Number(last.rate), date: last.purchase_date, supplier: last.supplier_name }
        : null,
      cost_price: item.cost_price !== null ? Number(item.cost_price) : null,
      selling_rates: allRates(item),
      rate_change_reasons: RATE_CHANGE_REASONS,
      rate_change_reason_threshold: RATE_CHANGE_REASON_THRESHOLD,
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases — enter a docket and post it to the ledger
/**
 * The five purchase forms of section 5, and what each one changes.
 *
 *   L-B  local, GST bill in hand      → posts straight away, registered
 *   L-C  local, challan only          → unregistered, 7-day GST countdown
 *   C    company vehicle              → either, depending on the document
 *   O-B  outside, bill with the goods → arrives against a bilty, registered
 *   O-C  outside, challan only        → unregistered, countdown from receipt
 *
 * The form decides three otherwise unrelated things: whether a challan number
 * is mandatory (R-13), whether a GST countdown starts (5.3), and whether the
 * entry can be posted at all before Sonu has verified it (5.1).
 */
const PURCHASE_TYPES = {
  LB: { label: 'Local — Bill', needsBill: true, registered: true, gstDays: 0, outside: false },
  LC: { label: 'Local — Challan', needsChallan: true, registered: false, gstDays: 7, outside: false },
  C: { label: 'Company Direct', registered: null, gstDays: 7, outside: false },
  OB: { label: 'Outside — Bill', needsBill: true, registered: true, gstDays: 0, outside: true },
  OC: { label: 'Outside — Challan', needsChallan: true, registered: false, gstDays: 7, outside: true },
};

/** GET /api/purchases/types — the dropdown, and what each choice implies. */
router.get('/types', requirePermission('purchases.view'), (req, res) => {
  res.json({
    types: Object.entries(PURCHASE_TYPES).map(([code, t]) => ({
      code,
      label: t.label,
      needs_bill: Boolean(t.needsBill),
      needs_challan: Boolean(t.needsChallan),
      needs_bilty: Boolean(t.outside),
      gst_countdown_days: t.gstDays,
    })),
    conditions: ['ok', 'damaged', 'short', 'excess'],
  });
});

/**
 * POST /api/purchases — receive goods.
 *
 * Rules enforced here rather than only in the UI:
 *
 *   R-08  Bill Quantity and Actual Quantity are two separate mandatory fields.
 *         Never merged. Both recorded independently.
 *   R-12  No document, no purchase entry: at least one photograph of the bill
 *         or challan. Submission blocked without it.
 *   R-13  A challan-type purchase must carry its challan number.
 *   R-15  Sibu cannot self-approve. An entry Sibu created is posted by
 *         somebody else.
 *
 * The entry does NOT post to stock immediately unless the receiver is the
 * verifier. "Sujay or Dishal receives the goods and submits the entry under
 * their own name. The order status becomes Verification Pending... Sonu must
 * physically review the received goods, confirm quantities, and provide his
 * verification before Sibu can proceed with the Tally entry."
 */
router.post('/', requirePermission('purchases.create'), async (req, res, next) => {
  const {
    purchase_type = 'LB',
    supplier_id,
    supplier_name,
    invoice_no,
    challan_no,
    purchase_date,
    git_id,
    lines,
    // R-12 — the receiving photographs. Ids from POST /api/attachments.
    document_photo_id,
    goods_photo_id,
    bilty_photo_id,
  } = req.body || {};

  const type = PURCHASE_TYPES[purchase_type];
  if (!type) {
    return res.status(400).json({
      error: `Purchase type must be one of ${Object.keys(PURCHASE_TYPES).join(', ')}.`,
      code: 'BAD_PURCHASE_TYPE',
    });
  }
  if (!String(supplier_name || '').trim() && !supplier_id) {
    return res.status(400).json({ error: 'Name the supplier.', code: 'SUPPLIER_REQUIRED' });
  }
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'Send at least one line' });
  }

  // R-13.
  if (type.needsChallan && !String(challan_no || '').trim()) {
    return res.status(400).json({
      error: `A ${type.label} purchase must carry its challan number.`,
      code: 'CHALLAN_REQUIRED',
    });
  }
  if (type.needsBill && !String(invoice_no || '').trim()) {
    return res.status(400).json({
      error: `A ${type.label} purchase must carry its bill number.`,
      code: 'BILL_NO_REQUIRED',
    });
  }
  if (purchase_type === 'C' && !String(invoice_no || '').trim() && !String(challan_no || '').trim()) {
    return res.status(400).json({
      error: 'A company delivery must carry either a bill number or a challan number.',
      code: 'DOCUMENT_REQUIRED',
    });
  }

  // R-12 — "At least one photograph (bill or challan) must be uploaded.
  // Submission is blocked without it."
  if (!document_photo_id) {
    return res.status(400).json({
      error: 'Photograph the bill or challan before submitting. No document, no entry.',
      code: 'DOCUMENT_PHOTO_REQUIRED',
    });
  }
  // "For outside purchases, a photo of the bilty (LR copy) is also required."
  if (type.outside && !bilty_photo_id && !git_id) {
    return res.status(400).json({
      error: 'An outside purchase needs the bilty photograph, or the LR it arrived against.',
      code: 'BILTY_REQUIRED',
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (const [label, id] of [['document', document_photo_id], ['goods', goods_photo_id],
      ['bilty', bilty_photo_id]]) {
      if (!id) continue;
      const [[att]] = await conn.query('SELECT id FROM attachments WHERE id = ?', [Number(id)]);
      if (!att) {
        await conn.rollback();
        return res.status(400).json({
          error: `The ${label} photograph was not found.`, code: 'PHOTO_NOT_FOUND' });
      }
    }

    const ids = [...new Set(lines.map((line) => Number(line.item_id)))];
    if (ids.some((id) => !Number.isInteger(id))) {
      await conn.rollback();
      return res.status(400).json({ error: 'Every line needs a valid item_id' });
    }

    const [masters] = await conn.query(
      `SELECT masterid, name, gst_percent FROM items
        WHERE masterid IN (?) AND is_active = TRUE FOR UPDATE`,
      [ids]
    );
    const masterById = new Map(masters.map((row) => [row.masterid, row]));

    const [previous] = await conn.query(
      `SELECT pi.item_id, pi.rate
         FROM purchase_items pi
         JOIN (
           SELECT pi2.item_id, MAX(pi2.id) AS latest
             FROM purchase_items pi2
             JOIN purchases p2 ON p2.id = pi2.purchase_id AND p2.status = 'posted'
            WHERE pi2.item_id IN (?)
            GROUP BY pi2.item_id
         ) newest ON newest.latest = pi.id`,
      [ids]
    );
    const lastRateById = new Map(previous.map((row) => [row.item_id, Number(row.rate)]));

    let subTotal = 0;
    let gstTotal = 0;
    const prepared = [];
    const discrepancies = [];

    for (const line of lines) {
      const master = masterById.get(Number(line.item_id));
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Item ${line.item_id} is not available` });
      }

      // R-08 — two fields, both required, neither derived from the other.
      // Defaulting the actual quantity to the bill quantity is exactly the
      // merge the rule forbids: it would record a count nobody made.
      const billQty = qty(Number(line.bill_qty));
      const actualQty = qty(Number(line.actual_qty));
      if (!Number.isFinite(billQty) || billQty <= 0) {
        await conn.rollback();
        return res.status(400).json({
          error: `${master.name}: the bill quantity must be greater than zero.`,
          code: 'BILL_QTY_REQUIRED',
        });
      }
      if (!Number.isFinite(actualQty) || actualQty < 0) {
        await conn.rollback();
        return res.status(400).json({
          error: `${master.name}: enter the quantity you physically counted.`,
          code: 'ACTUAL_QTY_REQUIRED',
        });
      }

      const rate = money(Number(line.rate) || 0);
      if (rate < 0) {
        await conn.rollback();
        return res.status(400).json({ error: `${master.name}: rate must be zero or more` });
      }

      // Derived from the pair, never accepted from the request: a shortage the
      // receiver could label "ok" is a shortage nobody ever chases.
      let condition = 'ok';
      if (actualQty < billQty) condition = 'short';
      else if (actualQty > billQty) condition = 'excess';
      if (line.goods_condition === 'damaged') condition = 'damaged';
      if (condition !== 'ok') {
        discrepancies.push(`${master.name}: billed ${billQty}, counted ${actualQty} (${condition})`);
      }

      // Stock moves on what was counted, not on what was billed. The invoice
      // may say forty; if thirty-eight arrived, thirty-eight is what we have.
      const net = money(actualQty * rate);
      const gstPercent = Number(master.gst_percent) || 0;
      const gst = money(net * (gstPercent / 100));

      subTotal = money(subTotal + net);
      gstTotal = money(gstTotal + gst);

      const lastRate = lastRateById.has(master.masterid) ? lastRateById.get(master.masterid) : null;
      const rateChanged = lastRate !== null && Math.abs(rate - lastRate) > 0.005;

      // 5.1 — "Beyond the set %: reason mandatory from a fixed list." Only
      // gated when a real threshold is configured; 0/unset never blocks.
      if (rateChanged && RATE_CHANGE_REASON_THRESHOLD > 0) {
        const changePct = Math.abs(((rate - lastRate) / lastRate) * 100);
        if (changePct > RATE_CHANGE_REASON_THRESHOLD
            && !RATE_CHANGE_REASONS.includes(line.rate_change_reason)) {
          await conn.rollback();
          return res.status(400).json({
            error: `${master.name}: rate moved ${changePct.toFixed(1)}% — above the `
              + `${RATE_CHANGE_REASON_THRESHOLD}% threshold. Choose a reason.`,
            code: 'RATE_CHANGE_REASON_REQUIRED',
            allowed: RATE_CHANGE_REASONS,
          });
        }
      }

      prepared.push({
        item_id: master.masterid,
        item_name: master.name,
        bill_qty: billQty,
        qty: actualQty,
        rate,
        last_rate: lastRate,
        rate_changed: rateChanged,
        rate_change_reason: rateChanged ? (line.rate_change_reason || null) : null,
        goods_condition: condition,
        condition_note: line.condition_note || null,
        gst_percent: gstPercent,
        total: net,
      });
    }

    // Who may sign the goods off. `purchases.verify` is Sonu's grant; whoever
    // else receives in his absence submits under their own name and the entry
    // waits for him.
    const canVerify = userCan(req.user, 'purchases') || userCan(req.user, 'purchases.verify');
    const status = canVerify ? 'verified' : 'awaiting_verification';

    // The GST countdown. For a local challan it runs from submission; for an
    // outside one, from physical receipt — which is this moment either way,
    // because the entry is made when the goods are in the godown.
    const registered = type.registered === null
      ? Boolean(String(invoice_no || '').trim())
      : type.registered;
    const docState = registered ? 'registered' : 'unregistered';
    const gstDue = registered ? null : type.gstDays;

    const [inserted] = await conn.query(
      `INSERT INTO purchases
         (purchase_type, supplier_id, supplier_name, invoice_no, challan_no, git_id,
          purchase_date, sub_total, gst_amount, grand_total, status, doc_state,
          gst_due_on, created_by, received_by, verified_by, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               ${gstDue === null ? 'NULL' : 'DATE_ADD(CURDATE(), INTERVAL ? DAY)'},
               ?, ?, ?, ?)`,
      [
        purchase_type,
        supplier_id || null,
        String(supplier_name || '').trim(),
        String(invoice_no || '').trim() || null,
        String(challan_no || '').trim() || null,
        git_id || null,
        requestedDay(purchase_date) || businessDay(),
        subTotal,
        gstTotal,
        money(subTotal + gstTotal),
        status,
        docState,
        ...(gstDue === null ? [] : [gstDue]),
        req.user.id,
        req.user.id,
        canVerify ? req.user.id : null,
        canVerify ? new Date() : null,
      ]
    );

    const purchaseId = inserted.insertId;

    for (const line of prepared) {
      const [itemResult] = await conn.query(
        `INSERT INTO purchase_items
           (purchase_id, item_id, item_name, bill_qty, qty, goods_condition,
            condition_note, rate, last_rate, rate_changed, rate_change_reason, gst_percent, total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [purchaseId, line.item_id, line.item_name, line.bill_qty, line.qty,
          line.goods_condition, line.condition_note, line.rate, line.last_rate,
          line.rate_changed, line.rate_change_reason, line.gst_percent, line.total]
      );

      // 5, "Short-supply claims" — "wherever bill qty and actual qty differ,
      // auto-create a claim against that company with value." Short and
      // damaged are money owed back; excess is not a claim against the
      // supplier (we simply received more than billed), so it is left out.
      const shortQty = money(Number(line.bill_qty) - Number(line.qty));
      if ((line.goods_condition === 'short' || line.goods_condition === 'damaged') && shortQty > 0) {
        await conn.query(
          `INSERT INTO purchase_claims
             (purchase_id, purchase_item_id, item_id, item_name, supplier_name,
              bill_qty, actual_qty, short_qty, rate, value)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [purchaseId, itemResult.insertId, line.item_id, line.item_name,
            String(supplier_name || '').trim(), line.bill_qty, line.qty, shortQty,
            line.rate, money(shortQty * line.rate)]
        );
      }
    }

    // Stock moves only once somebody with the authority has counted it. An
    // entry waiting for Sonu has not been verified by anyone, and booking it
    // in would put goods on the system that nobody has confirmed are there.
    if (status === 'verified') {
      await postStock(conn, purchaseId, prepared, req.user, invoice_no || challan_no);

      // Verified by the receiver, so section 14's "after Sonu verification"
      // condition is already met and the voucher goes now.
      const [[postedPurchase]] = await conn.query(
        'SELECT * FROM purchases WHERE id = ?', [purchaseId]);
      const [postedLines] = await conn.query(
        `SELECT pi.*, i.unit FROM purchase_items pi
           LEFT JOIN items i ON i.masterid = pi.item_id WHERE pi.purchase_id = ?`,
        [purchaseId]
      );
      await tallyEnqueue(conn, {
        kind: docState === 'unregistered' ? 'unregistered_purchase' : 'purchase_voucher',
        refType: 'purchase',
        refId: purchaseId,
        payload: purchaseXml({
          purchase: postedPurchase,
          lines: postedLines,
          company: tallyConfig().company,
          registered: docState !== 'unregistered',
        }),
        userId: req.user.id,
      });
    }

    // Attachments are linked after the row exists, so their ref_id is real.
    for (const [refType, id] of [['purchase_document', document_photo_id],
      ['purchase_goods', goods_photo_id], ['purchase_bilty', bilty_photo_id]]) {
      if (!id) continue;
      await conn.query(
        'UPDATE attachments SET ref_type = ?, ref_id = ? WHERE id = ?',
        [refType, purchaseId, Number(id)]);
    }

    // The bilty this arrived against is now received.
    if (git_id) {
      await conn.query(
        `UPDATE git_entries SET purchase_id = ?, status = ?, received_at = NOW() WHERE id = ?`,
        [purchaseId, discrepancies.length ? 'issue' : 'received', git_id]);
    }

    // 5.1 — "Sonu receives an in-app notification when he returns."
    if (status === 'awaiting_verification') {
      for (const verifier of await usersWhoCan(conn, 'purchases.verify')) {
        await notify(conn, {
          userId: verifier,
          tone: 'info',
          title: 'Goods received in your absence',
          body: `${supplier_name} — ${prepared.length} line(s) taken in by ${req.user.name}. Your verification is needed before the Tally entry.`,
          actor: req.user.id,
          refType: 'purchase',
          refId: purchaseId,
        });
      }
    }

    // 5.4 — the rate change alert. Sibu sees it on review and may hold the
    // entry; Yash is told either way.
    const moved = prepared.filter((l) => l.rate_changed);
    for (const line of moved) {
      const jump = (((line.rate - line.last_rate) / line.last_rate) * 100).toFixed(1);
      await notify(conn, {
        tone: 'warning',
        title: 'Purchase rate changed',
        body: `${line.item_name} ${jump > 0 ? 'up' : 'down'} ${Math.abs(jump)}% to ${line.rate} from ${supplier_name}.`,
        actor: req.user.name,
        refType: 'purchase',
        refId: purchaseId,
      });
    }
    if (moved.length) {
      await conn.query("UPDATE purchases SET rate_alert = 'proceeded' WHERE id = ?", [purchaseId]);
    }

    // A shortage or damage is reported to the owner immediately: it is money
    // owed back by a supplier, and it goes cold within days.
    if (discrepancies.length) {
      for (const owner of await usersWithGrant(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: `Goods received short or damaged — ${supplier_name}`,
          body: discrepancies.join('; '),
          actor: req.user.id,
          refType: 'purchase',
          refId: purchaseId,
        });
      }
    }

    await conn.commit();
    res.status(201).json({
      message: status === 'verified'
        ? 'Purchase received and stock updated.'
        : 'Received. Waiting on verification before it posts to stock.',
      purchase_id: purchaseId,
      status,
      doc_state: docState,
      grand_total: money(subTotal + gstTotal),
      rate_changes: moved.length,
      discrepancies,
      gst_countdown_days: gstDue,
    });
  } catch (err) {
    await conn.rollback();
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        error: 'That supplier document has already been entered.', code: 'DUPLICATE_DOCUMENT' });
    }
    next(err);
  } finally {
    conn.release();
  }
});

/**
 * Book the counted quantities into stock.
 *
 * Split out because it happens at two different moments: immediately when the
 * receiver could verify, and later when Sonu does. Both must move exactly the
 * same rows, and duplicating the loop is how they would come to differ.
 */
async function postStock(conn, purchaseId, lines, user, docNo) {
  for (const line of lines) {
    if (!(line.qty > 0)) continue;
    await moveStock(conn, {
      itemId: line.item_id,
      change: line.qty,
      reason: 'receipt',
      refType: 'purchase',
      refId: purchaseId,
      note: `Received on ${docNo || `purchase ${purchaseId}`}`,
      userId: user.id,
    });

    // 5.3, "Cost basis for the below-cost check (R16)" — non-negotiable:
    // "the LATEST purchase rate, not a weighted average, because the goods
    // must be replaced at today's price." Every posted receipt is by
    // definition the latest one for that item the moment it posts, so
    // keeping items.cost_price in step here — rather than leaving it a
    // number Gaurav types by hand and hoping it stays current — is what
    // makes both R-16 checks (the order-punch notification in
    // utils/pricing.js's isBelowCost, and billing's own in
    // routes/invoices.js) agree, because both read this same column.
    // Gaurav can still correct it by hand (items.pricing, R-04) for a
    // genuine exception; a posted purchase is what sets the default.
    await conn.query('UPDATE items SET cost_price = ? WHERE masterid = ?', [line.rate, line.item_id]);
  }
  await conn.query(
    "UPDATE purchases SET status = 'posted', posted_at = NOW() WHERE id = ?", [purchaseId]);
}

/**
 * POST /api/purchases/:id/verify — Sonu's physical review (5.1).
 *
 * "Sonu must physically review the received goods, confirm quantities, and
 * provide his verification before Sibu can proceed with the Tally entry."
 *
 * This is the moment the stock actually moves for an entry somebody else took
 * in. He may correct the counted quantity while doing it — that is what
 * "confirm quantities" means, and refusing the correction would leave the only
 * person who looked at the goods unable to say what he saw.
 */
router.post('/:id/verify', requirePermission('purchases.verify'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const corrections = Array.isArray(req.body?.lines) ? req.body.lines : [];
    await conn.beginTransaction();

    const [[purchase]] = await conn.query(
      'SELECT * FROM purchases WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!purchase) {
      await conn.rollback();
      return res.status(404).json({ error: 'Purchase not found' });
    }
    if (purchase.status !== 'awaiting_verification') {
      await conn.rollback();
      return res.status(409).json({
        error: `That entry is ${purchase.status}, not awaiting verification.`, code: 'STALE' });
    }
    // R-15's shape: the person who took the goods in does not also verify them.
    if (purchase.received_by === req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'The person who received the goods cannot also verify them.',
        code: 'SELF_VERIFICATION',
      });
    }

    const [lines] = await conn.query(
      'SELECT * FROM purchase_items WHERE purchase_id = ?', [purchase.id]);

    const byId = new Map(corrections
      .filter((c) => Number.isInteger(Number(c.id)))
      .map((c) => [Number(c.id), qty(Number(c.actual_qty))]));

    let subTotal = 0;
    let gstTotal = 0;
    for (const line of lines) {
      const corrected = byId.has(line.id) ? byId.get(line.id) : Number(line.qty);
      if (!Number.isFinite(corrected) || corrected < 0) continue;

      const condition = corrected < Number(line.bill_qty) ? 'short'
        : corrected > Number(line.bill_qty) ? 'excess' : 'ok';
      const net = money(corrected * Number(line.rate));
      const gst = money(net * (Number(line.gst_percent) / 100));
      subTotal = money(subTotal + net);
      gstTotal = money(gstTotal + gst);

      await conn.query(
        `UPDATE purchase_items SET qty = ?, total = ?,
                goods_condition = CASE WHEN goods_condition = 'damaged' THEN 'damaged' ELSE ? END
          WHERE id = ?`,
        [corrected, net, condition, line.id]);
      line.qty = corrected;
    }

    await conn.query(
      `UPDATE purchases
          SET verified_by = ?, verified_at = NOW(), sub_total = ?, gst_amount = ?, grand_total = ?
        WHERE id = ?`,
      [req.user.id, subTotal, gstTotal, money(subTotal + gstTotal), purchase.id]);

    await postStock(conn, purchase.id, lines, req.user,
      purchase.invoice_no || purchase.challan_no);

    // Section 14 is explicit about the timing: "Purchase Vouchers (after Sonu
    // verification)". Not on receipt — an entry nobody has verified must not
    // reach the books.
    const [freshLines] = await conn.query(
      `SELECT pi.*, i.unit FROM purchase_items pi
         LEFT JOIN items i ON i.masterid = pi.item_id WHERE pi.purchase_id = ?`,
      [purchase.id]
    );
    const [[freshPurchase]] = await conn.query(
      'SELECT * FROM purchases WHERE id = ?', [purchase.id]);
    await tallyEnqueue(conn, {
      // "Unregistered Purchases (challan type) and conversion on GST bill
      // receipt" is a separate row in section 14's table, so it is a separate
      // kind here — the two produce different vouchers in Tally.
      kind: freshPurchase.doc_state === 'unregistered'
        ? 'unregistered_purchase' : 'purchase_voucher',
      refType: 'purchase',
      refId: purchase.id,
      payload: purchaseXml({
        purchase: freshPurchase,
        lines: freshLines,
        company: tallyConfig().company,
        registered: freshPurchase.doc_state !== 'unregistered',
      }),
      userId: req.user.id,
    });

    for (const accountant of await usersWithGrant(conn, 'purchases')) {
      await notify(conn, {
        userId: accountant,
        tone: 'success',
        title: 'Purchase verified',
        body: `${purchase.supplier_name} — verified by ${req.user.name}. The Tally entry can proceed.`,
        actor: req.user.id,
        refType: 'purchase',
        refId: purchase.id,
      });
    }

    await conn.commit();
    res.json({ message: 'Verified and posted to stock.', grand_total: money(subTotal + gstTotal) });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

/**
 * POST /api/purchases/:id/hold — 5.4.
 * "Sibu can choose to hold the entry pending Yash's review, or to proceed."
 */
router.post('/:id/hold', requirePermission('purchases.edit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT * FROM purchases WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!p) { await conn.rollback(); return res.status(404).json({ error: 'Purchase not found' }); }

    await conn.query(
      "UPDATE purchases SET status = 'held', rate_alert = 'held', rate_alert_note = ? WHERE id = ?",
      [req.body.note || null, p.id]);

    for (const owner of await usersWithGrant(conn, 'all')) {
      await notify(conn, {
        userId: owner,
        tone: 'warning',
        title: 'Purchase held for your review',
        body: `${p.supplier_name} — ${req.body.note || 'rate change'}. Held by ${req.user.name}.`,
        actor: req.user.id,
        refType: 'purchase',
        refId: p.id,
      });
    }

    await conn.commit();
    res.json({ message: 'Held for review.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------------------
// 5, "Short-supply claims" — raised automatically on entry (see the
// purchase_claims insert above), tracked here to accepted/credited/rejected.
// ---------------------------------------------------------------------------

// GET /api/purchases/claims?status=raised
router.get('/claims', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const status = ['raised', 'accepted', 'credited', 'rejected'].includes(req.query.status)
      ? req.query.status : 'raised';
    const [rows] = await pool.query(
      `SELECT c.*, DATEDIFF(CURDATE(), DATE(c.created_at)) AS age_days, u.name AS decided_by_name
         FROM purchase_claims c
         LEFT JOIN users u ON u.id = c.decided_by
        WHERE c.status = ?
        ORDER BY c.value DESC
        LIMIT 200`,
      [status]
    );
    res.json({ status, claims: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/purchases/claims/:id/decide
router.post('/claims/:id/decide', requirePermission('purchases.edit'), async (req, res, next) => {
  const status = req.body?.status;
  if (!['accepted', 'credited', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'status must be accepted, credited or rejected' });
  }
  try {
    const [result] = await pool.query(
      `UPDATE purchase_claims SET status = ?, note = ?, decided_by = ?, decided_at = NOW()
        WHERE id = ? AND status <> 'credited'`,
      [status, req.body?.note || null, req.user.id, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'No open claim with that id.' });
    }
    res.json({ message: 'Claim updated', id: Number(req.params.id), status });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/purchases/price-report — 5.2, "every Monday, to the owner."
 *
 * Sorted by rupee IMPACT, largest first, never alphabetically — "a 3% move
 * on Polycab wire is real money; a 15% move on a slow item is noise." qty
 * bought is at the NEW rate specifically (this window's purchases), and
 * "selling rate revised Y/N" asks whether an owner-approved R-11 change to
 * this item's base_price happened after the purchase — the report's whole
 * point is catching the ones where it did not.
 */
router.get('/price-report', requirePermission('purchases.view'), async (req, res, next) => {
  try {
    const params = [];
    let dateSql = 'p.purchase_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) AND p.purchase_date <= CURDATE()';
    if (req.query.from && req.query.to) {
      dateSql = 'p.purchase_date >= ? AND p.purchase_date <= ?';
      params.push(req.query.from, req.query.to);
    }

    const [rows] = await pool.query(
      `SELECT pi.item_id, pi.item_name, p.supplier_name,
              pi.last_rate AS old_rate, pi.rate AS new_rate,
              ROUND(((pi.rate - pi.last_rate) / NULLIF(pi.last_rate, 0)) * 100, 1) AS change_percent,
              SUM(pi.qty) AS qty_bought,
              ((pi.rate - pi.last_rate) * SUM(pi.qty)) AS rupee_impact,
              MAX(p.purchase_date) AS purchase_date,
              i.qty AS stock_on_hand, i.cost_price
         FROM purchase_items pi
         JOIN purchases p ON p.id = pi.purchase_id AND p.status = 'posted'
         JOIN items i ON i.masterid = pi.item_id
        WHERE ${dateSql} AND pi.rate_changed = TRUE
        GROUP BY pi.item_id, pi.item_name, p.supplier_name, pi.last_rate, pi.rate, i.qty, i.cost_price
        ORDER BY ABS(rupee_impact) DESC
        LIMIT 200`,
      params
    );

    const itemIds = rows.map((r) => r.item_id);
    const revisedByItem = new Map();
    if (itemIds.length) {
      const [revised] = await pool.query(
        `SELECT item_id, MAX(decided_at) AS revised_at FROM item_rate_changes
          WHERE item_id IN (?) AND field = 'base_price' AND status = 'approved'
          GROUP BY item_id`,
        [itemIds]
      );
      for (const r of revised) revisedByItem.set(r.item_id, r.revised_at);
    }

    res.json({
      from: req.query.from || null,
      to: req.query.to || null,
      rows: rows.map((r) => ({
        ...r,
        old_rate: Number(r.old_rate),
        new_rate: Number(r.new_rate),
        rupee_impact: Number(r.rupee_impact),
        qty_bought: Number(r.qty_bought),
        // "Stock on hand still valued at the old cost" — cost_price now
        // tracks the LATEST posted rate automatically (5.3), so this is
        // true only for the narrow window before this purchase posted.
        stock_valued_at_old_cost: Number(r.cost_price) === Number(r.old_rate),
        selling_rate_revised: revisedByItem.has(r.item_id)
          && new Date(revisedByItem.get(r.item_id)) >= new Date(r.purchase_date),
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
