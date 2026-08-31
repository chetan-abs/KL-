/**
 * Physical stock count — Ashish.
 *
 *   GET  /api/stock-counts          recent counts
 *   POST /api/stock-counts          open one over a set of items
 *   GET  /api/stock-counts/:id      the sheet
 *   PUT  /api/stock-counts/:id/lines  record counted quantities
 *   POST /api/stock-counts/:id/post   reconcile to the ledger
 *
 * Posting writes one `adjustment` movement per varied line. Nothing is edited:
 * the count that found the loss and the loss itself both stay in the ledger,
 * which is what makes a level explainable months later.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { qty, moveStock, notify } = require('../utils/workflow');
const { businessDay } = require('../utils/businessDay');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/stock-counts
router.get('/', requirePermission('stock_count.view'), async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT sc.*, u.name AS started_by_name,
              COUNT(l.id) AS line_count,
              COALESCE(SUM(l.counted_qty IS NOT NULL), 0) AS counted_lines
         FROM stock_counts sc
         LEFT JOIN users u ON u.id = sc.started_by
         LEFT JOIN stock_count_lines l ON l.count_id = sc.id
        GROUP BY sc.id, u.name
        ORDER BY sc.id DESC
        LIMIT 30`
    );
    res.json({ counts: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/stock-counts — open a sheet
router.post('/', requirePermission('stock_count.record'), async (req, res, next) => {
  const { godown, item_ids } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [inserted] = await conn.query(
      `INSERT INTO stock_counts (godown, count_date, started_by) VALUES (?, ?, ?)`,
      [godown || null, businessDay(), req.user.id]
    );
    const countId = inserted.insertId;

    // The system figure is snapshotted per line as the sheet opens, so the
    // variance recorded is the one the counter actually faced — not one
    // recomputed after the day's sales moved the cache underneath them.
    const scoped = Array.isArray(item_ids) && item_ids.length;
    const [items] = scoped
      ? await conn.query(
          'SELECT masterid, name, qty FROM items WHERE masterid IN (?) AND is_active = TRUE',
          [item_ids.map(Number)]
        )
      : await conn.query('SELECT masterid, name, qty FROM items WHERE is_active = TRUE');

    if (!items.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'No active items to count' });
    }

    for (const item of items) {
      await conn.query(
        `INSERT INTO stock_count_lines (count_id, item_id, item_name, system_qty)
         VALUES (?, ?, ?, ?)`,
        [countId, item.masterid, item.name, item.qty]
      );
    }

    await conn.commit();
    res.status(201).json({ message: 'Count opened', count_id: countId, lines: items.length });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// GET /api/stock-counts/:id
router.get('/:id', requirePermission('stock_count.view'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [[count]] = await pool.query('SELECT * FROM stock_counts WHERE id = ?', [id]);
    if (!count) return res.status(404).json({ error: 'No such count' });

    const [lines] = await pool.query(
      'SELECT * FROM stock_count_lines WHERE count_id = ? ORDER BY item_name',
      [id]
    );
    res.json({ count, lines });
  } catch (err) {
    next(err);
  }
});

// PUT /api/stock-counts/:id/lines
router.put('/:id/lines', requirePermission('stock_count.record'), async (req, res, next) => {
  const countId = Number(req.params.id);
  const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;

  if (!lines?.length) return res.status(400).json({ error: 'Send at least one counted line' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[count]] = await conn.query(
      'SELECT id, status FROM stock_counts WHERE id = ? FOR UPDATE',
      [countId]
    );
    if (!count) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such count' });
    }
    if (count.status === 'posted') {
      await conn.rollback();
      return res.status(409).json({ error: 'That count is already posted and cannot be edited' });
    }

    for (const line of lines) {
      const counted = line.counted_qty === null || line.counted_qty === '' ? null : qty(Number(line.counted_qty));
      if (counted !== null && (!Number.isFinite(counted) || counted < 0)) {
        await conn.rollback();
        return res.status(400).json({ error: 'A counted quantity cannot be negative' });
      }

      // Variance is computed against the snapshotted system figure, in SQL, so
      // the two can never be written out of step with each other.
      await conn.query(
        `UPDATE stock_count_lines
            SET counted_qty = ?, rack = COALESCE(?, rack),
                variance = CASE WHEN ? IS NULL THEN NULL ELSE ? - system_qty END
          WHERE count_id = ? AND item_id = ?`,
        [counted, line.rack || null, counted, counted, countId, Number(line.item_id)]
      );
    }

    await conn.commit();
    res.json({ message: 'Count updated' });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

// POST /api/stock-counts/:id/post — reconcile
router.post('/:id/post', requirePermission('stock_count.post'), async (req, res, next) => {
  const countId = Number(req.params.id);
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[count]] = await conn.query(
      'SELECT id, status, godown FROM stock_counts WHERE id = ? FOR UPDATE',
      [countId]
    );
    if (!count) {
      await conn.rollback();
      return res.status(404).json({ error: 'No such count' });
    }
    if (count.status === 'posted') {
      await conn.rollback();
      return res.status(409).json({ error: 'That count is already posted' });
    }

    // An uncounted line is not a zero — it means nobody looked. Posting one as
    // a variance would write off stock that is sitting on the rack.
    const [[open]] = await conn.query(
      'SELECT COUNT(*) AS n FROM stock_count_lines WHERE count_id = ? AND counted_qty IS NULL',
      [countId]
    );
    if (open.n > 0) {
      await conn.rollback();
      return res.status(409).json({
        error: `${open.n} line(s) are uncounted. A blank line is not a zero.`,
        code: 'INCOMPLETE',
      });
    }

    const [varied] = await conn.query(
      `SELECT item_id, item_name, system_qty, counted_qty, variance
         FROM stock_count_lines
        WHERE count_id = ? AND variance <> 0`,
      [countId]
    );

    for (const line of varied) {
      await moveStock(conn, {
        itemId: line.item_id,
        change: Number(line.variance),
        reason: 'adjustment',
        refType: 'stockcount',
        refId: countId,
        note: `Count ${countId}: ledger ${line.system_qty}, counted ${line.counted_qty}`,
        userId: req.user.id,
      });
    }

    await conn.query(
      "UPDATE stock_counts SET status = 'posted', posted_at = NOW() WHERE id = ?",
      [countId]
    );

    if (varied.length) {
      await notify(conn, {
        tone: 'warning',
        title: 'Stock count variance',
        body: `${count.godown || 'Godown'} — ${varied.length} line(s) differed from the ledger.`,
        actor: req.user.name,
        refType: 'stockcount',
        refId: countId,
      });
    }

    await conn.commit();
    res.json({ message: 'Count posted', adjustments: varied.length });
  } catch (err) {
    await conn.rollback();
    next(err);
  } finally {
    conn.release();
  }
});

module.exports = router;
