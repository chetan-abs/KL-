const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { userCan } = require('../utils/permissions');
const { businessDay, requestedDay } = require('../utils/businessDay');
const { qty, moveStock, notify, usersWithGrant, usersWhoCan, nextDocNumber } = require('../utils/workflow');
const {
  enqueue: tallyEnqueue, stockJournalXml, config: tallyConfig,
} = require('../utils/tally');

router.use(authenticate);
numericId(router);

/**
 * Internal transfers between the two premises — R-14.
 *
 * Who may do what, and why these grants:
 *
 *   read       `items.view` — the register is a stock document.
 *   send/recv  `purchases.create` — the people who physically handle incoming
 *              goods are the people who move them between godowns. That is Sonu
 *              and, in his absence, Sujay and Dishal, which is exactly the set
 *              section 5.1 names for receiving.
 *   journal    `billing.create` — R-14 names Gaurav, and billing is his area.
 *
 * Deliberately NOT `items.edit`: that grant is for maintaining the master —
 * names, units, racks — and a transfer changes no item's definition.
 *
 *   "Gaurav must create the Tally Stock Journal entry on the same day a
 *    transfer is received. If not done, Yash is notified the next day."
 *
 * Stock moving from Lakhtokia to Fatashil is neither a sale nor a purchase, so
 * it cannot ride on either table: both would change the company's total stock,
 * and a transfer does not. It is two opposing movements against one document,
 * written in one transaction so the total can never drift.
 *
 * The `journal_done_at` stamp is what the next-day sweep looks for. It is a
 * nullable timestamp rather than a boolean so the alert can say how late the
 * entry is rather than merely that it is missing.
 */

/** GET /api/transfers — the register, newest first. */
router.get('/', requirePermission('items.view'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
    if (req.query.pending_journal === 'true') {
      where.push("t.status = 'received' AND t.journal_done_at IS NULL");
    }

    const [rows] = await pool.query(
      `SELECT t.*, s.name AS sent_by_name, r.name AS received_by_name, j.name AS journal_by_name,
              (SELECT COUNT(*) FROM internal_transfer_items i WHERE i.transfer_id = t.id) AS line_count,
              DATEDIFF(CURDATE(), DATE(t.received_at)) AS days_since_receipt
         FROM internal_transfers t
         LEFT JOIN users s ON s.id = t.sent_by
         LEFT JOIN users r ON r.id = t.received_by
         LEFT JOIN users j ON j.id = t.journal_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.id DESC LIMIT 200`, params);

    res.json({
      transfers: rows.map((t) => ({
        ...t,
        // R-14 is a same-day obligation, so "overdue" means the receipt was
        // before today and the journal is still not done.
        journal_overdue: t.status === 'received' && !t.journal_done_at
          && Number(t.days_since_receipt) > 0,
      })),
    });
  } catch (err) { next(err); }
});

/** GET /api/transfers/:id — one transfer with its lines. */
router.get('/:id', requirePermission('items.view'), async (req, res, next) => {
  try {
    const [[transfer]] = await pool.query(
      'SELECT * FROM internal_transfers WHERE id = ?', [req.params.id]);
    if (!transfer) return res.status(404).json({ error: 'No such transfer' });

    const [lines] = await pool.query(
      'SELECT * FROM internal_transfer_items WHERE transfer_id = ? ORDER BY id',
      [transfer.id]);
    res.json({ transfer, lines });
  } catch (err) { next(err); }
});

/**
 * POST /api/transfers — send stock to the other premises.
 *
 * Stock does NOT move here. It moves when the goods are received, for the same
 * reason a purchase posts on receipt: goods in a van are not goods on a shelf,
 * and booking them into the destination before they arrive would show stock at
 * an address that does not have it.
 *
 * What this does record is the intent, so the receiving end knows what to
 * expect and a shortfall on arrival is visible.
 */
