/**
 * Cash and close — Sibu.
 *
 *   GET  /api/cash/cheques           cheques in hand and banked
 *   POST /api/cash/cheques           record one collected
 *   POST /api/cash/cheques/:id/status  deposit, clear or bounce it
 *   GET  /api/cash/eod               today's figures, ready to close against
 *   POST /api/cash/eod               close the day
 *
 * Schemes ride along here too — they are read at a counter beside the cash
 * book, and neither is big enough to earn a module of its own:
 *
 *   GET  /api/cash/schemes           live schemes with slabs and standings
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { money, notify, recomputeBalance, usersWithGrant, usersWhoCan } = require('../utils/workflow');
const { userCan } = require('../utils/permissions');
const { reverseAllocations } = require('../utils/cashDiscount');
const { businessDay, requestedDay } = require('../utils/businessDay');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// The states this route may set, and they must match the column's enum exactly.
//
// Migration 010 renamed the initial state from 'to_deposit' to 'received',
// which is what section 11 calls it. Any list here that drifts from the column
// is dangerous rather than merely wrong: MariaDB ships non-strict, so it stores
// the empty string instead of refusing the write, and the cheque then falls out
// of every status filter with no error anywhere. config/db.js now pins
// STRICT_TRANS_TABLES so that throws instead.
//
// 'deposited' is deliberately absent: it needs the slip photograph (R-06) and
// has its own route.
const CHEQUE_STATES = ['received', 'handed', 'cleared', 'bounced', 'cancelled'];

// ---------------------------------------------------------------------------
// Cheques
// ---------------------------------------------------------------------------

// GET /api/cash/cheques
router.get('/cheques', requirePermission('cheques.view'), async (req, res, next) => {
  try {
    const params = [];
    let sql = `
      SELECT ch.*, c.name AS party
        FROM cheques ch
        JOIN customers c ON c.masterid = ch.customer_id
       WHERE 1=1
    `;
    if (req.query.status && CHEQUE_STATES.includes(req.query.status)) {
      sql += ' AND ch.status = ?';
      params.push(req.query.status);
    }
    // To-deposit first: it is the only actionable state, and a bounced cheque
    // must not sink below a page of cleared ones.
    // Bounced first, then what still needs doing, then what is settled — the
    // order Sibu works the screen in, not alphabetical.
    sql += " ORDER BY FIELD(ch.status,'bounced','received','handed','deposited','cleared','cancelled'),"
      + ' ch.cheque_date ASC LIMIT 200';

    const [rows] = await pool.query(sql, params);
    res.json({ cheques: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/cash/cheques
router.post('/cheques', requirePermission('cheques.manage'), async (req, res, next) => {
  const { cheque_no, customer_id, bank_name, amount, cheque_date } = req.body || {};

  if (!String(cheque_no || '').trim()) return res.status(400).json({ error: 'cheque_no is required' });
  if (!Number.isInteger(Number(customer_id))) return res.status(400).json({ error: 'customer_id is required' });

  const value = money(Number(amount));
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'A cheque needs an amount greater than zero' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO cheques (cheque_no, customer_id, bank_name, amount, cheque_date, collected_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(cheque_no).trim(),
        Number(customer_id),
        bank_name || null,
        value,
        requestedDay(cheque_date) || businessDay(),
        req.user.id,
      ]
    );
    res.status(201).json({ message: 'Cheque recorded', cheque_id: result.insertId });
  } catch (err) {
    next(err);
  }
});

// POST /api/cash/cheques/:id/status
/**
 * POST /api/cash/cheques/:id/hand-over — section 11.
 *
 * "Sibu selects the cheques to be deposited and specifies the KL bank account
 *  (ICICI / SBI / other) for each. Sibu hands the physical cheques to Damodar
 *  with instructions."
 *
 * A separate step from depositing because a separate person does it, and the
 * gap between the two is where a physical cheque goes missing. The bank account
 * is chosen here, by Sibu, not by whoever carries it — Damodar is told which
 * account, he does not decide it.
 */
