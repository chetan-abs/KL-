/**
 * Alerts — everyone's own.
 *
 *   GET   /api/notifications          the caller's alerts
 *   POST  /api/notifications/:id/read mark one read
 *   POST  /api/notifications/read-all mark the lot read
 *
 * Ungated beyond `authenticate`, on the same principle as the caller's own shift
 * actions: every route here is scoped to req.user.id by its WHERE clause, so
 * there is nothing a grant would add. A broadcast (user_id IS NULL) is visible
 * to everyone by design — it is how "billed below cost" reaches whoever is
 * looking.
 *
 * Nothing deletes. These rows are the record of what the business was told and
 * when, and a dismiss that loses that is worse than a long list.
 */
const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { numericId } = require('../middleware/params');

router.use(authenticate);

// Rejects a non-numeric :id before any handler binds it into SQL.
numericId(router);

// GET /api/notifications?unread=1&limit=50
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    // Interpolated, not bound: mysql2 sends a bound LIMIT as a string, which
    // MySQL rejects with a syntax error. Clamped to an integer above, so there
    // is nothing here for a caller to inject.
    const [rows] = await pool.query(
      `SELECT * FROM notifications
        WHERE (user_id = ? OR user_id IS NULL)
          ${req.query.unread ? 'AND is_read = FALSE' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit}`,
      [req.user.id]
    );

    const [[counts]] = await pool.query(
      `SELECT COUNT(*) AS unread FROM notifications
        WHERE (user_id = ? OR user_id IS NULL) AND is_read = FALSE`,
      [req.user.id]
    );

    res.json({ notifications: rows, unread: counts.unread });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE notifications SET is_read = TRUE
        WHERE id = ? AND (user_id = ? OR user_id IS NULL)`,
      [Number(req.params.id), req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'No such alert' });
    res.json({ message: 'Marked read' });
  } catch (err) {
    next(err);
  }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE notifications SET is_read = TRUE
        WHERE (user_id = ? OR user_id IS NULL) AND is_read = FALSE`,
      [req.user.id]
    );
    res.json({ message: 'All marked read', count: result.affectedRows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
