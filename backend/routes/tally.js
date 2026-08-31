const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { businessDay } = require('../utils/businessDay');
const { config, ping, doctor } = require('../utils/tally');
const {
  push, pullParties, pullItems, pullReconciliation,
} = require('../utils/tallySync');

router.use(authenticate);
numericId(router);

/**
 * Tally Prime sync — status, control and reconciliation.
 *
 * Source: KL_App_Requirements_FINAL.pdf section 14.
 *
 * Everything here is gated on the wildcard or `tally.manage`. The queue holds
 * every invoice, receipt and voucher in the business as raw XML, which makes it
 * a complete copy of the company's commercial position in one table — the
 * narrowest sensible audience for that is the owners and whoever administers
 * the integration.
 */

/**
 * GET /api/tally/status — is it working, and what is stuck?
 *
 * The first question anyone asks about a sync, and the one that is impossible
 * to answer from log files on a machine nobody can reach. `reachable` is
 * distinguished from a rejection throughout: "Tally is switched off" and "Tally
 * refused our invoice" need different people to do different things.
 */
router.get('/status', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const cfg = config();
    const health = await ping();

    const [queue] = await pool.query(
      `SELECT status, COUNT(*) AS n FROM tally_queue GROUP BY status`);
    const byStatus = Object.fromEntries(queue.map((q) => [q.status, Number(q.n)]));

    const [stuck] = await pool.query(
      `SELECT id, kind, ref_type, ref_id, attempts, last_error, enqueued_at
         FROM tally_queue
        WHERE status = 'failed' AND attempts >= 3
        ORDER BY attempts DESC, id ASC LIMIT 20`);

    const [runs] = await pool.query(
      `SELECT direction, scope, started_at, finished_at, ok_count, fail_count, reachable, note
         FROM tally_sync_runs ORDER BY id DESC LIMIT 10`);

    const [[variance]] = await pool.query(
      `SELECT COUNT(*) AS n FROM tally_reconciliation
        WHERE ABS(variance) > 0.0001 AND resolved_at IS NULL`);

    res.json({
      configuration: {
        enabled: cfg.enabled,
        host: `${cfg.host}:${cfg.port}`,
        company: cfg.company || null,
        // Said plainly, because a sync that is off and looks on is the worst
        // possible state for an accounting integration to be in.
        note: cfg.enabled
          ? (cfg.company ? null : 'TALLY_COMPANY is not set — nothing will import.')
          : 'TALLY_ENABLED is not true. Documents are queued but never sent.',
      },
      health,
      queue: {
        pending: byStatus.pending || 0,
        sending: byStatus.sending || 0,
        sent: byStatus.sent || 0,
        failed: byStatus.failed || 0,
        skipped: byStatus.skipped || 0,
      },
      stuck,
      recent_runs: runs,
      unresolved_variances: Number(variance.n),
    });
  } catch (err) { next(err); }
});

/**
 * GET /api/tally/doctor — the preflight, over HTTP.
 *
 * The same checks as `npm run tally -- --doctor`, for the case where whoever is
 * configuring Tally has a browser rather than a terminal. Every failure carries
 * a `fix` saying what to do, because the first run is the one part of section 14
 * that cannot be proved in advance and a failure that only says "failed" costs
 * an afternoon.
 */
router.get('/doctor', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    res.json(await doctor());
  } catch (err) { next(err); }
});

/** GET /api/tally/queue — the outbox, filterable. */
router.get('/queue', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const where = [];
    const params = [];
    if (req.query.status) { where.push('q.status = ?'); params.push(req.query.status); }
    if (req.query.kind) { where.push('q.kind = ?'); params.push(req.query.kind); }

    const [rows] = await pool.query(
      `SELECT q.id, q.kind, q.ref_type, q.ref_id, q.status, q.attempts, q.last_error,
              q.enqueued_at, q.sent_at, q.next_attempt_at, q.tally_master_id,
              u.name AS enqueued_by_name,
              LENGTH(q.payload) AS payload_bytes
         FROM tally_queue q
         LEFT JOIN users u ON u.id = q.enqueued_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY q.id DESC LIMIT 200`, params);
    res.json({ queue: rows });
  } catch (err) { next(err); }
});

/**
 * GET /api/tally/queue/:id/payload — the XML as it will be sent.
 *
 * The single most useful thing when Tally rejects a document: the envelope can
 * be pasted straight into curl against Tally and the error reproduced outside
 * the app.
 */
router.get('/queue/:id/payload', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      'SELECT kind, ref_type, ref_id, payload, last_error FROM tally_queue WHERE id = ?',
      [req.params.id]);
    if (!row) return res.status(404).json({ error: 'No such queue entry' });
    res.type('text/xml').send(row.payload);
  } catch (err) { next(err); }
});