router.post('/cheques/:id/hand-over', requirePermission('cheques.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { deposit_bank, handed_to, instruction } = req.body || {};
    if (!deposit_bank || !String(deposit_bank).trim()) {
      return res.status(400).json({
        error: 'Say which KL account it goes into.', code: 'DEPOSIT_BANK_REQUIRED' });
    }
    if (!handed_to) {
      return res.status(400).json({
        error: 'Name the person taking the cheque to the bank.', code: 'HANDED_TO_REQUIRED' });
    }

    await conn.beginTransaction();
    const [[cheque]] = await conn.query(
      'SELECT * FROM cheques WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!cheque) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such cheque' });
    }
    if (cheque.status !== 'received') {
      await conn.rollback();
      return res.status(409).json({
        error: `That cheque is already ${cheque.status}.`, code: 'STALE' });
    }

    const [[carrier]] = await conn.query(
      'SELECT id, name FROM users WHERE id = ? AND is_active = TRUE', [handed_to]);
    if (!carrier) {
      await conn.rollback();
      return res.status(400).json({ error: 'No such active employee.', code: 'NO_SUCH_USER' });
    }

    await conn.query(
      `UPDATE cheques
          SET status = 'handed', deposit_bank = ?, deposit_instruction = ?,
              handed_to = ?, handed_at = NOW()
        WHERE id = ?`,
      [String(deposit_bank).trim(), instruction || null, handed_to, cheque.id]);

    await notify(conn, {
      userId: handed_to,
      tone: 'info',
      title: 'Cheque to deposit',
      body: `${cheque.cheque_no} for ${Number(cheque.amount).toFixed(2)} into ${deposit_bank}.`
        + `${instruction ? ` ${instruction}` : ''} Photograph the deposit slip.`,
      actor: req.user.id,
      refType: 'cheque',
      refId: cheque.id,
    });

    await conn.commit();
    res.json({ message: `Handed to ${carrier.name}.` });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * POST /api/cash/cheques/:id/deposit — R-06.
 *
 * "Damodar deposits the cheques, photographs the deposit slip, and uploads it
 *  in the application."
 *
 * The photograph is mandatory and checked here, not in the UI. A cheque marked
 * deposited with no slip is indistinguishable from one still in a pocket, and
 * that is precisely the state the photograph exists to rule out.
 *
 * Guarded on `cheques.deposit`, which Damodar holds and Sibu does not need:
 * the person who hands a cheque over is not the person who confirms it reached
 * the bank.
 */
