/**
 * Field sales — estimates, beat plans and the salesman's own day.
 *
 *   GET  /api/field/estimates          quotes
 *   POST /api/field/estimates          raise one
 *   POST /api/field/estimates/:id/convert   turn it into a real order
 *   GET  /api/field/beat               the caller's plan for a day
 *   POST /api/field/beat               file one
 *   POST /api/field/beat/stops/:id/visit    mark a call, with a GPS fix
 *   GET  /api/field/day                today's figures for the dashboard
 *
 * The service day everywhere here is `businessDay()`, never a UTC date. An
 * 05:15 IST visit belongs to today; toISOString().slice(0,10) would file it
 * under yesterday and collide with the row already there.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { userCan } = require('../utils/permissions');
const { money, qty } = require('../utils/workflow');
const { businessDay, requestedDay } = require('../utils/businessDay');

router.use(authenticate);

/**
 * Section 7's numbers, in one place.
 *
 * "Validity is automatically set to 15 days from the creation date."
 * "A follow-up date is set at the time of creation (default: 3 days)."
 * "Maximum 3 follow-up attempts."
 */
const ESTIMATE_VALID_DAYS = 15;
const FIRST_FOLLOW_UP_DAYS = 3;
const MAX_FOLLOW_UPS = 3;

/** The closure reasons the conversion report groups on. */
const LOST_REASONS = [
  'price_too_high', 'purchased_elsewhere', 'budget_constraints',
  'project_cancelled', 'not_interested', 'other',
];

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