/**
 * POST /api/tally/queue/:id/retry — clear the backoff and try again now.
 *
 * For the case the operator has just fixed: a ledger created in Tally, a
 * company name corrected. Resets `attempts` so the notification at five
 * failures is about five NEW failures rather than the old ones.
 */
router.post('/queue/:id/retry', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const [r] = await pool.query(
      `UPDATE tally_queue
          SET status = 'pending', next_attempt_at = NULL, attempts = 0, last_error = NULL
        WHERE id = ? AND status IN ('failed','skipped','sent')`,
      [req.params.id]);
    if (!r.affectedRows) {
      return res.status(409).json({
        error: 'That entry is not in a state that can be retried.', code: 'NOT_RETRYABLE' });
    }
    res.json({ message: 'Queued for the next push.' });
  } catch (err) { next(err); }
});

/** POST /api/tally/queue/retry-all — after Tally comes back up. */
router.post('/queue/retry-all', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const [r] = await pool.query(
      `UPDATE tally_queue
          SET status = 'pending', next_attempt_at = NULL, last_error = NULL
        WHERE status = 'failed'`);
    res.json({ message: `${r.affectedRows} document(s) queued for the next push.` });
  } catch (err) { next(err); }
});

/**
 * POST /api/tally/push — drain the outbox now.
 *
 * The worker does this on a timer. This is for the moment somebody has turned
 * Tally on and wants the morning's invoices in it without waiting.
 */
router.post('/push', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    res.json(await push(pool));
  } catch (err) { next(err); }
});

/**
 * POST /api/tally/pull — bring the masters in.
 *
 * Deliberately not on the fast timer: 7,000 parties and 7,300 items is a large
 * export, and nothing about a party master changes minute to minute.
 *
 * `scope` picks one, because on a first run somebody will want the parties in
 * before deciding whether the item import is going to do what they expect.
 */
router.post('/pull', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const cfg = config();
    if (!cfg.enabled) {
      return res.status(409).json({
        error: 'TALLY_ENABLED is not true.', code: 'TALLY_DISABLED' });
    }
    if (!cfg.company) {
      return res.status(409).json({
        error: 'TALLY_COMPANY is not set — Tally would answer "No Company" and import nothing.',
        code: 'NO_COMPANY',
      });
    }

    const scope = String(req.query.scope || req.body?.scope || 'all');
    const out = {};
    if (scope === 'all' || scope === 'parties') out.parties = await pullParties(pool);
    if (scope === 'all' || scope === 'items') out.items = await pullItems(pool);
    if (scope === 'all' || scope === 'reconciliation') {
      out.reconciliation = await pullReconciliation(pool);
    }
    res.json(out);
  } catch (err) { next(err); }
});

/**
 * GET /api/tally/reconciliation — where the two systems disagree.
 *
 * This is the honest half of "bidirectional sync" for a derived figure.
 * `items.qty` and `customers.closing_balance` are caches of OUR ledgers;
 * overwriting them from Tally would mean no number in the app could be
 * explained from its own movements again. So a pull compares, and a variance is
 * a question for a person.
 */
router.get('/reconciliation', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const day = req.query.as_at || businessDay();
    const onlyVariance = req.query.variance_only !== 'false';

    const [rows] = await pool.query(
      `SELECT r.*, u.name AS resolved_by_name
         FROM tally_reconciliation r
         LEFT JOIN users u ON u.id = r.resolved_by
        WHERE r.as_at = ?
          ${onlyVariance ? 'AND ABS(r.variance) > 0.0001' : ''}
        ORDER BY ABS(r.variance) DESC LIMIT 500`, [day]);

    res.json({
      as_at: day,
      variance_only: onlyVariance,
      rows,
      // Stated in the payload so nobody reading this screen assumes the app has
      // silently adopted Tally's figure.
      note: 'Neither figure is overwritten. items.qty and closing_balance remain '
        + 'caches of this app\'s own ledgers; a variance is a document one system '
        + 'has and the other does not.',
    });
  } catch (err) { next(err); }
});

/** POST /api/tally/reconciliation/:id/resolve — record what was decided. */
router.post('/reconciliation/:id/resolve', requirePermission('tally.manage'), async (req, res, next) => {
  try {
    const resolution = String(req.body?.resolution || '').trim();
    if (!resolution) {
      return res.status(400).json({
        error: 'Say what was done about it.', code: 'RESOLUTION_REQUIRED' });
    }
    const [r] = await pool.query(
      `UPDATE tally_reconciliation
          SET resolved_at = NOW(), resolved_by = ?, resolution = ?
        WHERE id = ? AND resolved_at IS NULL`,
      [req.user.id, resolution.slice(0, 255), req.params.id]);
    if (!r.affectedRows) {
      return res.status(409).json({
        error: 'That variance is already resolved, or does not exist.', code: 'STALE' });
    }
    res.json({ message: 'Resolved.' });
  } catch (err) { next(err); }
});

module.exports = router;