router.post('/cheques/:id/deposit', requirePermission('cheques.deposit'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { deposit_slip_photo_id } = req.body || {};
    if (!deposit_slip_photo_id) {
      return res.status(400).json({
        error: 'Photograph the deposit slip before marking it deposited.',
        code: 'SLIP_PHOTO_REQUIRED',
      });
    }

    await conn.beginTransaction();
    const [[slip]] = await conn.query(
      'SELECT id, uploaded_by FROM attachments WHERE id = ?', [Number(deposit_slip_photo_id)]);
    if (!slip) {
      await conn.rollback();
      return res.status(400).json({
        error: 'That photograph was not found.', code: 'PHOTO_NOT_FOUND' });
    }
    if (slip.uploaded_by !== req.user.id) {
      await conn.rollback();
      return res.status(400).json({
        error: 'That photograph belongs to somebody else.', code: 'PHOTO_NOT_YOURS' });
    }

    const [[cheque]] = await conn.query(
      'SELECT * FROM cheques WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!cheque) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such cheque' });
    }
    if (!['received', 'handed'].includes(cheque.status)) {
      await conn.rollback();
      return res.status(409).json({
        error: `That cheque is already ${cheque.status}.`, code: 'STALE' });
    }

    await conn.query(
      `UPDATE cheques
          SET status = 'deposited', deposited_at = NOW(),
              deposited_by = ?, deposit_slip_photo_id = ?
        WHERE id = ?`,
      [req.user.id, Number(deposit_slip_photo_id), cheque.id]);

    await conn.query(
      "UPDATE attachments SET ref_type = 'cheque_slip', ref_id = ? WHERE id = ?",
      [cheque.id, Number(deposit_slip_photo_id)]);

    // Sibu marks it cleared once the bank confirms, two or three days later, so
    // he is told it is in.
    for (const keeper of await usersWhoCan(conn, 'cheques.manage')) {
      await notify(conn, {
        userId: keeper,
        tone: 'success',
        title: 'Cheque deposited',
        body: `${cheque.cheque_no} into ${cheque.deposit_bank || 'the bank'} by ${req.user.name}. Slip uploaded.`,
        actor: req.user.id,
        refType: 'cheque',
        refId: cheque.id,
      });
    }

    await conn.commit();
    res.json({ message: 'Deposited, slip on file.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

router.post('/cheques/:id/status', requirePermission('cheques.manage'), async (req, res, next) => {
  const status = String(req.body?.status || '');

  // R-06 first, and before the generic check, so the caller is told WHY rather
  // than being handed a list of states with 'deposited' mysteriously absent
  // from it. The photograph is not optional, so this route cannot be used to
  // walk around the dedicated one that demands it.
  if (status === 'deposited') {
    return res.status(400).json({
      error: 'Use POST /cheques/:id/deposit — a deposit needs the slip photograph.',
      code: 'SLIP_PHOTO_REQUIRED',
    });
  }
  if (!CHEQUE_STATES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of ${CHEQUE_STATES.join(', ')}`,
      code: 'BAD_STATUS',
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `UPDATE cheques
          SET status = ?,
              deposited_at = CASE WHEN ? = 'deposited' THEN NOW() ELSE deposited_at END,
              cleared_at   = CASE WHEN ? = 'cleared'   THEN NOW() ELSE cleared_at END
        WHERE id = ?`,
      [status, status, status, Number(req.params.id)]
    );

    if (!result.affectedRows) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such cheque' });
    }

    // A bounce is money that did not arrive.
    if (status === 'bounced') {
      const [[cheque]] = await conn.query(
        `SELECT ch.cheque_no, ch.amount, ch.customer_id, c.name AS party,
                ch.salesman_id AS cheque_salesman, c.salesman_id AS party_salesman
           FROM cheques ch JOIN customers c ON c.masterid = ch.customer_id
          WHERE ch.id = ?`,
        [Number(req.params.id)]
      );

      // Any receipt this cheque paid for is reversed with it. Without this the
      // party's balance would still show the money as received — the ledger
      // saying paid while the bank says otherwise, which is the one disagreement
      // a cash book must never have.
      const [affected] = await conn.query(
        "SELECT id FROM payments WHERE cheque_id = ? AND status = 'received'",
        [Number(req.params.id)]
      );

      const [reversed] = await conn.query(
        `UPDATE payments
            SET status = 'reversed',
                note = CONCAT(COALESCE(note,''), ' | reversed: cheque ', ?, ' bounced')
          WHERE cheque_id = ? AND status = 'received'`,
        [cheque.cheque_no, Number(req.params.id)]
      );

      // The FIFO allocations go with the receipt, and so does any cash discount
      // it earned. Marking the payment reversed on its own left every invoice it
      // had settled still showing as paid — the same disagreement one line up,
      // one table deeper. A discount earned on a cheque that bounced was not
      // earned; the note is cancelled, never deleted, because it was issued and
      // the party may already have seen it.
      for (const payment of affected) {
        await reverseAllocations(conn, payment.id);
        await conn.query(
          `UPDATE credit_notes
              SET status = 'cancelled',
                  reason = CONCAT(COALESCE(reason,''), ' | cancelled: cheque bounced')
            WHERE payment_id = ? AND status <> 'cancelled'`,
          [payment.id]
        );
      }

      if (reversed.affectedRows) await recomputeBalance(conn, cheque.customer_id);

      const body = `${cheque.party} — cheque ${cheque.cheque_no} for ₹${cheque.amount} returned.${
        reversed.affectedRows ? ' The receipt against it has been reversed.' : ''
      } The balance is still outstanding.`;

      // Broadcast, which reaches the owners.
      await notify(conn, {
        tone: 'danger',
        title: 'Cheque bounced',
        body,
        actor: req.user.name,
        refType: 'cheque',
        refId: Number(req.params.id),
      });

      // Section 11: "Yash and the relevant salesman receive an immediate
      // notification." The salesman is told by name rather than left to notice
      // a broadcast — it is their party, and usually their collection.
      const salesman = cheque.cheque_salesman || cheque.party_salesman;
      if (salesman) {
        await notify(conn, {
          userId: salesman,
          tone: 'danger',
          title: 'A cheque you collected has bounced',
          body,
          actor: req.user.id,
          refType: 'cheque',
          refId: Number(req.params.id),
        });
      }
    }

    await conn.commit();
    res.json({ message: `Cheque marked ${status}` });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// Collections handed to Sibu — section 8
// ---------------------------------------------------------------------------

/**
 * POST /api/cash/handover — the salesman declares what he is bringing in.
 *
 *   "Cash collected by a salesman must be deposited with Sibu on the same day.
 *    Cheques collected must be entered in the application and physically handed
 *    to Sibu."
 *
 * Two people, two moments, two sets of columns. The salesman declares; Sibu
 * counts. Collapsing them into one row that Sibu fills in would lose the
 * declaration, and the declaration is the only record of a shortfall — without
 * it, "he gave me 4,000" and "I gave him 5,000" are both unevidenced.
 *
 * Ungated beyond `authenticate`: this is the caller's own declaration about
 * their own day, in exactly the way a check-in is. A salesman who cannot
 * declare what they are carrying is a salesman who hands over cash with no
 * record, which is the situation the rule exists to end.
 */
router.post('/handover', async (req, res, next) => {
  try {
    const cash = money(Number(req.body?.cash ?? 0));
    const cheques = Number(req.body?.cheques ?? 0);
    const chequeValue = money(Number(req.body?.cheque_value ?? 0));

    if (!Number.isFinite(cash) || cash < 0) {
      return res.status(400).json({ error: 'Cash cannot be negative.' });
    }
    if (!Number.isInteger(cheques) || cheques < 0) {
      return res.status(400).json({ error: 'The cheque count must be a whole number.' });
    }
    if (cash === 0 && cheques === 0) {
      return res.status(400).json({
        error: 'Nothing to hand over. Declare the cash or the cheques you collected.',
        code: 'NOTHING_DECLARED',
      });
    }

    const day = businessDay();
    const [r] = await pool.query(
      `INSERT INTO collection_handovers
         (employee_id, handover_date, declared_cash, declared_cheques, declared_cheque_value, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         declared_cash = VALUES(declared_cash),
         declared_cheques = VALUES(declared_cheques),
         declared_cheque_value = VALUES(declared_cheque_value),
         note = VALUES(note)`,
      [req.user.id, day, cash, cheques, chequeValue, req.body?.note || null]);

    // A declaration that has already been received cannot be edited — the money
    // has been counted, and changing the figure afterwards is how a shortfall
    // disappears.
    const [[row]] = await pool.query(
      'SELECT * FROM collection_handovers WHERE employee_id = ? AND handover_date = ?',
      [req.user.id, day]);
    if (row.status !== 'declared' && r.affectedRows === 2) {
      return res.status(409).json({
        error: 'Sibu has already counted today\'s handover. Speak to him about a correction.',
        code: 'ALREADY_RECEIVED',
      });
    }

    const conn = await pool.getConnection();
    try {
      for (const cashier of await usersWhoCan(conn, 'cash')) {
        await notify(conn, {
          userId: cashier,
          tone: 'info',
          title: `${req.user.name} is bringing in collections`,
          body: `${cash > 0 ? `Cash ${cash.toFixed(2)}` : ''}`
            + `${cash > 0 && cheques > 0 ? ' · ' : ''}`
            + `${cheques > 0 ? `${cheques} cheque(s) worth ${chequeValue.toFixed(2)}` : ''}`,
          actor: req.user.id,
          refType: 'handover',
          refId: row.id,
        });
      }
    } finally { conn.release(); }

    res.status(201).json({ message: 'Declared. Hand it to Sibu today.', handover: row });
  } catch (err) { next(err); }
});

/**
 * GET /api/cash/handover — today's declarations.
 *
 * Sibu sees everyone's, so he knows who has not come in yet; anybody else sees
 * their own.
 */
router.get('/handover', async (req, res, next) => {
  try {
    // Whoever may RECEIVE a handover must see all of them, or the person the
    // rule is about cannot find the money he is meant to be counting. Sibu
    // holds `cash.manage`, not `cash.view`, and checking only the read grants
    // showed him an empty list.
    const all = userCan(req.user, 'cash')
      || userCan(req.user, 'cash.view')
      || userCan(req.user, 'cash.manage');
    const day = requestedDay(req.query.date);
    const params = [day];
    if (!all) params.push(req.user.id);

    const [rows] = await pool.query(
      `SELECT h.*, u.name AS employee_name, r.name AS received_by_name
         FROM collection_handovers h
         JOIN users u ON u.id = h.employee_id
         LEFT JOIN users r ON r.id = h.received_by
        WHERE h.handover_date = ? ${all ? '' : 'AND h.employee_id = ?'}
        ORDER BY h.status = 'received', u.name`, params);

    res.json({
      date: day,
      handovers: rows,
      declared_cash: rows.reduce((a, r) => money(a + Number(r.declared_cash)), 0),
      received_cash: rows.reduce((a, r) => money(a + Number(r.received_cash || 0)), 0),
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/cash/handover/:id/receive — Sibu counts it.
 *
 * The received figure is its own field and is never defaulted from the declared
 * one, the same discipline R-08 imposes on a purchase quantity. A variance
 * marks the handover disputed rather than quietly adopting either number, and
 * the owners are told: a shortfall between a salesman's pocket and the cash box
 * is not a rounding difference.
 */
router.post('/handover/:id/receive', requirePermission('cash.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const receivedCash = money(Number(req.body?.cash));
    const receivedCheques = Number(req.body?.cheques ?? 0);

    if (!Number.isFinite(receivedCash) || receivedCash < 0) {
      return res.status(400).json({
        error: 'Enter the cash you actually counted.', code: 'RECEIVED_CASH_REQUIRED' });
    }

    await conn.beginTransaction();
    const [[h]] = await conn.query(
      `SELECT h.*, u.name AS employee_name FROM collection_handovers h
         JOIN users u ON u.id = h.employee_id WHERE h.id = ? FOR UPDATE`, [req.params.id]);
    if (!h) { await conn.rollback(); return res.status(404).json({ error: 'No such handover' }); }
    if (h.status !== 'declared') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${h.status}.`, code: 'STALE' });
    }
    // Nobody receives their own handover — that would be one person's word for
    // both halves of the transfer.
    if (h.employee_id === req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'You cannot receive your own handover.', code: 'SELF_RECEIPT' });
    }

    const variance = money(receivedCash - Number(h.declared_cash));
    const disputed = Math.abs(variance) > 0.005 || receivedCheques !== Number(h.declared_cheques);

    await conn.query(
      `UPDATE collection_handovers
          SET received_cash = ?, received_cheques = ?, variance = ?,
              status = ?, received_by = ?, received_at = NOW(),
              note = CONCAT(COALESCE(note, ''), ?)
        WHERE id = ?`,
      [receivedCash, receivedCheques, variance,
        disputed ? 'disputed' : 'received', req.user.id,
        req.body?.note ? ` | ${req.body.note}` : '', h.id]);

    if (disputed) {
      const detail = `${h.employee_name} declared ${Number(h.declared_cash).toFixed(2)} `
        + `and ${h.declared_cheques} cheque(s); ${receivedCash.toFixed(2)} and `
        + `${receivedCheques} cheque(s) were counted.`;
      for (const owner of await usersWhoCan(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: 'Collection handover does not match',
          body: detail,
          actor: req.user.id,
          refType: 'handover',
          refId: h.id,
        });
      }
      await notify(conn, {
        userId: h.employee_id,
        tone: 'warning',
        title: 'Your handover was counted short',
        body: detail,
        actor: req.user.id,
        refType: 'handover',
        refId: h.id,
      });
    }

    await conn.commit();
    res.json({
      message: disputed ? 'Recorded, and flagged as a variance.' : 'Received.',
      variance,
      disputed,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

// ---------------------------------------------------------------------------
// The godown close — section 4.8
// ---------------------------------------------------------------------------

/**
 * POST /api/cash/day-close — Ajit's 7 p.m. close.
 *
 *   "Ajit updates the application with final order statuses by 7 p.m. and sends
 *    a godown photo to Yash."
 *
 * A different act from Sibu's EOD at 7:15, which is money. This one is the
 * godown floor: the statuses are final, and here is what it looked like. The
 * photograph is the whole point, so it is mandatory (R-06's pattern).
 *
 * `open_orders` is counted by the server rather than typed, because "final
 * order statuses" is a claim that can be checked: the close records how many
 * orders were still mid-pipeline when it was made.
 */
router.post('/day-close', requirePermission('dispatch.build'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const photoId = req.body?.godown_photo_id;
    if (!photoId) {
      return res.status(400).json({
        error: 'Photograph the godown before closing the day.',
        code: 'GODOWN_PHOTO_REQUIRED',
      });
    }

    await conn.beginTransaction();

    const [[photo]] = await conn.query(
      'SELECT id, uploaded_by FROM attachments WHERE id = ?', [Number(photoId)]);
    if (!photo) {
      await conn.rollback();
      return res.status(400).json({ error: 'That photograph was not found.', code: 'PHOTO_NOT_FOUND' });
    }
    if (photo.uploaded_by !== req.user.id) {
      await conn.rollback();
      return res.status(400).json({
        error: 'That photograph belongs to somebody else.', code: 'PHOTO_NOT_YOURS' });
    }

    const day = businessDay();
    const [[open]] = await conn.query(
      `SELECT COUNT(*) AS n FROM orders
        WHERE is_no_order = FALSE
          AND status IN ('pending','confirmed','approved','picking','picked','verified','invoiced')`);

    await conn.query(
      `INSERT INTO day_closings (close_date, godown_photo_id, open_orders, note, closed_by)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         godown_photo_id = VALUES(godown_photo_id), open_orders = VALUES(open_orders),
         note = VALUES(note), closed_by = VALUES(closed_by), closed_at = NOW()`,
      [day, Number(photoId), Number(open.n), req.body?.note || null, req.user.id]);

    await conn.query(
      "UPDATE attachments SET ref_type = 'godown_close', ref_id = ? WHERE id = ?",
      [Number(photoId), Number(photoId)]);

    // "sends a godown photo to Yash" — to the owners by name, not a broadcast.
    for (const owner of await usersWhoCan(conn, 'all')) {
      await notify(conn, {
        userId: owner,
        tone: 'info',
        title: 'Godown closed for the day',
        body: `${req.user.name} closed the floor. ${open.n} order(s) still open.`
          + `${req.body?.note ? ` ${req.body.note}` : ''}`,
        actor: req.user.id,
        refType: 'godown_close',
        refId: Number(photoId),
      });
    }

    await conn.commit();
    res.json({
      message: 'Godown closed and the photograph sent to the owners.',
      close_date: day,
      open_orders: Number(open.n),
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/** GET /api/cash/day-close — the godown close history. */
router.get('/day-close', requirePermission('dispatch.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, u.name AS closed_by_name, a.stored_name AS photo
         FROM day_closings d
         LEFT JOIN users u ON u.id = d.closed_by
         LEFT JOIN attachments a ON a.id = d.godown_photo_id
        ORDER BY d.close_date DESC LIMIT 60`);
    res.json({ closings: rows, today: businessDay() });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// End of day
// ---------------------------------------------------------------------------

/**
 * GET /api/cash/eod
 *
 * The day's collections and what the drawer should therefore hold. The counted
 * figure is deliberately NOT returned or pre-filled: a pre-filled count is not a
 * count, and catching the day where the drawer and the ledger disagree is the
 * entire purpose of the screen.
 */
router.get('/eod', requirePermission('eod.view'), async (req, res, next) => {
  try {
    const day = requestedDay(req.query.date) || businessDay();

    const [[invoiced]] = await pool.query(
      `SELECT COUNT(*) AS invoices, COALESCE(SUM(grand_total), 0) AS billed
         FROM invoices WHERE invoice_date = ? AND status = 'issued'`,
      [day]
    );

    const [[cheques]] = await pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM cheques WHERE cheque_date = ?",
      [day]
    );

    const [[deliveries]] = await pool.query(
      `SELECT COALESCE(SUM(status = 'delivered'), 0) AS delivered,
              COALESCE(SUM(status = 'undelivered'), 0) AS failed
         FROM deliveries WHERE DATE(delivered_at) = ?`,
      [day]
    );

    const [[closed]] = await pool.query('SELECT * FROM eod_closings WHERE close_date = ?', [day]);

    // 3.2 — "The count of below-rate requests per user must appear in the EOD
    // exception report." Every tier counts, including an auto-applied one:
    // auto-approved is still a below-rate sale, only decided by the 2% band
    // rather than by a person. Owner-tier ones tell Sibu who is asking to
    // sell below cost, which is the exception that matters most.
    const [belowRate] = await pool.query(
      `SELECT rc.requested_by, u.name AS requested_by_name, rc.tier, COUNT(*) AS n
         FROM item_rate_changes rc
         LEFT JOIN users u ON u.id = rc.requested_by
        WHERE DATE(rc.requested_at) = ? AND rc.tier IN ('auto','sibu','owner')
          AND rc.status IN ('auto_approved','pending','approved','rejected')
        GROUP BY rc.requested_by, u.name, rc.tier
        ORDER BY rc.requested_by`,
      [day]
    );

    // 3.3 — every credit/overdue override used today, for the same reason:
    // an exception report exists to catch what a block quietly getting
    // lifted would otherwise hide.
    const [overrides] = await pool.query(
      `SELECT oo.kind, oo.overridden_by, u.name AS overridden_by_name, COUNT(*) AS n
         FROM order_overrides oo
         JOIN orders o ON o.order_id = oo.order_id
         LEFT JOIN users u ON u.id = oo.overridden_by
        WHERE o.order_date = ?
        GROUP BY oo.kind, oo.overridden_by, u.name`,
      [day]
    );

    res.json({
      date: day,
      invoices: invoiced.invoices,
      billed: invoiced.billed,
      cheques_in: cheques.total,
      delivered: deliveries.delivered,
      failed: deliveries.failed,
      closed: closed || null,
      exceptions: {
        below_rate_requests: belowRate,
        credit_overrides: overrides,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/cash/eod — close the day
router.post('/eod', requirePermission('eod.close'), async (req, res, next) => {
  const { opening_cash, cash_in, cheques_in, upi_in, expenses, counted_cash, note } = req.body || {};

  const counted = money(Number(counted_cash));
  if (!Number.isFinite(counted) || counted < 0) {
    return res.status(400).json({ error: 'A counted cash figure is required to close the day' });
  }

  const opening = money(Number(opening_cash) || 0);
  const cash = money(Number(cash_in) || 0);
  const spent = money(Number(expenses) || 0);
  const expected = money(opening + cash - spent);

  try {
    // A variance does not block the close — the money is already whatever it is.
    // It is recorded, against a name, and that is what the confirmation on the
    // screen makes the closer read before they commit.
    const [result] = await pool.query(
      `INSERT INTO eod_closings
         (close_date, opening_cash, cash_in, cheques_in, upi_in, expenses,
          expected_cash, counted_cash, variance, note, closed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        businessDay(), opening, cash,
        money(Number(cheques_in) || 0), money(Number(upi_in) || 0), spent,
        expected, counted, money(counted - expected), note || null, req.user.id,
      ]
    );

    res.status(201).json({
      message: 'Day closed',
      id: result.insertId,
      expected_cash: expected,
      counted_cash: counted,
      variance: money(counted - expected),
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'That day is already closed' });
    }
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

// GET /api/cash/schemes
router.get('/schemes', requirePermission('schemes.view'), async (req, res, next) => {
  try {
    const [schemes] = await pool.query(
      `SELECT * FROM schemes
        WHERE is_active = TRUE AND ? BETWEEN starts_on AND ends_on
        ORDER BY id DESC`,
      [businessDay()]
    );

    for (const scheme of schemes) {
      const [slabs] = await pool.query(
        'SELECT * FROM scheme_slabs WHERE scheme_id = ? ORDER BY min_qty',
        [scheme.id]
      );
      const [standings] = await pool.query(
        `SELECT a.id, a.name, a.phone,
                COALESCE(SUM(sl.qty), 0)    AS qty,
                COALESCE(SUM(sl.earned), 0) AS earned
           FROM scheme_ledger sl
           JOIN agents a ON a.id = sl.agent_id
          WHERE sl.scheme_id = ?
          GROUP BY a.id, a.name, a.phone
          ORDER BY earned DESC`,
        [scheme.id]
      );
      scheme.slabs = slabs;
      scheme.standings = standings;
    }

    res.json({ schemes });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