// GET /api/field/estimates
router.get('/estimates', requirePermission('estimates.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT e.*, c.name AS party, u.name AS salesman
         FROM estimates e
         JOIN customers c ON c.masterid = e.customer_id
         LEFT JOIN users u ON u.id = e.created_by
        WHERE ? OR e.created_by = ?
        ORDER BY e.id DESC
        LIMIT 50`,
      // An area grant sees the branch's quotes; an action grant sees their own.
      // Same mechanism as orders: a one-segment check cannot be satisfied by
      // `estimates.view`.
      [userCan(req.user, 'estimates') ? 1 : 0, req.user.id]
    );
    res.json({ estimates: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/field/estimates
router.post('/estimates', requirePermission('estimates.create'), async (req, res, next) => {
  const { customer_id, valid_days, lines } = req.body || {};

  if (!Number.isInteger(Number(customer_id))) {
    return res.status(400).json({ error: 'customer_id is required' });
  }
  if (!Array.isArray(lines) || !lines.length) {
    return res.status(400).json({ error: 'A quote needs at least one line' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const ids = [...new Set(lines.map((line) => Number(line.item_id)))];
    // Read, not locked: an estimate commits no stock, so there is nothing here
    // for a concurrent order to contend with.
    const [masters] = await conn.query(
      'SELECT masterid, name, rate FROM items WHERE masterid IN (?) AND is_active = TRUE',
      [ids]
    );
    const masterById = new Map(masters.map((row) => [row.masterid, row]));

    let total = 0;
    const prepared = [];

    for (const line of lines) {
      const master = masterById.get(Number(line.item_id));
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Item ${line.item_id} is not available` });
      }

      const quantity = qty(Number(line.qty));
      if (!Number.isFinite(quantity) || quantity <= 0) {
        await conn.rollback();
        return res.status(400).json({ error: `${master.name}: quantity must be greater than zero` });
      }

      // The rate comes from the master, as it does on an order — a quote that
      // could name its own price is a discount nobody approved.
      const rate = Number(master.rate);
      const lineTotal = money(quantity * rate);
      total = money(total + lineTotal);

      prepared.push({ item_id: master.masterid, item_name: master.name, qty: quantity, rate, total: lineTotal });
    }

    // Section 7: "Validity is automatically set to 15 days from the creation
    // date" and "A follow-up date is set at the time of creation (default: 3
    // days from creation)." Both are computed here rather than left to the
    // client, because both drive alerts the server raises.
    const validFor = Math.max(1, Number(valid_days) || ESTIMATE_VALID_DAYS);
    const followUpIn = Math.max(1, Number(req.body.follow_up_days) || FIRST_FOLLOW_UP_DAYS);

    const [inserted] = await conn.query(
      `INSERT INTO estimates
         (customer_id, estimate_date, valid_days, valid_until, follow_up_on,
          total_amount, created_by)
       VALUES (?, ?, ?, DATE_ADD(?, INTERVAL ? DAY), DATE_ADD(?, INTERVAL ? DAY), ?, ?)`,
      [Number(customer_id), businessDay(), validFor,
        businessDay(), validFor, businessDay(), followUpIn, total, req.user.id]
    );

    // The first follow-up is scheduled with the quote. "The creator of the
    // estimate is responsible for follow-up" — so it is booked against them
    // now rather than relying on somebody remembering to create one.
    await conn.query(
      `INSERT INTO estimate_followups (estimate_id, seq, due_on)
       VALUES (?, 1, DATE_ADD(?, INTERVAL ? DAY))`,
      [inserted.insertId, businessDay(), followUpIn]
    );

    for (const line of prepared) {
      await conn.query(
        `INSERT INTO estimate_items (estimate_id, item_id, item_name, qty, rate, total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [inserted.insertId, line.item_id, line.item_name, line.qty, line.rate, line.total]
      );
    }

    await conn.commit();
    const [[created]] = await conn.query(
      'SELECT valid_until, follow_up_on FROM estimates WHERE id = ?', [inserted.insertId]);
    res.status(201).json({
      message: 'Estimate created',
      estimate_id: inserted.insertId,
      total_amount: total,
      valid_until: created.valid_until,
      follow_up_on: created.follow_up_on,
    });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

/**
 * POST /api/field/estimates/:id/follow-up — log an attempt (section 7).
 *
 * "After each follow-up attempt, the creator logs the outcome and sets the
 * next follow-up date. Maximum 3 follow-up attempts."
 *
 * The cap is enforced here. Past three, the quote has to be closed one way or
 * the other — converted, or marked lost with a reason — because a quote nobody
 * will close is a pipeline figure that is never true.
 */
router.post('/estimates/:id/follow-up', requirePermission('estimates.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { outcome, note, next_due_on } = req.body || {};
    await conn.beginTransaction();

    const [[estimate]] = await conn.query(
      'SELECT * FROM estimates WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!estimate) {
      await conn.rollback();
      return res.status(404).json({ error: 'Estimate not found' });
    }
    if (['converted', 'lost'].includes(estimate.status)) {
      await conn.rollback();
      return res.status(409).json({
        error: `That quote is already ${estimate.status}.`, code: 'CLOSED' });
    }
    // "The creator of the estimate is responsible for follow-up."
    if (estimate.created_by !== req.user.id && !userCan(req.user, 'estimates')) {
      await conn.rollback();
      return res.status(403).json({
        error: 'Follow-up belongs to whoever raised the quote.', code: 'NOT_YOURS' });
    }

    const attempts = Number(estimate.attempts) + 1;
    if (attempts > MAX_FOLLOW_UPS) {
      await conn.rollback();
      return res.status(409).json({
        error: `That is ${MAX_FOLLOW_UPS} attempts. Convert the quote or mark it lost.`,
        code: 'FOLLOW_UP_LIMIT',
      });
    }

    await conn.query(
      `UPDATE estimate_followups
          SET done_at = NOW(), outcome = ?, note = ?, next_due_on = ?, done_by = ?
        WHERE estimate_id = ? AND seq = ?`,
      [outcome || null, note || null, next_due_on || null, req.user.id,
        estimate.id, attempts]);

    // Book the next attempt, unless this was the last one allowed.
    const more = attempts < MAX_FOLLOW_UPS && Boolean(next_due_on);
    if (more) {
      await conn.query(
        `INSERT INTO estimate_followups (estimate_id, seq, due_on) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE due_on = VALUES(due_on)`,
        [estimate.id, attempts + 1, next_due_on]);
    }

    await conn.query(
      'UPDATE estimates SET attempts = ?, follow_up_on = ?, status = ? WHERE id = ?',
      [attempts, more ? next_due_on : null,
        estimate.status === 'draft' ? 'sent' : estimate.status, estimate.id]);

    await conn.commit();
    res.json({
      message: 'Follow-up logged.',
      attempts,
      attempts_left: MAX_FOLLOW_UPS - attempts,
      next_due_on: more ? next_due_on : null,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * POST /api/field/estimates/:id/lost — close a quote that did not convert.
 *
 * "If the estimate is not converted within 15 days, or after 3 follow-up
 * attempts, the creator must mark it as Lost and select a reason."
 *
 * The reason is a fixed list because the Estimate Conversion Report groups on
 * it — "price too high" and "purchased elsewhere" call for different
 * responses, and free text collapses them into a column nobody can read.
 */
router.post('/estimates/:id/lost', requirePermission('estimates.create'), async (req, res, next) => {
  try {
    const { reason, note } = req.body || {};
    if (!reason || !LOST_REASONS.includes(reason)) {
      return res.status(400).json({
        error: 'Choose why the quote was lost.',
        code: 'REASON_REQUIRED',
        allowed: LOST_REASONS,
      });
    }

    const [[estimate]] = await pool.query('SELECT * FROM estimates WHERE id = ?', [req.params.id]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.status === 'converted') {
      return res.status(409).json({
        error: 'That quote became an order — it is not lost.', code: 'ALREADY_CONVERTED' });
    }
    if (estimate.created_by !== req.user.id && !userCan(req.user, 'estimates')) {
      return res.status(403).json({ error: 'That quote belongs to somebody else.', code: 'NOT_YOURS' });
    }

    await pool.query(
      `UPDATE estimates
          SET status = 'lost', lost_reason = ?, closed_at = NOW(), follow_up_on = NULL
        WHERE id = ?`,
      [reason, req.params.id]);

    res.json({ message: 'Marked lost.', reason, note: note || null });
  } catch (err) { next(err); }
});

/**
 * GET /api/field/estimates/due — what the creator owes a call on.
 *
 * "On the follow-up due date, the creator receives a notification." This is
 * what that notification links to, and what the dashboard counts.
 */
router.get('/estimates/due', requirePermission('estimates.view'), async (req, res, next) => {
  try {
    const all = userCan(req.user, 'estimates');
    const params = [requestedDay(req.query.date)];
    if (!all) params.push(req.user.id);

    const [rows] = await pool.query(
      `SELECT e.*, c.name AS party, c.phone,
              DATEDIFF(CURDATE(), e.valid_until) AS days_past_validity
         FROM estimates e JOIN customers c ON c.masterid = e.customer_id
        WHERE e.status IN ('draft','sent')
          AND e.follow_up_on IS NOT NULL AND e.follow_up_on <= ?
          ${all ? '' : 'AND e.created_by = ?'}
        ORDER BY e.follow_up_on ASC LIMIT 100`, params);

    res.json({
      due: rows.map((r) => ({
        ...r,
        expired: Number(r.days_past_validity) > 0,
        attempts_left: MAX_FOLLOW_UPS - Number(r.attempts),
      })),
      lost_reasons: LOST_REASONS,
      max_follow_ups: MAX_FOLLOW_UPS,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/field/estimates/:id/share — section 7.
 *
 * "On saving the estimate, a professionally formatted PDF is generated and can
 *  be shared directly via WhatsApp to the party's registered phone number from
 *  within the application. The PDF includes item names, quantities, rates,
 *  total amount, validity date, and KL Electricals contact details."
 *
 * What this returns is the formatted quote as text plus a `wa.me` link, and it
 * records that the share happened. It does NOT generate a PDF: that needs a
 * renderer this project does not have, and the gap is recorded in
 * docs/requirements-implementation-2026-08-31.md rather than pretended away.
 *
 * The link is built and handed back rather than called: this is the one place
 * the requirements permit reaching a customer outside the app, and the sending
 * is the salesman's own action on their own phone. The server never contacts
 * WhatsApp, so nothing here can leak a party's number to a third party.
 */
router.post('/estimates/:id/share', requirePermission('estimates.create'), async (req, res, next) => {
  try {
    const [[estimate]] = await pool.query(
      `SELECT e.*, c.name AS party, c.phone, c.phone2, c.gst_number
         FROM estimates e JOIN customers c ON c.masterid = e.customer_id
        WHERE e.id = ?`, [req.params.id]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    if (estimate.created_by !== req.user.id && !userCan(req.user, 'estimates')) {
      return res.status(403).json({ error: 'That quote belongs to somebody else.', code: 'NOT_YOURS' });
    }

    // "the party's registered phone number" — the request may name the second
    // number, but not an arbitrary one: a quote carrying our rates must go to
    // the party it was raised for.
    const asked = req.body?.phone ? String(req.body.phone).trim() : null;
    const known = [estimate.phone, estimate.phone2].filter(Boolean).map(String);
    if (asked && !known.includes(asked)) {
      return res.status(400).json({
        error: 'That number is not on the party record. Add it to the party first.',
        code: 'UNKNOWN_NUMBER',
      });
    }
    const to = asked || known[0];
    if (!to) {
      return res.status(400).json({
        error: `${estimate.party} has no phone number on file.`, code: 'NO_PHONE' });
    }

    const [lines] = await pool.query(
      'SELECT item_name, qty, rate, total FROM estimate_items WHERE estimate_id = ? ORDER BY id',
      [estimate.id]);

    const rupees = (n) => Number(n).toFixed(2);
    const body = [
      'K.L. ELECTRICALS',
      'Lakhtokia, Guwahati · 9365080150',
      '',
      `Quotation for ${estimate.party}`,
      `Date ${String(estimate.estimate_date).slice(0, 10)}`,
      `Valid until ${String(estimate.valid_until || '').slice(0, 10)}`,
      '',
      ...lines.map((l, i) =>
        `${i + 1}. ${l.item_name}\n   ${Number(l.qty)} x ${rupees(l.rate)} = ${rupees(l.total)}`),
      '',
      `Total ${rupees(estimate.total_amount)}`,
      '',
      'Rates are valid until the date above and exclude GST unless stated.',
    ].join('\n');

    await pool.query(
      'UPDATE estimates SET shared_at = NOW(), shared_to = ?, shared_by = ?, status = ? WHERE id = ?',
      [to, req.user.id, estimate.status === 'draft' ? 'sent' : estimate.status, estimate.id]);

    res.json({
      message: 'Quote ready to send.',
      to,
      text: body,
      // Digits only; wa.me rejects punctuation. No country code is added — the
      // numbers on file are local and guessing +91 would misdirect any that
      // are not.
      whatsapp_url: `https://wa.me/${to.replace(/\D/g, '')}?text=${encodeURIComponent(body)}`,
      pdf: null,
      pdf_note: 'PDF generation is not implemented; this is the text form of the same quote.',
    });
  } catch (err) { next(err); }
});

