/**
 * Sales returns — goods coming back from a party.
 *
 *   GET  /api/returns          recent returns
 *   POST /api/returns          raise one
 *   POST /api/returns/:id/accept   take the stock back and credit the party
 *
 * Accepting writes `return` movements and recomputes the cached quantity in the
 * same transaction. The original sale's movements are left exactly as they are:
 * the ledger is append-only, so a return is new rows, never an edit.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const {
  money, qty, moveStock, nextDocNumber, notify, usersWithGrant, usersWhoCan,
} = require('../utils/workflow');
const { businessDay } = require('../utils/businessDay');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/returns
router.get('/', requirePermission('returns.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.*, c.name AS party, i.invoice_no
         FROM sales_returns r
         JOIN customers c ON c.masterid = r.customer_id
         LEFT JOIN invoices i ON i.id = r.invoice_id
        ORDER BY r.id DESC
        LIMIT 50`
    );
    res.json({ returns: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * The reasons a return may be raised for (5.5). A fixed list, not free text:
 * "Wrong item delivered" and "Quality issue" are different conversations with
 * a supplier, and a text box collapses them into one nobody can report on.
 */
const RETURN_REASONS = [
  'wrong_item', 'damaged_in_transit', 'quality_issue', 'rate_difference',
  'excess_quantity', 'changed_mind', 'not_needed', 'other',
];

/** R-10 — Gaurav has two hours to issue the credit note. */
const CREDIT_NOTE_SLA_HOURS = 2;

