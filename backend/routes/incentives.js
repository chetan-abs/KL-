const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { userCan } = require('../utils/permissions');
const { businessDay } = require('../utils/businessDay');
const { notify } = require('../utils/workflow');
const { computePeriod, savePeriod, SLABS, PAYMENT_WINDOW_DAYS } = require('../utils/incentive');

router.use(authenticate);
numericId(router);

/**
 * The 20-segment salesman incentive.
 *
 * Source: KL_App_Requirements_FINAL.pdf section 9, rules R-18 and R-19.
 *
 * "Each salesman can view their incentive progress in real time — which
 * segments they have achieved, which are at risk, and the estimated total
 * payout." So the read is ungated for one's own figures and gated for
 * everyone's; a salesman who cannot see their own progress has an incentive
 * scheme that changes no behaviour.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const managesIncentives = (u) => userCan(u, 'incentives') || userCan(u, 'incentives.approve');

/**
 * The showroom pool.
 *
 * "Pulen and Prabal share a combined incentive pool on the same 20-segment
 * structure... The total earned incentive is split equally between the two."
 * Membership is a grant rather than a list of names, so replacing Pulen does
 * not mean editing this file.
 */
async function showroomPool(conn) {
  const [rows] = await conn.query(
    `SELECT id FROM users WHERE is_active = TRUE
       AND JSON_SEARCH(permissions, 'one', 'showroom') IS NOT NULL`);
  return rows.map((r) => r.id);
}

/** GET /api/incentives/segments — the twenty, with their targets. */
router.get('/segments', async (req, res, next) => {
  try {
    const [segments] = await pool.query(
      `SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.incentive_segment_id = s.id) AS item_count
         FROM incentive_segments WHERE is_active = TRUE ORDER BY seq`);
    const total = segments.reduce((a, s) => a + Number(s.base_incentive), 0);
    res.json({ segments, total_at_100: total, slabs: SLABS, payment_window_days: PAYMENT_WINDOW_DAYS });
  } catch (err) { next(err); }
});

/**
 * GET /api/incentives/:employeeId/:period — live progress.
 *
 * Recomputed on every read while the period is a draft. That is the point:
 * R-19 means an invoice ageing past 60 days REMOVES a sale from the
 * achievement, so a figure cached at month end would be wrong by the time
 * anybody looked at it.
 */
router.get('/:employeeId/:period', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { employeeId, period } = req.params;
    if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    if (employeeId !== req.user.id && !managesIncentives(req.user)) {
      return res.status(403).json({ error: 'That is somebody else\'s incentive.' });
    }

    const [[employee]] = await conn.query(
      'SELECT id, name, permissions FROM users WHERE id = ?', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const [[stored]] = await conn.query(
      'SELECT * FROM incentive_periods WHERE employee_id = ? AND period = ?', [employeeId, period]);

    // An approved period is what somebody is owed; it is read back as it
    // stands, never recomputed underneath them.
    if (stored && stored.status !== 'draft') {
      const [lines] = await conn.query(
        `SELECT l.*, s.name AS segment_name, s.target_kind
           FROM incentive_lines l JOIN incentive_segments s ON s.id = l.segment_id
          WHERE l.period_id = ? ORDER BY s.seq`, [stored.id]);
      return res.json({ employee, period: stored, lines, frozen: true });
    }

    const pool_ = await showroomPool(conn);
    const isShowroom = pool_.includes(employeeId);
    const computed = await computePeriod(conn, {
      employeeIds: isShowroom ? pool_ : [employeeId],
      period,
      isShowroom,
    });

    res.json({
      employee,
      period: { ...computed, status: stored?.status || 'draft' },
      lines: computed.lines,
      frozen: false,
      // "which segments they have achieved, which are at risk"
      at_risk: computed.lines.filter((l) => l.removed_unpaid > 0),
    });
  } catch (err) { next(err); } finally { conn.release(); }
});

/**
 * POST /api/incentives/:employeeId/:period/compute — freeze a draft.
 * The figures stop moving so Yash reviews a fixed number rather than one that
 * changes between opening the screen and approving it.
 */