// POST /api/field/estimates/:id/convert
router.post('/estimates/:id/convert', requirePermission('orders.create'), async (req, res, next) => {
  const estimateId = Number(req.params.id);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[estimate]] = await conn.query(
      'SELECT * FROM estimates WHERE id = ? FOR UPDATE',
      [estimateId]
    );
    if (!estimate) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such estimate' });
    }
    if (estimate.status === 'converted') {
      await conn.rollback();
      return res.status(409).json({
        error: 'That estimate is already an order',
        order_id: estimate.converted_order_id,
      });
    }

    const [lines] = await conn.query('SELECT * FROM estimate_items WHERE estimate_id = ?', [estimateId]);
    if (!lines.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'That estimate has no lines' });
    }

    // Rates are re-read from the master at conversion, not carried across: the
    // quote may be weeks old, and the validity window exists precisely so last
    // month's rates are not honoured at this month's cost.
    const ids = [...new Set(lines.map((line) => line.item_id))];
    const [masters] = await conn.query(
      `SELECT masterid, name, hsn, rate, gst_percent FROM items
        WHERE masterid IN (?) AND is_active = TRUE FOR UPDATE`,
      [ids]
    );
    const masterById = new Map(masters.map((row) => [row.masterid, row]));

    let grandTotal = 0;
    const prepared = [];

    for (const line of lines) {
      const master = masterById.get(line.item_id);
      if (!master) {
        await conn.rollback();
        return res.status(409).json({ error: `${line.item_name} is no longer available` });
      }

      const rate = Number(master.rate);
      const gstPercent = Number(master.gst_percent) || 0;
      const net = money(Number(line.qty) * rate);
      const gst = money(net * (gstPercent / 100));
      const lineTotal = money(net + gst);
      grandTotal = money(grandTotal + lineTotal);

      prepared.push({
        item_id: master.masterid,
        item_name: master.name,
        hsn: master.hsn || '',
        qty: Number(line.qty),
        rate,
        gst_percent: gstPercent,
        gst_amount: gst,
        total: lineTotal,
      });
    }

    // Enters the pipeline at `pending`: a converted quote still needs approval
    // like any other order.
    const [order] = await conn.query(
      `INSERT INTO orders (customer_id, order_date, total_amount, created_by, status, notes)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
      [estimate.customer_id, businessDay(), grandTotal, req.user.id, `From estimate ${estimateId}`]
    );

    const orderId = order.insertId;

    for (const line of prepared) {
      await conn.query(
        `INSERT INTO order_items
           (order_id, item_id, item_name, hsn, qty, rate, scheme, discount, gst_percent, gst_amount, total)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [orderId, line.item_id, line.item_name, line.hsn, line.qty, line.rate, line.gst_percent, line.gst_amount, line.total]
      );

      await conn.query(
        `INSERT INTO stock_movements (item_id, change_qty, reason, ref_type, ref_id, note, created_by)
         VALUES (?, ?, 'order', 'order', ?, 'Order sale', ?)`,
        [line.item_id, -line.qty, orderId, req.user.id]
      );
      await conn.query(
        `UPDATE items SET qty = (SELECT COALESCE(SUM(change_qty), 0) FROM stock_movements WHERE item_id = ?)
         WHERE masterid = ?`,
        [line.item_id, line.item_id]
      );
    }

    await conn.query(
      "UPDATE estimates SET status = 'converted', converted_order_id = ? WHERE id = ?",
      [orderId, estimateId]
    );

    await conn.query(
      `INSERT INTO order_events (order_id, from_status, to_status, note, created_by)
       VALUES (?, NULL, 'pending', ?, ?)`,
      [orderId, `Converted from estimate ${estimateId}`, req.user.id]
    );

    await conn.commit();
    res.status(201).json({ message: 'Converted to order', order_id: orderId, total_amount: grandTotal });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// Beat plan
