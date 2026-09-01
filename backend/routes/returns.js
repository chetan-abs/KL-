/**
 * Sales returns — goods coming back from a party.
 *
 *   GET  /api/returns              recent returns
 *   POST /api/returns              step 1 — entry, by whoever received the goods
 *   POST /api/returns/:id/approve  step 2 — Sonu's physical check (or Hirak)
 *   GET  /api/returns/damaged      the damaged-stock bucket
 *   POST /api/returns/damaged/:id/dispose   claim / repair / scrap / sell as second
 *
 * Step 3 — the credit note — is `POST /invoices/credit-notes/:id/issue`;
 * routes/returns.js auto-raises the note (pending) the moment step 2
 * approves, so Gaurav only ever ISSUES a figure this route already computed,
 * never types one. That is what makes "the credit note must match the
 * approved lines" true by construction rather than by a check somewhere.
 *
 * Section 6, September 2026 — CHANGED FROM v1, "NEW — two-step, with a
 * damaged-goods bucket." v1's single `/accept` moved stock AND raised the
 * credit note in one action, performed by whoever raised the return. Three
 * people now: entry (stock does not move), Sonu's physical count and
 * good/damaged split (this is the step that moves stock — good back to
 * sellable, damaged into its own bucket), then Gaurav's credit note. The
 * entry's own creator may never approve their own return — see
 * `requireDifferentApprover` below.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const {
  money, qty, moveStock, nextDocNumber, notify, usersWhoCan,
} = require('../utils/workflow');
const { businessDay } = require('../utils/businessDay');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/returns?status=pending
router.get('/', requirePermission('returns.view'), async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT r.*, c.name AS party, i.invoice_no, u.name AS entered_by_name
        FROM sales_returns r
        JOIN customers c ON c.masterid = r.customer_id
        LEFT JOIN invoices i ON i.id = r.invoice_id
        LEFT JOIN users u ON u.id = r.created_by
       WHERE 1=1
    `;
    if (['pending', 'approved', 'credited', 'accepted', 'rejected'].includes(req.query.status)) {
      sql += ' AND r.status = ?';
      params.push(req.query.status);
    }
    sql += ' ORDER BY r.id DESC LIMIT 100';
    const [rows] = await pool.query(sql, params);
    res.json({ returns: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * The reasons a return may be raised for, per line (5.5, and section 6's own
 * fixed list). Not free text: "Wrong item supplied" and "Quality complaint"
 * are different conversations with a supplier, and a text box collapses them
 * into one nobody can report on. constants/options.js RETURN_REASONS is the
 * client's copy of this exact list.
 */