// POST /api/returns
router.post('/', requirePermission('returns.create'), async (req, res, next) => {
  const { customer_id, invoice_id, lines, note, reason, photo_id } = req.body || {};

  if (!Number.isInteger(Number(customer_id))) {
    return res.status(400).json({ error: 'customer_id is required' });
  }
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'Send at least one line' });
  }

  // R-09 — "A return can only be initiated against an existing invoice. The
  // original invoice number is a mandatory field. Returns cannot be processed
  // without it."
  //
  // Enforced here rather than only in the UI: without the invoice there is
  // nothing to check the returned quantity against, and a return can then
  // credit a party for goods they were never sold.
  if (!Number.isInteger(Number(invoice_id))) {
    return res.status(400).json({
      error: 'A return needs the original invoice. Find it before raising one.',
      code: 'INVOICE_REQUIRED',
    });
  }

  // "Return reason is mandatory."
  if (!reason || !RETURN_REASONS.includes(reason)) {
    return res.status(400).json({
      error: 'Choose why the goods are coming back.',
      code: 'REASON_REQUIRED',
      allowed: RETURN_REASONS,
    });
  }

  // "A photo of the returned goods is mandatory." (R-06)
  if (!photo_id) {
    return res.status(400).json({
      error: 'Photograph the returned goods before submitting.',
      code: 'PHOTO_REQUIRED',
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // What actually went out on the invoice, so a return cannot exceed it. An
    // over-return would credit the party twice and invent stock that never
    // existed.
    let soldByItem = new Map();
    if (invoice_id) {
      const [sold] = await conn.query(
        'SELECT item_id, SUM(qty) AS sold FROM invoice_items WHERE invoice_id = ? GROUP BY item_id',
        [Number(invoice_id)]
      );
      soldByItem = new Map(sold.map((row) => [row.item_id, Number(row.sold)]));
    }

    let total = 0;
    const prepared = [];

    for (const line of lines) {
      const itemId = Number(line.item_id);
      if (!Number.isInteger(itemId)) {
        await conn.rollback();
        return res.status(400).json({ error: 'Every line needs a valid item_id' });
      }

      const returning = qty(Number(line.return_qty));
      if (!Number.isFinite(returning) || returning <= 0) continue;

      const soldQty = soldByItem.has(itemId) ? soldByItem.get(itemId) : Number(line.sold_qty) || 0;
      if (invoice_id && returning > soldQty) {
        await conn.rollback();
        return res.status(400).json({
          error: `Cannot return ${returning} of item ${itemId} — only ${soldQty} was sold.`,
          code: 'OVER_RETURN',
        });
      }

      const rate = money(Number(line.rate) || 0);
      const amount = money(returning * rate);
      total = money(total + amount);

      const [[master]] = await conn.query(
        'SELECT name, return_penalty_percent FROM items WHERE masterid = ?', [itemId]);
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Item ${itemId} does not exist` });
      }

      // The Lemac trade policy: "20% penalty on any product returned; 80%
      // credit note if saleable." Held per item and NULL by default, so every
      // return credits in full exactly as before until somebody sets a rate.
      // See migrations/014 for why it is not applied to the Lemac range on
      // import.
      //
      // Saleability is the condition the sheet names, and it is the receiver's
      // judgement, so it comes from the request rather than being assumed.
      // Goods that cannot be resold carry the penalty; goods that can are the
      // "80% if saleable" case — which is the same arithmetic, because the
      // penalty is what makes it 80%.
      const saleable = line.is_saleable !== false;
      const penaltyPct = saleable && master.return_penalty_percent !== null
        ? Number(master.return_penalty_percent) : 0;
      const penalty = money(amount * penaltyPct);
      const credit = money(amount - penalty);

      prepared.push({
        item_id: itemId,
        item_name: master.name,
        sold_qty: soldQty,
        return_qty: returning,
        rate,
        amount,
        is_saleable: saleable,
        penalty_percent: penaltyPct || null,
        penalty_amount: penalty,
        credit_amount: credit,
        reason: line.reason || null,
      });
    }

    if (!prepared.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'Nothing is being returned' });
    }

    const [[photo]] = await conn.query(
      'SELECT id FROM attachments WHERE id = ?', [Number(photo_id)]);
    if (!photo) {
      await conn.rollback();
      return res.status(400).json({
        error: 'That photograph was not found.', code: 'PHOTO_NOT_FOUND' });
    }

    // R-10 — the clock starts here. Stored as a deadline on the row rather
    // than scheduled as a job: the alert sweep asks which returns are past due
    // with no issued credit note, which survives a restart in a way a timer
    // does not.
    const [inserted] = await conn.query(
      `INSERT INTO sales_returns
         (customer_id, invoice_id, return_date, total_amount, reason, photo_id,
          cn_due_at, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR), ?, ?)`,
      [Number(customer_id), Number(invoice_id), businessDay(), total, reason,
        Number(photo_id), CREDIT_NOTE_SLA_HOURS, note || null, req.user.id]
    );

    await conn.query(
      "UPDATE attachments SET ref_type = 'sales_return', ref_id = ? WHERE id = ?",
      [inserted.insertId, Number(photo_id)]);

    let penaltyTotal = 0;
    let creditTotal = 0;
    for (const line of prepared) {
      await conn.query(
        `INSERT INTO sales_return_items
           (return_id, item_id, item_name, sold_qty, return_qty, rate, amount,
            reason, is_saleable, penalty_percent, penalty_amount, credit_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [inserted.insertId, line.item_id, line.item_name, line.sold_qty,
          line.return_qty, line.rate, line.amount, line.reason,
          line.is_saleable, line.penalty_percent, line.penalty_amount, line.credit_amount]
      );
      penaltyTotal = money(penaltyTotal + line.penalty_amount);
      creditTotal = money(creditTotal + line.credit_amount);
    }

    // The value of the goods and the money the party gets are two figures, and
    // the credit note is raised against the second.
    await conn.query(
      'UPDATE sales_returns SET penalty_total = ?, credit_total = ? WHERE id = ?',
      [penaltyTotal, creditTotal, inserted.insertId]);

    // "On submission, Gaurav receives a notification. He has 2 hours to issue
    // the credit note." Told immediately, with the deadline in the message —
    // an SLA nobody is told the start of is one nobody can meet.
    const [[party]] = await conn.query(
      'SELECT name FROM customers WHERE masterid = ?', [Number(customer_id)]);
    for (const biller of await usersWhoCan(conn, 'billing.create')) {
      await notify(conn, {
        userId: biller,
        tone: 'warning',
        title: `Credit note due in ${CREDIT_NOTE_SLA_HOURS} hours`,
        body: `${party?.name || 'Party'} returned ${total.toFixed(2)} — ${reason.replace(/_/g, ' ')}.`,
        actor: req.user.id,
        refType: 'sales_return',
        refId: inserted.insertId,
      });
    }

    await conn.commit();
    res.status(201).json({
      message: 'Return raised',
      return_id: inserted.insertId,
      total_amount: total,
      // Equal to total_amount unless a return penalty is configured on one of
      // the items, which no item carries by default.
      penalty_total: penaltyTotal,
      credit_total: creditTotal,
      credit_note_due_in_hours: CREDIT_NOTE_SLA_HOURS,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/returns/:id/accept — stock back in, credit note out
router.post('/:id/accept', requirePermission('returns.accept'), async (req, res, next) => {
  const returnId = Number(req.params.id);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[header]] = await conn.query(
      'SELECT * FROM sales_returns WHERE id = ? FOR UPDATE',
      [returnId]
    );
    if (!header) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such return' });
    }
    if (header.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `That return is already ${header.status}` });
    }

    const [lines] = await conn.query(
      'SELECT item_id, item_name, return_qty FROM sales_return_items WHERE return_id = ?',
      [returnId]
    );

    for (const line of lines) {
      await moveStock(conn, {
        itemId: line.item_id,
        change: Number(line.return_qty), // positive: goods come back in
        reason: 'return',
        refType: 'return',
        refId: returnId,
        note: `Sales return ${returnId}`,
        userId: req.user.id,
      });
    }

    await conn.query("UPDATE sales_returns SET status = 'accepted' WHERE id = ?", [returnId]);

    // The credit is raised pending, not issued: taking goods back and agreeing
    // what they are worth are two decisions, and only the first one happened
    // here.
    const noteNo = await nextDocNumber(conn, {
      table: 'credit_notes',
      column: 'note_no',
      prefix: 'CN-',
      width: 3,
    });

    const [note] = await conn.query(
      `INSERT INTO credit_notes (note_no, customer_id, invoice_id, return_id, amount, reason, note_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        noteNo,
        header.customer_id,
        header.invoice_id,
        returnId,
        header.total_amount,
        `Sales return ${returnId}`,
        businessDay(),
      ]
    );

    await conn.commit();
    res.json({
      message: 'Return accepted',
      credit_note_id: note.insertId,
      note_no: noteNo,
      amount: header.total_amount,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