// ---------------------------------------------------------------------------

// GET /api/field/beat — the caller's own plan. Scoped by the query, so no grant.
router.get('/beat', async (req, res, next) => {
  try {
    const day = requestedDay(req.query.date) || businessDay();

    const [[plan]] = await pool.query(
      'SELECT * FROM beat_plans WHERE employee_id = ? AND plan_date = ?',
      [req.user.id, day]
    );

    if (!plan) return res.json({ plan: null, stops: [] });

    const [stops] = await pool.query(
      `SELECT bs.*, c.name AS party, c.city AS area
         FROM beat_stops bs
         JOIN customers c ON c.masterid = bs.customer_id
        WHERE bs.plan_id = ?
        ORDER BY bs.seq, bs.id`,
      [plan.id]
    );

    res.json({ plan, stops });
  } catch (err) {
    next(err);
  }
});

// POST /api/field/beat
router.post('/beat', async (req, res, next) => {
  const { beat_name, customer_ids } = req.body || {};
  if (!Array.isArray(customer_ids) || !customer_ids.length) {
    return res.status(400).json({ error: 'A beat needs at least one stop' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const day = businessDay();

    // One plan per person per day, so re-filing replaces rather than duplicates.
    const [inserted] = await conn.query(
      `INSERT INTO beat_plans (employee_id, plan_date, beat_name)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE beat_name = VALUES(beat_name), id = LAST_INSERT_ID(id)`,
      [req.user.id, day, beat_name || null]
    );

    const planId = inserted.insertId;

    // Only unvisited stops are cleared: re-planning the afternoon must not erase
    // the morning's calls.
    await conn.query("DELETE FROM beat_stops WHERE plan_id = ? AND state IN ('planned','next')", [planId]);

    const [existing] = await conn.query('SELECT customer_id FROM beat_stops WHERE plan_id = ?', [planId]);
    const already = new Set(existing.map((row) => row.customer_id));

    let seq = already.size;
    for (const customerId of customer_ids.map(Number)) {
      if (already.has(customerId)) continue;
      seq += 1;
      await conn.query(
        'INSERT INTO beat_stops (plan_id, customer_id, seq) VALUES (?, ?, ?)',
        [planId, customerId, seq]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Beat filed', plan_id: planId, date: day });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/field/beat/stops/:id/visit
router.post('/beat/stops/:id/visit', async (req, res, next) => {
  const { latitude, longitude, order_id } = req.body || {};

  try {
    // Scoped to the caller's own plan: a salesman marks their own calls.
    const [result] = await pool.query(
      `UPDATE beat_stops bs
         JOIN beat_plans bp ON bp.id = bs.plan_id
          SET bs.state = 'done', bs.visited_at = NOW(),
              bs.latitude = ?, bs.longitude = ?, bs.order_id = ?
        WHERE bs.id = ? AND bp.employee_id = ?`,
      [latitude ?? null, longitude ?? null, order_id ? Number(order_id) : null, Number(req.params.id), req.user.id]
    );

    if (!result.affectedRows) return res.status(404).json({ error: 'No such stop on your beat' });
    res.json({ message: 'Visit recorded' });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// The salesman's day
// ---------------------------------------------------------------------------

// GET /api/field/day — figures behind the dashboard, scoped to the caller
router.get('/day', async (req, res, next) => {
  try {
    const day = requestedDay(req.query.date) || businessDay();

    const [[totals]] = await pool.query(
      `SELECT
         COALESCE(SUM(o.is_no_order = FALSE), 0) AS orders,
         COALESCE(SUM(CASE WHEN o.is_no_order = FALSE THEN o.total_amount ELSE 0 END), 0) AS value,
         COALESCE(SUM(o.is_no_order = TRUE), 0)  AS no_order
       FROM orders o
      WHERE o.created_by = ? AND o.order_date = ? AND o.status <> 'cancelled'`,
      [req.user.id, day]
    );

    const [visits] = await pool.query(
      `SELECT o.order_id, o.total_amount, o.is_no_order, o.notes, o.created_at,
              c.name AS party, c.city AS area
         FROM orders o
         JOIN customers c ON c.masterid = o.customer_id
        WHERE o.created_by = ? AND o.order_date = ?
        ORDER BY o.created_at`,
      [req.user.id, day]
    );

    res.json({ date: day, totals, visits });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