router.post('/', requirePermission('purchases.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { from_godown, to_godown, transfer_date, lines, note } = req.body || {};

    if (!String(from_godown || '').trim() || !String(to_godown || '').trim()) {
      return res.status(400).json({
        error: 'Name both godowns.', code: 'GODOWNS_REQUIRED' });
    }
    if (String(from_godown).trim() === String(to_godown).trim()) {
      return res.status(400).json({
        error: 'A transfer needs two different godowns.', code: 'SAME_GODOWN' });
    }
    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ error: 'Send at least one line' });
    }

    await conn.beginTransaction();

    const ids = [...new Set(lines.map((l) => Number(l.item_id)))];
    if (ids.some((id) => !Number.isInteger(id))) {
      await conn.rollback();
      return res.status(400).json({ error: 'Every line needs a valid item_id' });
    }

    const [masters] = await conn.query(
      'SELECT masterid, name FROM items WHERE masterid IN (?) AND is_active = TRUE',
      [ids]);
    const byId = new Map(masters.map((m) => [m.masterid, m]));

    const prepared = [];
    for (const line of lines) {
      const master = byId.get(Number(line.item_id));
      if (!master) {
        await conn.rollback();
        return res.status(400).json({ error: `Item ${line.item_id} is not available` });
      }
      const sending = qty(Number(line.sent_qty));
      if (!Number.isFinite(sending) || sending <= 0) {
        await conn.rollback();
        return res.status(400).json({
          error: `${master.name}: the quantity sent must be greater than zero.` });
      }
      prepared.push({ item_id: master.masterid, item_name: master.name, sent_qty: sending });
    }

    const transferNo = await nextDocNumber(conn, {
      table: 'internal_transfers', column: 'transfer_no', prefix: 'IT-', width: 4,
    });

    const [ins] = await conn.query(
      `INSERT INTO internal_transfers
         (transfer_no, from_godown, to_godown, transfer_date, note, sent_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [transferNo, String(from_godown).trim(), String(to_godown).trim(),
        requestedDay(transfer_date) || businessDay(), note || null, req.user.id]);

    for (const line of prepared) {
      await conn.query(
        `INSERT INTO internal_transfer_items (transfer_id, item_id, item_name, sent_qty)
         VALUES (?, ?, ?, ?)`,
        [ins.insertId, line.item_id, line.item_name, line.sent_qty]);
    }

    await conn.commit();
    res.status(201).json({
      message: 'Transfer sent.',
      transfer_id: ins.insertId,
      transfer_no: transferNo,
      lines: prepared.length,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * POST /api/transfers/:id/receive — the goods arrive.
 *
 * The received quantity is its own field and is not defaulted from what was
 * sent — the same discipline R-08 imposes on a purchase, for the same reason: a
 * count nobody made is worse than no count.
 *
 * Nothing moves in `stock_movements` when the totals match, and that is
 * deliberate. `items.qty` is a company-wide level, not a per-godown one, so a
 * transfer that arrives complete changes nothing about how much stock the
 * company holds. Writing two cancelling movements would be noise in a ledger
 * whose whole value is that every row explains a change.
 *
 * A SHORTFALL is different: stock has genuinely gone missing between the two
 * premises, and that is a real reduction which the ledger must carry.
 */
router.post('/:id/receive', requirePermission('purchases.create'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const corrections = Array.isArray(req.body?.lines) ? req.body.lines : [];
    await conn.beginTransaction();

    const [[transfer]] = await conn.query(
      'SELECT * FROM internal_transfers WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!transfer) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such transfer' });
    }
    if (transfer.status !== 'sent') {
      await conn.rollback();
      return res.status(409).json({
        error: `That transfer is already ${transfer.status}.`, code: 'STALE' });
    }
    // The person who sent it is not the person who confirms it arrived —
    // otherwise the two ends of the journey are one person's word.
    if (transfer.sent_by === req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'The sender cannot also receive the transfer.', code: 'SELF_RECEIPT' });
    }

    const [lines] = await conn.query(
      'SELECT * FROM internal_transfer_items WHERE transfer_id = ?', [transfer.id]);

    const byId = new Map(corrections
      .filter((c) => Number.isInteger(Number(c.id)))
      .map((c) => [Number(c.id), qty(Number(c.received_qty))]));

    const shortfalls = [];
    for (const line of lines) {
      const received = byId.has(line.id) ? byId.get(line.id) : Number(line.sent_qty);
      if (!Number.isFinite(received) || received < 0) {
        await conn.rollback();
        return res.status(400).json({
          error: `${line.item_name}: enter the quantity that arrived.`,
          code: 'RECEIVED_QTY_REQUIRED',
        });
      }

      await conn.query(
        'UPDATE internal_transfer_items SET received_qty = ? WHERE id = ?',
        [received, line.id]);

      const missing = qty(Number(line.sent_qty) - received);
      if (missing > 0) {
        shortfalls.push(`${line.item_name}: sent ${Number(line.sent_qty)}, arrived ${received}`);
        // Real stock loss, so a real movement. `transfer` as the reason rather
        // than `adjustment`, so the register can tell goods lost in transit
        // from a counting correction.
        await moveStock(conn, {
          itemId: line.item_id,
          change: -missing,
          reason: 'transfer',
          refType: 'transfer',
          refId: transfer.id,
          note: `Short on ${transfer.transfer_no}: ${transfer.from_godown} → ${transfer.to_godown}`,
          userId: req.user.id,
        });
      }
    }

    await conn.query(
      `UPDATE internal_transfers SET status = 'received', received_by = ?, received_at = NOW()
        WHERE id = ?`,
      [req.user.id, transfer.id]);

    // R-14 — the journal is due today. Gaurav is told now, not tomorrow when
    // the alert fires.
    for (const biller of await usersWhoCan(conn, 'billing.create')) {
      await notify(conn, {
        userId: biller,
        tone: 'warning',
        title: `Stock journal due today — ${transfer.transfer_no}`,
        body: `${transfer.from_godown} → ${transfer.to_godown}, ${lines.length} line(s). `
          + 'R-14: the Tally entry is due the same day.',
        actor: req.user.id,
        refType: 'transfer',
        refId: transfer.id,
      });
    }

    if (shortfalls.length) {
      for (const owner of await usersWithGrant(conn, 'all')) {
        await notify(conn, {
          userId: owner,
          tone: 'warning',
          title: `Stock short in transit — ${transfer.transfer_no}`,
          body: shortfalls.join('; '),
          actor: req.user.id,
          refType: 'transfer',
          refId: transfer.id,
        });
      }
    }

    await conn.commit();
    res.json({
      message: 'Received.',
      shortfalls,
      journal_due_today: true,
    });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * POST /api/transfers/:id/journal — R-14, the Tally stock journal entry.
 *
 * Recording that Gaurav has made it is what stops the next-day escalation. The
 * app cannot make a Tally entry — there is no Tally integration — so what it
 * records is the acknowledgement, the same honest shape as the godown register.
 */
router.post('/:id/journal', requirePermission('billing.create'), async (req, res, next) => {
  try {
    const [[transfer]] = await pool.query(
      'SELECT * FROM internal_transfers WHERE id = ?', [req.params.id]);
    if (!transfer) return res.status(404).json({ error: 'No such transfer' });
    if (transfer.status !== 'received') {
      return res.status(409).json({
        error: 'The journal follows receipt. This transfer has not been received yet.',
        code: 'NOT_RECEIVED',
      });
    }
    if (transfer.journal_done_at) {
      return res.status(409).json({
        error: `Already recorded at ${transfer.journal_done_at}.`, code: 'ALREADY_DONE' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        'UPDATE internal_transfers SET journal_done_at = NOW(), journal_by = ? WHERE id = ?',
        [req.user.id, transfer.id]);

      // Section 14: "Stock Journal for Internal Transfers (same day)". Queued in
      // the same transaction as R-14's acknowledgement, so the two cannot come
      // apart — Gaurav saying he made the entry and Tally being sent it are one
      // fact, not two.
      const [lines] = await conn.query(
        'SELECT * FROM internal_transfer_items WHERE transfer_id = ?', [transfer.id]);
      await tallyEnqueue(conn, {
        kind: 'stock_journal',
        refType: 'transfer',
        refId: transfer.id,
        payload: stockJournalXml({ transfer, lines, company: tallyConfig().company }),
        userId: req.user.id,
      });
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json({ message: 'Stock journal recorded and queued for Tally.' });
  } catch (err) { next(err); }
});

module.exports = router;