const RETURN_REASONS = [
  'damaged_in_transit', 'damaged_defective', 'wrong_item', 'wrong_size_rating',
  'excess_supplied', 'short_supply_adjustment', 'customer_cancelled', 'quality_complaint',
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

    // What actually went out on the invoice, so a return cannot exceed it —
    // and what it was billed at, so entry cannot type a rate. An over-return
    // would credit the party twice and invent stock that never existed; a
    // typed rate would let a credit note be worth whatever the entry claims.
    const [sold] = await conn.query(
      'SELECT item_id, SUM(qty) AS sold, MAX(rate) AS rate FROM invoice_items WHERE invoice_id = ? GROUP BY item_id',
      [Number(invoice_id)]
    );
    const soldByItem = new Map(sold.map((row) => [row.item_id, row]));

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

      const sale = soldByItem.get(itemId);
      const soldQty = sale ? Number(sale.sold) : 0;
      if (returning > soldQty) {
        await conn.rollback();
        return res.status(400).json({
          error: `Cannot return ${returning} of item ${itemId} — only ${soldQty} was sold.`,
          code: 'OVER_RETURN',
        });
      }
      if (!line.reason || !RETURN_REASONS.includes(line.reason)) {
        await conn.rollback();
        return res.status(400).json({
          error: 'Every line needs a reason from the fixed list.', code: 'REASON_REQUIRED',
          allowed: RETURN_REASONS,
        });
      }

      const rate = money(Number(sale?.rate) || 0);
      const amount = money(returning * rate);
      total = money(total + amount);

      const [[master]] = await conn.query('SELECT name FROM items WHERE masterid = ?', [itemId]);
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Item ${itemId} does not exist` });
      }

      // Good/damaged is a physical judgement — Sonu's, at approval, not the
      // entry's guess — so penalty and credit are computed there too. Entry
      // records only what was told: the quantity and why.
      prepared.push({
        item_id: itemId,
        item_name: master.name,
        sold_qty: soldQty,
        return_qty: returning,
        rate,
        amount,
        reason: line.reason,
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

    // Step 1 ends here — status stays 'pending', stock does not move, and
    // penalty/credit are both 0 until Sonu's physical check decides the
    // good/damaged split. cn_due_at is not set yet either: the 2-hour clock
    // on Gaurav's credit note starts at APPROVAL (routes/returns.js's
    // /approve), because that is the first moment he has anything to act on.
    const [inserted] = await conn.query(
      `INSERT INTO sales_returns
         (customer_id, invoice_id, return_date, total_amount, reason, photo_id, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [Number(customer_id), Number(invoice_id), businessDay(), total, reason,
        Number(photo_id), note || null, req.user.id]
    );

    await conn.query(
      "UPDATE attachments SET ref_type = 'sales_return', ref_id = ? WHERE id = ?",
      [inserted.insertId, Number(photo_id)]);

    for (const line of prepared) {
      await conn.query(
        `INSERT INTO sales_return_items
           (return_id, item_id, item_name, sold_qty, return_qty, rate, amount, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [inserted.insertId, line.item_id, line.item_name, line.sold_qty,
          line.return_qty, line.rate, line.amount, line.reason]
      );
    }

    // Step 2 is Sonu's (or Hirak's) to do, not Gaurav's — he is told there is
    // a return to receive.
    const [[party]] = await conn.query(
      'SELECT name FROM customers WHERE masterid = ?', [Number(customer_id)]);
    for (const verifier of await usersWhoCan(conn, 'verification')) {
      await notify(conn, {
        userId: verifier,
        tone: 'info',
        title: 'Return awaiting your check',
        body: `${party?.name || 'Party'} — ${prepared.length} line(s), entered by ${req.user.name}.`,
        actor: req.user.id,
        refType: 'sales_return',
        refId: inserted.insertId,
      });
    }

    await conn.commit();
    res.status(201).json({
      message: 'Return entered — awaiting Sonu\'s physical check.',
      return_id: inserted.insertId,
      total_amount: total,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/returns/:id/approve — step 2, Sonu's (or Hirak's) physical check.
// `verification` is the same grant their goods-verification duty already
// uses — this is the same physical-check duty, not a second one.
router.post('/:id/approve', requirePermission('verification'), async (req, res, next) => {
  const returnId = Number(req.params.id);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
  if (!lines?.length) return res.status(400).json({ error: 'Send the checked lines' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[header]] = await conn.query(
      'SELECT * FROM sales_returns WHERE id = ? FOR UPDATE', [returnId]);
    if (!header) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such return' });
    }
    if (header.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `That return is already ${header.status}` });
    }
    // "The entry user can never approve." A receiver waving through their
    // own return is exactly the gap a second physical check exists to close.
    if (header.created_by === req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'You entered this return — Sonu or Hirak must check it, not you.',
        code: 'SELF_APPROVAL_BLOCKED',
      });
    }

    const [own] = await conn.query(
      'SELECT * FROM sales_return_items WHERE return_id = ?', [returnId]);
    const byId = new Map(own.map((row) => [row.id, row]));

    if (lines.length !== own.length) {
      await conn.rollback();
      return res.status(400).json({
        error: `This return has ${own.length} line(s); ${lines.length} were checked. Check every line.`,
        code: 'INCOMPLETE',
      });
    }

    const [items] = await conn.query(
      'SELECT masterid, return_penalty_percent, cost_price FROM items WHERE masterid IN (?)',
      [own.map((r) => r.item_id)]
    );
    const itemById = new Map(items.map((r) => [r.masterid, r]));

    let penaltyTotal = 0;
    let creditTotal = 0;
    const mismatches = [];

    for (const line of lines) {
      const row = byId.get(Number(line.return_item_id));
      if (!row) {
        await conn.rollback();
        return res.status(400).json({ error: `Line ${line.return_item_id} is not on this return` });
      }

      const goodQty = qty(Number(line.good_qty) || 0);
      const damagedQty = qty(Number(line.damaged_qty) || 0);
      const approvedQty = qty(goodQty + damagedQty);

      if (!Number.isFinite(goodQty) || !Number.isFinite(damagedQty) || goodQty < 0 || damagedQty < 0) {
        await conn.rollback();
        return res.status(400).json({ error: `${row.item_name}: good/damaged quantities are required` });
      }
      if (damagedQty > 0 && !line.damaged_photo_id) {
        await conn.rollback();
        return res.status(400).json({
          error: `${row.item_name}: a photo of the damaged goods is required.`,
          code: 'DAMAGED_PHOTO_REQUIRED',
        });
      }
      if (approvedQty > Number(row.return_qty)) {
        await conn.rollback();
        return res.status(400).json({
          error: `${row.item_name}: checked ${approvedQty} but only ${row.return_qty} was entered.`,
          code: 'OVER_APPROVAL',
        });
      }
      if (approvedQty !== Number(row.return_qty)) {
        mismatches.push(`${row.item_name}: entered ${row.return_qty}, checked ${approvedQty}`);
      }

      // Lemac trade policy: "20% penalty on any product returned; 80% credit
      // if saleable." The good portion is the saleable case (full credit);
      // the damaged portion carries the penalty, when the item has one set.
      const master = itemById.get(row.item_id);
      const penaltyPct = master?.return_penalty_percent !== null && master?.return_penalty_percent !== undefined
        ? Number(master.return_penalty_percent) : 0;
      const goodAmount = money(goodQty * Number(row.rate));
      const damagedAmount = money(damagedQty * Number(row.rate));
      const penalty = money(damagedAmount * penaltyPct);
      const credit = money(goodAmount + (damagedAmount - penalty));
      penaltyTotal = money(penaltyTotal + penalty);
      creditTotal = money(creditTotal + credit);

      await conn.query(
        `UPDATE sales_return_items
            SET approved_qty = ?, good_qty = ?, damaged_qty = ?, damaged_photo_id = ?,
                penalty_percent = ?, penalty_amount = ?, credit_amount = ?
          WHERE id = ?`,
        [approvedQty, goodQty, damagedQty, damagedQty > 0 ? Number(line.damaged_photo_id) : null,
          penaltyPct || null, penalty, credit, row.id]
      );

      if (goodQty > 0) {
        await moveStock(conn, {
          itemId: row.item_id,
          change: goodQty, // positive: sellable stock comes back in
          reason: 'return',
          refType: 'return',
          refId: returnId,
          note: `Sales return ${returnId} — good`,
          userId: req.user.id,
        });
      }
      if (damagedQty > 0) {
        // Its own bucket, not items.qty — damaged goods are not sellable
        // stock with an asterisk. unit_cost is frozen at write-off time.
        await conn.query(
          `INSERT INTO damaged_stock
             (item_id, item_name, return_id, return_item_id, qty, unit_cost, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [row.item_id, row.item_name, returnId, row.id, damagedQty,
            master?.cost_price ?? null, req.user.id]
        );
      }
    }

    // R-10, restarted: the credit note clock begins now, the first moment
    // Gaurav has an approved figure to act on — not at entry, when there was
    // nothing yet for him to do.
    await conn.query(
      `UPDATE sales_returns
          SET status = 'approved', approved_by = ?, approved_at = NOW(),
              penalty_total = ?, credit_total = ?, cn_due_at = DATE_ADD(NOW(), INTERVAL ? HOUR)
        WHERE id = ?`,
      [req.user.id, penaltyTotal, creditTotal, CREDIT_NOTE_SLA_HOURS, returnId]
    );

    // The credit is raised pending, not issued — taking goods back and
    // agreeing what they are worth are two decisions, and this is only the
    // second of three (entry was the first).
    const noteNo = await nextDocNumber(conn, {
      table: 'credit_notes', column: 'note_no', prefix: 'CN-', width: 3,
    });
    const [note] = await conn.query(
      `INSERT INTO credit_notes (note_no, customer_id, invoice_id, return_id, amount, reason, note_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [noteNo, header.customer_id, header.invoice_id, returnId, creditTotal,
        `Sales return ${returnId}`, businessDay()]
    );

    const [[party]] = await conn.query(
      'SELECT name FROM customers WHERE masterid = ?', [header.customer_id]);
    for (const biller of await usersWhoCan(conn, 'billing.create')) {
      await notify(conn, {
        userId: biller,
        tone: 'warning',
        title: `Credit note due in ${CREDIT_NOTE_SLA_HOURS} hours`,
        body: `${party?.name || 'Party'} — ${rupeesLabel(creditTotal)} checked and approved by ${req.user.name}.`,
        actor: req.user.id,
        refType: 'sales_return',
        refId: returnId,
      });
    }

    // "Differences flagged in the EOD report with both users named." Told
    // now too, not only buried in a report nobody opens same-day.
    if (mismatches.length) {
      for (const owner of await usersWhoCan(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: `Return count differs — #${returnId}`,
          body: `${req.user.name} vs entry by ${header.created_by}: ${mismatches.join('; ')}.`,
          actor: req.user.id,
          refType: 'sales_return',
          refId: returnId,
        });
      }
    }

    await conn.commit();
    res.json({
      message: 'Return checked and approved.',
      return_id: returnId,
      credit_note_id: note.insertId,
      note_no: noteNo,
      penalty_total: penaltyTotal,
      credit_total: creditTotal,
      mismatches: mismatches.length ? mismatches : null,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

/** Plain rupee string for a notification body — no Intl dependency here. */
function rupeesLabel(n) {
  return `Rs ${Number(n).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// 6.1 Damaged stock — its own bucket, excluded from sellable stock and from
// the minimum-stock alert.
// ---------------------------------------------------------------------------

// GET /api/returns/damaged
router.get('/damaged', requirePermission('returns.view'), async (req, res, next) => {
  try {
    const disposed = req.query.disposed === 'true';
    const [rows] = await pool.query(
      `SELECT d.*, DATEDIFF(CURDATE(), DATE(d.created_at)) AS age_days,
              (d.qty * COALESCE(d.unit_cost, 0)) AS value,
              u.name AS disposed_by_name
         FROM damaged_stock d
         LEFT JOIN users u ON u.id = d.disposed_by
        WHERE ${disposed ? "d.disposition <> 'undecided'" : "d.disposition = 'undecided'"}
        ORDER BY value DESC
        LIMIT 200`
    );
    res.json({ disposed, items: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/returns/damaged/:id/dispose
router.post('/damaged/:id/dispose', requirePermission('returns.accept'), async (req, res, next) => {
  const disposition = req.body?.disposition;
  if (!['claim', 'repair', 'scrap', 'second'].includes(disposition)) {
    return res.status(400).json({ error: 'disposition must be claim, repair, scrap or second' });
  }
  try {
    const [result] = await pool.query(
      `UPDATE damaged_stock
          SET disposition = ?, disposition_note = ?, disposed_by = ?, disposed_at = NOW()
        WHERE id = ? AND disposition = 'undecided'`,
      [disposition, req.body?.note || null, req.user.id, req.params.id]
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: 'No undecided damaged-stock line with that id.' });
    }
    res.json({ message: 'Disposition recorded', id: Number(req.params.id) });
  } catch (err) {
    next(err);
  }
});

// GET /api/returns/:id — one return with its lines, for the approval screen.
// Registered last: a bare `/:id` would otherwise swallow `/damaged` above it.
router.get('/:id', requirePermission('returns.view'), async (req, res, next) => {
  try {
    const [[header]] = await pool.query(
      `SELECT r.*, c.name AS party, i.invoice_no, u.name AS entered_by_name
         FROM sales_returns r
         JOIN customers c ON c.masterid = r.customer_id
         LEFT JOIN invoices i ON i.id = r.invoice_id
         LEFT JOIN users u ON u.id = r.created_by
        WHERE r.id = ?`,
      [req.params.id]
    );
    if (!header) return res.status(404).json({ error: 'No such return' });
    const [lines] = await pool.query(
      'SELECT * FROM sales_return_items WHERE return_id = ? ORDER BY id', [req.params.id]);
    res.json({ return: header, lines });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
