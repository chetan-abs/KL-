const express = require('express');

const router = express.Router();
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { numericId } = require('../middleware/params');
const { userCan } = require('../utils/permissions');
const { businessDay } = require('../utils/businessDay');
const { money, notify, usersWithGrant, usersWhoCan } = require('../utils/workflow');
const {
  workingDates, computePeriod, applyWaivers, lateDeduction, SALARY_DIVISOR,
} = require('../utils/payroll');

router.use(authenticate);
numericId(router);

/**
 * Salary, advances and leave.
 *
 * Sources: the requirements addendum, sections A, B and C.6. Rules R-27
 * (advance approval), R-28 (auto-calculated deductions), R-29 (absent without
 * information), R-30 (salary paid only after approval).
 *
 * Two access patterns run through the whole module and they are deliberately
 * different:
 *
 *   `salary.manage`  sees and acts on everybody. Yash and Manoj.
 *   no grant at all  sees only their own — "This ledger is visible to Yash,
 *                    Manoj, and the employee themselves." Refusing an employee
 *                    their own payslip because they hold no grant would make
 *                    the feature useless to the twenty people it is for.
 *
 * `mine()` is what keeps the second from becoming the first.
 */

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The caller may act on everyone's records. */
const managesPayroll = (user) => userCan(user, 'salary') || userCan(user, 'salary.manage');

/**
 * Whose records this request is about, and whether the caller may have them.
 *
 * Returns the employee id, or null if the caller asked for somebody else's
 * without the grant to see it.
 */
function subject(req, param = 'employee_id') {
  const asked = req.params[param] || req.query[param] || req.body?.[param];
  if (!asked || asked === req.user.id) return req.user.id;
  return managesPayroll(req.user) ? asked : null;
}

const denied = (res) => res.status(403).json({ error: 'That is somebody else\'s record.' });

// ---------------------------------------------------------------------------
// Salary
// ---------------------------------------------------------------------------

/**
 * GET /api/payroll/salary/:employeeId/:period
 *
 * The month's ledger. A draft is recomputed from attendance on every read —
 * the month is still running and a punch this morning changes it. Once
 * finalised the stored figures are returned as they stand, with waivers
 * applied, because from that point they are what somebody was paid.
 */