router.post('/:employeeId/:period/compute',
  requirePermission('incentives.approve'), async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const { employeeId, period } = req.params;
      if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });

      await conn.beginTransaction();
      const pool_ = await showroomPool(conn);
      const isShowroom = pool_.includes(employeeId);
      const computed = await computePeriod(conn, {
        employeeIds: isShowroom ? pool_ : [employeeId], period, isShowroom });
      const id = await savePeriod(conn, { employeeId, period, computed });
      await conn.commit();
      res.json({ message: 'Computed.', period_id: id, ...computed });
    } catch (err) {
      await conn.rollback();
      if (err.code === 'PERIOD_LOCKED') return res.status(409).json({ error: err.message, code: err.code });
      next(err);
    } finally { conn.release(); }
  });

/**
 * POST /api/incentives/:id/approve — R-18.
 * "At month end, Yash reviews and approves the incentive calculations in the
 * application. Sibu processes the payout after approval."
 */
router.post('/:id/approve', requirePermission('incentives.approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query(
      'SELECT * FROM incentive_periods WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!p) { await conn.rollback(); return res.status(404).json({ error: 'Period not found' }); }
    if (p.status !== 'draft') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${p.status}.`, code: 'STALE' });
    }

    await conn.query(
      'UPDATE incentive_periods SET status = \'approved\', approved_by = ?, approved_at = NOW() WHERE id = ?',
      [req.user.id, p.id]);
    await notify(conn, {
      userId: p.employee_id, tone: 'success',
      title: `Incentive approved for ${p.period}`,
      body: `${Number(p.net_payout).toFixed(2)} payable.`,
      actor: req.user.id, refType: 'incentive_period', refId: p.id });
    await conn.commit();
    res.json({ message: 'Incentive approved.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/** POST /api/incentives/:id/pay — Sibu, after approval. R-18. */
router.post('/:id/pay', requirePermission('incentives.pay'), async (req, res, next) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM incentive_periods WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Period not found' });
    if (p.status !== 'approved') {
      return res.status(409).json({
        error: 'No incentive is payable until Yash has approved it.', code: 'NOT_APPROVED' });
    }
    await pool.query(
      'UPDATE incentive_periods SET status = \'paid\', paid_on = ? WHERE id = ?',
      [req.body.paid_on || businessDay(), p.id]);
    res.json({ message: 'Marked paid.' });
  } catch (err) { next(err); }
});

/** GET /api/incentives/register/:period — everyone, for the month. */
router.get('/register/:period', requirePermission('incentives.approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { period } = req.params;
    if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });

    // Anyone whose orders can earn: the salesmen and the showroom pair.
    const [staff] = await conn.query(
      `SELECT DISTINCT u.id, u.name FROM users u
        WHERE u.is_active = TRUE AND (
          JSON_SEARCH(u.permissions, 'one', 'showroom') IS NOT NULL
          OR EXISTS (SELECT 1 FROM orders o WHERE o.salesman_id = u.id))
        ORDER BY u.name`);

    const pool_ = await showroomPool(conn);
    const [stored] = await conn.query('SELECT * FROM incentive_periods WHERE period = ?', [period]);
    const byEmployee = new Map(stored.map((s) => [s.employee_id, s]));

    const rows = [];
    for (const s of staff) {
      const existing = byEmployee.get(s.id);
      if (existing && existing.status !== 'draft') {
        rows.push({ employee_id: s.id, name: s.name,
          net_payout: Number(existing.net_payout), status: existing.status, period_id: existing.id });
        continue;
      }
      const isShowroom = pool_.includes(s.id);
      const c = await computePeriod(conn, {
        employeeIds: isShowroom ? pool_ : [s.id], period, isShowroom });
      rows.push({ employee_id: s.id, name: s.name, net_payout: c.net_payout,
        status: existing?.status || 'draft', period_id: existing?.id || null });
    }

    res.json({ period, rows, total: rows.reduce((a, r) => a + r.net_payout, 0) });
  } catch (err) { next(err); } finally { conn.release(); }
});

module.exports = router;