router.get('/salary/:employeeId/:period', async (req, res, next) => {
  try {
    const { employeeId, period } = req.params;
    if (!PERIOD_RE.test(period)) {
      return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    }
    if (employeeId !== req.user.id && !managesPayroll(req.user)) return denied(res);

    const [[employee]] = await pool.query(
      'SELECT id, name, fixed_salary, shift_code FROM users WHERE id = ?', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const [[stored]] = await pool.query(
      'SELECT * FROM salary_periods WHERE employee_id = ? AND period = ?', [employeeId, period]);

    if (stored && stored.status !== 'draft') {
      const [lines] = await pool.query(
        `SELECT d.*, u.name AS waived_by_name
           FROM salary_deductions d LEFT JOIN users u ON u.id = d.waived_by
          WHERE d.period_id = ? ORDER BY d.kind, d.on_date`,
        [stored.id]);
      return res.json({
        employee, period: stored, lines, ...applyWaivers(stored, lines), frozen: true,
      });
    }

    const computed = await recompute(pool, employee, period);
    res.json({ employee, period: { ...computed, status: stored?.status || 'draft' },
      lines: computed.lines, frozen: false });
  } catch (err) { next(err); }
});

/**
 * Derive a month from attendance. Reads nothing it does not need and writes
 * nothing at all — the caller decides whether to persist.
 */
async function recompute(db, employee, period) {
  const [year, month] = period.split('-');
  const from = `${period}-01`;
  const to = new Date(Date.UTC(Number(year), Number(month), 1)).toISOString().slice(0, 10);

  const [holidayRows] = await db.query(
    'SELECT holiday_date FROM holidays WHERE holiday_date >= ? AND holiday_date < ?', [from, to]);
  const holidays = new Set(holidayRows.map((h) => String(h.holiday_date).slice(0, 10)));

  const [checkins] = await db.query(
    `SELECT checkin_date, is_late, is_half_day FROM checkins
      WHERE employee_id = ? AND checkin_date >= ? AND checkin_date < ?`,
    [employee.id, from, to]);

  // Approved leave, expanded to the individual dates it covers. A request
  // spanning a month boundary contributes only the days inside this month.
  const [leaves] = await db.query(
    `SELECT from_date, to_date FROM leave_requests
      WHERE employee_id = ? AND status = 'approved' AND from_date < ? AND to_date >= ?`,
    [employee.id, to, from]);
  const leaveDates = new Set();
  for (const l of leaves) {
    for (let d = new Date(`${String(l.from_date).slice(0, 10)}T00:00:00Z`);
      d <= new Date(`${String(l.to_date).slice(0, 10)}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1)) {
      leaveDates.add(d.toISOString().slice(0, 10));
    }
  }

  // Advances still owing, with what has already come off them.
  const [advances] = await db.query(
    `SELECT a.id, a.amount, a.monthly_amount, a.starts_month,
            COALESCE((SELECT SUM(r.amount) FROM advance_recoveries r WHERE r.advance_id = a.id), 0) AS recovered,
            EXISTS(SELECT 1 FROM advance_recoveries r WHERE r.advance_id = a.id AND r.period = ?) AS taken_this_month
       FROM advances a
      WHERE a.employee_id = ? AND a.status = 'approved'
        AND (a.starts_month IS NULL OR a.starts_month <= ?)`,
    [period, employee.id, period]);

  return computePeriod({
    employee,
    period,
    dates: workingDates(period, holidays),
    checkins,
    leaveDates,
    // A month already recovered keeps its instalment in the total rather than
    // taking a second one: the recovery row is the record that it happened.
    advances: advances.map((a) => ({ ...a, recovered: Number(a.recovered) })),
  });
}

/**
 * POST /api/payroll/salary/:employeeId/:period/finalise
 *
 * Freeze the month: write the deduction lines so they can be waived
 * individually, and stop recomputing. Reversible only by an admin deleting
 * the period, which is deliberately not a route.
 */
router.post('/salary/:employeeId/:period/finalise',
  requirePermission('salary.manage'), async (req, res, next) => {
    const conn = await pool.getConnection();
    try {
      const { employeeId, period } = req.params;
      if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });

      await conn.beginTransaction();
      const [[employee]] = await conn.query(
        'SELECT id, name, fixed_salary FROM users WHERE id = ? FOR UPDATE', [employeeId]);
      if (!employee) { await conn.rollback(); return res.status(404).json({ error: 'Employee not found' }); }

      const [[existing]] = await conn.query(
        'SELECT id, status FROM salary_periods WHERE employee_id = ? AND period = ?', [employeeId, period]);
      if (existing && existing.status !== 'draft') {
        await conn.rollback();
        return res.status(409).json({ error: `That month is already ${existing.status}.`, code: 'ALREADY_FINALISED' });
      }

      const c = await recompute(conn, employee, period);

      let periodId = existing?.id;
      if (periodId) {
        await conn.query(
          `UPDATE salary_periods SET fixed_salary=?, daily_rate=?, working_days=?, days_present=?,
             days_late=?, half_days=?, days_absent_informed=?, days_absent_uninformed=?,
             attendance_deduction=?, advance_deduction=?, net_payable=?, status='finalised'
           WHERE id = ?`,
          [c.fixed_salary, c.daily_rate, c.working_days, c.days_present, c.days_late,
            c.half_days, c.days_absent_informed, c.days_absent_uninformed,
            c.attendance_deduction, c.advance_deduction, c.net_payable, periodId]);
        await conn.query('DELETE FROM salary_deductions WHERE period_id = ?', [periodId]);
      } else {
        const [r] = await conn.query(
          `INSERT INTO salary_periods
             (employee_id, period, fixed_salary, daily_rate, working_days, days_present,
              days_late, half_days, days_absent_informed, days_absent_uninformed,
              attendance_deduction, advance_deduction, net_payable, status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'finalised')`,
          [employeeId, period, c.fixed_salary, c.daily_rate, c.working_days, c.days_present,
            c.days_late, c.half_days, c.days_absent_informed, c.days_absent_uninformed,
            c.attendance_deduction, c.advance_deduction, c.net_payable]);
        periodId = r.insertId;
      }

      for (const l of c.lines) {
        await conn.query(
          'INSERT INTO salary_deductions (period_id, kind, on_date, detail, amount) VALUES (?,?,?,?,?)',
          [periodId, l.kind, l.on_date, l.detail, l.amount]);
        // The recovery row is what stops the same instalment being taken
        // again next time this month is finalised.
        if (l.kind === 'advance' && l.advance_id) {
          await conn.query(
            `INSERT INTO advance_recoveries (advance_id, period, amount) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE amount = VALUES(amount)`,
            [l.advance_id, period, l.amount]);
          // An advance fully recovered is closed, so it stops appearing on
          // next month's ledger.
          await conn.query(
            `UPDATE advances a SET a.status = 'closed'
              WHERE a.id = ? AND a.amount <= (
                SELECT COALESCE(SUM(r.amount),0) FROM advance_recoveries r WHERE r.advance_id = a.id)`,
            [l.advance_id]);
        }
      }

      await conn.commit();
      res.json({ message: `${period} finalised for ${employee.name}.`, period_id: periodId, ...c });
    } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
  });

/**
 * POST /api/payroll/deductions/:id/waive — R-28.
 * "Yash may manually waive any deduction with a reason. The waiver is logged."
 * The line survives at its full amount and stops counting; deleting it would
 * erase that it was earned.
 */
router.post('/deductions/:id/waive', requirePermission('salary.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A waiver needs a reason.', code: 'REASON_REQUIRED' });
    }
    await conn.beginTransaction();
    const [[line]] = await conn.query(
      `SELECT d.*, p.status, p.id AS pid FROM salary_deductions d
         JOIN salary_periods p ON p.id = d.period_id WHERE d.id = ? FOR UPDATE`, [req.params.id]);
    if (!line) { await conn.rollback(); return res.status(404).json({ error: 'Deduction not found' }); }
    if (['approved', 'paid'].includes(line.status)) {
      await conn.rollback();
      return res.status(409).json({
        error: 'That month is already approved — a waiver now would not change what was paid.',
        code: 'PERIOD_CLOSED',
      });
    }

    await conn.query(
      'UPDATE salary_deductions SET waived = TRUE, waive_reason = ?, waived_by = ?, waived_at = NOW() WHERE id = ?',
      [String(reason).trim(), req.user.id, req.params.id]);

    await retotal(conn, line.pid);
    await conn.commit();
    res.json({ message: 'Deduction waived.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/** Re-add a period's live deduction lines after a waiver. */
async function retotal(conn, periodId) {
  const [[p]] = await conn.query('SELECT * FROM salary_periods WHERE id = ?', [periodId]);
  const [lines] = await conn.query('SELECT * FROM salary_deductions WHERE period_id = ?', [periodId]);
  const t = applyWaivers(p, lines);
  await conn.query(
    'UPDATE salary_periods SET attendance_deduction=?, advance_deduction=?, net_payable=? WHERE id=?',
    [t.attendance_deduction, t.advance_deduction, t.net_payable, periodId]);
  return t;
}

/**
 * POST /api/payroll/salary/:id/approve — R-30.
 * "The net payable salary for each employee each month is reviewed and
 * approved by Yash before any payout is processed."
 */
router.post('/salary/:id/approve', requirePermission('salary.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query('SELECT * FROM salary_periods WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!p) { await conn.rollback(); return res.status(404).json({ error: 'Period not found' }); }
    if (p.status === 'draft') {
      await conn.rollback();
      return res.status(409).json({ error: 'Finalise the month before approving it.', code: 'NOT_FINALISED' });
    }
    if (p.status !== 'finalised') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${p.status}.`, code: 'STALE' });
    }

    await conn.query(
      'UPDATE salary_periods SET status = \'approved\', approved_by = ?, approved_at = NOW() WHERE id = ?',
      [req.user.id, p.id]);
    await notify(conn, {
      userId: p.employee_id, tone: 'success',
      title: `Salary approved for ${p.period}`,
      body: `Net payable ${Number(p.net_payable).toFixed(2)}.`,
      actor: req.user.id, refType: 'salary_period', refId: p.id });
    await conn.commit();
    res.json({ message: 'Salary approved.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/** POST /api/payroll/salary/:id/pay — records that it went out, and when. */
router.post('/salary/:id/pay', requirePermission('salary.manage'), async (req, res, next) => {
  try {
    const [[p]] = await pool.query('SELECT * FROM salary_periods WHERE id = ?', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Period not found' });
    if (p.status !== 'approved') {
      return res.status(409).json({
        error: 'Only an approved salary can be marked paid.', code: 'NOT_APPROVED' });
    }
    await pool.query(
      'UPDATE salary_periods SET status = \'paid\', paid_on = ? WHERE id = ?',
      [req.body.paid_on || businessDay(), p.id]);
    res.json({ message: 'Marked paid.' });
  } catch (err) { next(err); }
});

/**
 * GET /api/payroll/slip/:employeeId/:period — the salary slip of A.2.
 *
 * "It shows: Employee name, month, fixed salary, itemised deductions (advance
 *  recovery, late deductions, half-day deductions, absence deductions), and net
 *  payable amount."
 *
 * Returned as structured data plus a plain-text rendering, not as a PDF. The
 * text form is what A.2's "share the salary slip with the employee directly
 * through the application" needs — it goes into a message. A PDF would need a
 * renderer this project does not have; that gap is recorded in
 * docs/requirements-implementation-2026-08-31.md rather than papered over.
 *
 * Only a FINALISED month has a slip. A draft recomputes on every read, so a
 * slip taken from one would be a different document tomorrow — and a payslip
 * that changes after it is issued is worse than none.
 */
router.get('/slip/:employeeId/:period', async (req, res, next) => {
  try {
    const { employeeId, period } = req.params;
    if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    if (employeeId !== req.user.id && !managesPayroll(req.user)) return denied(res);

    const [[row]] = await pool.query(
      `SELECT p.*, u.name AS employee_name, u.shift_code, a.name AS approved_by_name
         FROM salary_periods p
         JOIN users u ON u.id = p.employee_id
         LEFT JOIN users a ON a.id = p.approved_by
        WHERE p.employee_id = ? AND p.period = ?`, [employeeId, period]);

    if (!row) {
      return res.status(404).json({
        error: 'No slip for that month yet — the month has not been finalised.',
        code: 'NOT_FINALISED',
      });
    }
    if (row.status === 'draft') {
      return res.status(409).json({
        error: 'That month is still a draft. Finalise it before issuing a slip.',
        code: 'NOT_FINALISED',
      });
    }

    const [lines] = await pool.query(
      `SELECT kind, on_date, detail, amount, waived, waive_reason
         FROM salary_deductions WHERE period_id = ?
        ORDER BY FIELD(kind,'late','half_day','absent_informed','absent_uninformed','advance','other'),
                 on_date`, [row.id]);

    const live = lines.filter((l) => !l.waived);
    const totals = applyWaivers(row, lines);

    // Grouped the way A.2 itemises them, so the slip reads as the document the
    // employee is owed rather than as a table dump.
    const groups = {};
    for (const l of live) {
      groups[l.kind] = groups[l.kind] || { count: 0, amount: 0 };
      groups[l.kind].count += 1;
      groups[l.kind].amount = Math.round((groups[l.kind].amount + Number(l.amount)) * 100) / 100;
    }

    const LABELS = {
      late: 'Late arrivals',
      half_day: 'Half days',
      absent_informed: 'Absent (leave approved)',
      absent_uninformed: 'Absent without information',
      advance: 'Advance recovery',
      other: 'Other deductions',
    };

    const money = (n) => Number(n).toFixed(2);
    const text = [
      'K.L. ELECTRICALS — SALARY SLIP',
      `${row.employee_name}   ${period}`,
      ''.padEnd(38, '-'),
      `Fixed salary${money(row.fixed_salary).padStart(26 - 0)}`,
      '',
      ...Object.entries(groups).map(([kind, g]) =>
        `${(LABELS[kind] || kind)} (${g.count})`.padEnd(26) + money(g.amount).padStart(12)),
      ''.padEnd(38, '-'),
      'Total deductions'.padEnd(26)
        + money(totals.attendance_deduction + totals.advance_deduction + totals.other_deduction).padStart(12),
      'NET PAYABLE'.padEnd(26) + money(totals.net_payable).padStart(12),
      ''.padEnd(38, '-'),
      `Working days ${row.working_days}   Present ${row.days_present}   `
        + `Late ${row.days_late}   Half ${row.half_days}   Absent ${Number(row.days_absent_informed) + Number(row.days_absent_uninformed)}`,
      row.status === 'paid' ? `Paid on ${row.paid_on}` : `Status: ${row.status}`,
    ].join('\n');

    res.json({
      employee: { id: employeeId, name: row.employee_name, shift: row.shift_code },
      period,
      fixed_salary: Number(row.fixed_salary),
      daily_rate: Number(row.daily_rate),
      attendance: {
        working_days: row.working_days,
        present: row.days_present,
        late: row.days_late,
        half_days: row.half_days,
        absent_informed: row.days_absent_informed,
        absent_uninformed: row.days_absent_uninformed,
      },
      deductions: Object.entries(groups).map(([kind, g]) => ({
        kind, label: LABELS[kind] || kind, count: g.count, amount: g.amount,
      })),
      waived: lines.filter((l) => l.waived).map((l) => ({
        detail: l.detail, amount: Number(l.amount), reason: l.waive_reason,
      })),
      ...totals,
      status: row.status,
      paid_on: row.paid_on,
      approved_by: row.approved_by_name,
      slip_shared_at: row.slip_shared_at,
      text,
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/payroll/slip/:id/share — A.2.
 *
 * "Yash can share the salary slip with the employee directly through the
 *  application."
 *
 * Sharing is an in-app notification carrying the slip, which is what section 13
 * says the app does: "All notifications are delivered within the application
 * only. No SMS or external WhatsApp messages are sent to staff." The stamp is
 * recorded so "I never got my slip" has an answer either way.
 */
router.post('/slip/:id/share', requirePermission('salary.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[row]] = await conn.query(
      'SELECT * FROM salary_periods WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!row) { await conn.rollback(); return res.status(404).json({ error: 'Period not found' }); }
    if (row.status === 'draft') {
      await conn.rollback();
      return res.status(409).json({
        error: 'Finalise the month before sharing a slip.', code: 'NOT_FINALISED' });
    }

    await conn.query(
      'UPDATE salary_periods SET slip_shared_at = NOW(), slip_shared_by = ? WHERE id = ?',
      [req.user.id, row.id]);

    await notify(conn, {
      userId: row.employee_id,
      tone: 'info',
      title: `Salary slip for ${row.period}`,
      body: `Net payable ${Number(row.net_payable).toFixed(2)}. Open your salary screen for the breakdown.`,
      actor: req.user.id,
      refType: 'salary_period',
      refId: row.id,
    });

    await conn.commit();
    res.json({ message: 'Slip shared.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/** GET /api/payroll/register/:period — every employee's month, for Yash. */
router.get('/register/:period', requirePermission('salary.manage'), async (req, res, next) => {
  try {
    const { period } = req.params;
    if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });

    const [staff] = await pool.query(
      'SELECT id, name, fixed_salary, shift_code FROM users WHERE is_active = TRUE ORDER BY name');
    const [stored] = await pool.query('SELECT * FROM salary_periods WHERE period = ?', [period]);
    const byEmployee = new Map(stored.map((s) => [s.employee_id, s]));

    const rows = [];
    let total = 0;
    for (const s of staff) {
      const existing = byEmployee.get(s.id);
      const row = existing && existing.status !== 'draft'
        ? existing
        : await recompute(pool, s, period);
      total = money(total + Number(row.net_payable));
      rows.push({
        employee_id: s.id, name: s.name, fixed_salary: Number(s.fixed_salary),
        attendance_deduction: Number(row.attendance_deduction),
        advance_deduction: Number(row.advance_deduction),
        net_payable: Number(row.net_payable),
        status: existing?.status || 'draft',
        period_id: existing?.id || null,
      });
    }
    res.json({ period, rows, total_payable: total, divisor: SALARY_DIVISOR });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Advances — section B
// ---------------------------------------------------------------------------

/**
 * POST /api/payroll/advances — request one.
 * "An employee or Yash can initiate an advance request." Anyone may ask for
 * themselves; asking on somebody else's behalf needs the grant.
 */
router.post('/advances', async (req, res, next) => {
  try {
    const employeeId = subject(req);
    if (!employeeId) return denied(res);

    const amount = money(Number(req.body.amount));
    const months = Number(req.body.months);
    if (!(amount > 0)) return res.status(400).json({ error: 'The amount must be greater than zero.' });
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      return res.status(400).json({ error: 'Repayment must be between 1 and 24 months.' });
    }

    // Held rather than divided on read: the last instalment absorbs the
    // rounding, so a 6,000 advance over 7 months does not leave 0.02
    // outstanding for ever.
    const monthly = money(amount / months);

    const [r] = await pool.query(
      `INSERT INTO advances (employee_id, amount, months, monthly_amount, reason, requested_by, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [employeeId, amount, months, monthly, req.body.reason || null, req.user.id]);

    const conn = await pool.getConnection();
    try {
      for (const boss of await usersWhoCan(conn, 'salary.manage')) {
        await notify(conn, {
          userId: boss, tone: 'info', title: 'Advance requested',
          body: `${amount.toFixed(2)} over ${months} month(s).`,
          actor: req.user.id, refType: 'advance', refId: r.insertId });
      }
    } finally { conn.release(); }

    res.status(201).json({ message: 'Advance requested.', id: r.insertId, monthly_amount: monthly });
  } catch (err) { next(err); }
});

/**
 * POST /api/payroll/advances/:id/decide — R-27.
 * "No advance can be disbursed without in-app approval from Yash or Manoj."
 */
router.post('/advances/:id/decide', requirePermission('salary.manage'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const approve = req.body.approve === true || req.body.approve === 'true';
    await conn.beginTransaction();
    const [[adv]] = await conn.query('SELECT * FROM advances WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!adv) { await conn.rollback(); return res.status(404).json({ error: 'Advance not found' }); }
    if (adv.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${adv.status}.`, code: 'STALE' });
    }
    // R-15's sibling: nobody approves their own money.
    if (adv.employee_id === req.user.id) {
      await conn.rollback();
      return res.status(403).json({
        error: 'An advance cannot be approved by the person taking it.', code: 'SELF_APPROVAL' });
    }

    // Recovery starts the month after approval unless told otherwise, so an
    // advance taken on the 28th is not recovered from the salary it was
    // advanced against.
    const starts = req.body.starts_month || nextMonth(businessDay());

    await conn.query(
      'UPDATE advances SET status = ?, approved_by = ?, approved_at = NOW(), starts_month = ? WHERE id = ?',
      [approve ? 'approved' : 'rejected', req.user.id, approve ? starts : null, adv.id]);

    await notify(conn, {
      userId: adv.employee_id, tone: approve ? 'success' : 'warning',
      title: approve ? 'Advance approved' : 'Advance declined',
      body: approve
        ? `${Number(adv.amount).toFixed(2)} — ${Number(adv.monthly_amount).toFixed(2)} a month from ${starts}.`
        : 'Speak to Yash if you need to discuss it.',
      actor: req.user.id, refType: 'advance', refId: adv.id });

    await conn.commit();
    res.json({ message: approve ? 'Advance approved.' : 'Advance declined.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

const nextMonth = (day) => {
  const [y, m] = day.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * GET /api/payroll/advances — the Advance Register (B.2) for a manager, or
 * the caller's own ledger otherwise.
 */
router.get('/advances', async (req, res, next) => {
  try {
    const all = managesPayroll(req.user) && req.query.scope !== 'mine';
    const params = all ? [] : [req.user.id];
    const [rows] = await pool.query(
      `SELECT a.*, u.name AS employee_name,
              COALESCE((SELECT SUM(r.amount) FROM advance_recoveries r WHERE r.advance_id = a.id), 0) AS recovered
         FROM advances a JOIN users u ON u.id = a.employee_id
        ${all ? '' : 'WHERE a.employee_id = ?'}
        ORDER BY a.created_at DESC`, params);

    res.json({
      advances: rows.map((a) => {
        const recovered = money(a.recovered);
        const balance = money(Number(a.amount) - recovered);
        return {
          ...a,
          recovered,
          balance,
          months_remaining: Number(a.monthly_amount) > 0
            ? Math.ceil(balance / Number(a.monthly_amount)) : 0,
        };
      }),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// Leave — section C.6
// ---------------------------------------------------------------------------

/**
 * POST /api/payroll/leave — apply.
 *
 * An approved leave day is the difference between one day's pay and two
 * (R-29), which is why applying is ungated: an employee who cannot file a
 * request is charged double for a day they told somebody about.
 */
router.post('/leave', async (req, res, next) => {
  try {
    const { from_date, to_date, reason } = req.body;
    const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
    if (!isDay(from_date) || !isDay(to_date)) {
      return res.status(400).json({ error: 'Give the dates as YYYY-MM-DD.' });
    }
    if (to_date < from_date) {
      return res.status(400).json({ error: 'The last day cannot be before the first.' });
    }
    const employeeId = subject(req);
    if (!employeeId) return denied(res);

    const [r] = await pool.query(
      'INSERT INTO leave_requests (employee_id, from_date, to_date, reason) VALUES (?, ?, ?, ?)',
      [employeeId, from_date, to_date, reason || null]);

    const conn = await pool.getConnection();
    try {
      for (const approver of await usersWhoCan(conn, 'leave.approve')) {
        await notify(conn, {
          userId: approver, tone: 'info', title: 'Leave requested',
          body: `${from_date}${to_date !== from_date ? ` to ${to_date}` : ''}${reason ? ` — ${reason}` : ''}`,
          actor: req.user.id, refType: 'leave', refId: r.insertId });
      }
    } finally { conn.release(); }

    res.status(201).json({ message: 'Leave requested.', id: r.insertId });
  } catch (err) { next(err); }
});

/** GET /api/payroll/leave — mine, or everyone's for an approver. */
router.get('/leave', async (req, res, next) => {
  try {
    const canApprove = userCan(req.user, 'leave') || userCan(req.user, 'leave.approve');
    const all = canApprove && req.query.scope !== 'mine';
    const where = [];
    const params = [];
    if (!all) { where.push('l.employee_id = ?'); params.push(req.user.id); }
    if (req.query.status) { where.push('l.status = ?'); params.push(req.query.status); }

    const [rows] = await pool.query(
      `SELECT l.*, u.name AS employee_name, d.name AS decided_by_name
         FROM leave_requests l
         JOIN users u ON u.id = l.employee_id
         LEFT JOIN users d ON d.id = l.decided_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY l.from_date DESC, l.id DESC LIMIT 200`, params);
    res.json({ leave: rows });
  } catch (err) { next(err); }
});

/** POST /api/payroll/leave/:id/decide — Manas for Shift A, Yash for seniors. */
router.post('/leave/:id/decide', requirePermission('leave.approve'), async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const approve = req.body.approve === true || req.body.approve === 'true';
    await conn.beginTransaction();
    const [[l]] = await conn.query('SELECT * FROM leave_requests WHERE id = ? FOR UPDATE', [req.params.id]);
    if (!l) { await conn.rollback(); return res.status(404).json({ error: 'Request not found' }); }
    if (l.status !== 'pending') {
      await conn.rollback();
      return res.status(409).json({ error: `Already ${l.status}.`, code: 'STALE' });
    }
    if (l.employee_id === req.user.id) {
      await conn.rollback();
      return res.status(403).json({ error: 'Nobody approves their own leave.', code: 'SELF_APPROVAL' });
    }

    await conn.query(
      `UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = NOW(), decision_note = ?
        WHERE id = ?`,
      [approve ? 'approved' : 'rejected', req.user.id, req.body.note || null, l.id]);

    await notify(conn, {
      userId: l.employee_id, tone: approve ? 'success' : 'warning',
      title: approve ? 'Leave approved' : 'Leave declined',
      body: `${l.from_date}${String(l.to_date) !== String(l.from_date) ? ` to ${l.to_date}` : ''}`,
      actor: req.user.id, refType: 'leave', refId: l.id });

    await conn.commit();
    res.json({ message: approve ? 'Leave approved.' : 'Leave declined.' });
  } catch (err) { await conn.rollback(); next(err); } finally { conn.release(); }
});

/**
 * GET /api/payroll/attendance-summary/:employeeId/:period — section C.5.
 * The figures that feed the salary ledger, on their own.
 */
router.get('/attendance-summary/:employeeId/:period', async (req, res, next) => {
  try {
    const { employeeId, period } = req.params;
    if (!PERIOD_RE.test(period)) return res.status(400).json({ error: 'Period must be YYYY-MM.' });
    if (employeeId !== req.user.id && !managesPayroll(req.user)
        && !userCan(req.user, 'attendance.view')) return denied(res);

    const [[employee]] = await pool.query(
      'SELECT id, name, fixed_salary, shift_code FROM users WHERE id = ?', [employeeId]);
    if (!employee) return res.status(404).json({ error: 'Employee not found' });

    const c = await recompute(pool, employee, period);
    res.json({
      employee,
      period,
      working_days: c.working_days,
      days_present: c.days_present,
      days_late: c.days_late,
      half_days: c.half_days,
      days_absent_informed: c.days_absent_informed,
      days_absent_uninformed: c.days_absent_uninformed,
      extra_days: c.extra_days,
      daily_rate: c.daily_rate,
      late_deduction: lateDeduction(c.days_late),
      total_deduction: c.attendance_deduction,
    });
  } catch (err) { next(err); }
});

module.exports = router;
