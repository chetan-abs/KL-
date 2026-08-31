const express = require('express');
const pool = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { businessDay, requestedDay } = require('../utils/businessDay');
const { notify, usersWithGrant, usersWhoCan } = require('../utils/workflow');
const {
  judgeCheckIn, judgeCheckOut, workedMinutes, distanceMetres, isAbsentYet,
} = require('../utils/payroll');

const router = express.Router();

// Two kinds of route live here and they are not guarded alike.
//
// /today, /checkin, /checkout and the lunch pair act on the caller's own
// employee-day and are how every field employee starts a shift — the navigator
// calls /today for each user at launch. They take authenticate only. Putting
// 'attendance.view' in front of them would lock ordinary staff out of checking
// in, which is the one thing the app exists to do.
//
// Everything below reads or writes other people's records, so it is gated on
// the attendance grants the employee form hands out.
router.use(authenticate);

// A shift event is a handful of taps a day per person. This ceiling is far
// above real use and only exists so a client stuck in a retry loop cannot
// hammer the table.
const shiftWrites = rateLimit({ max: 30, windowMs: 60_000 });

/**
 * Every shift event writes two rows — the checkins update and the location fix
 * that evidences it — and they belong together. They used to be two separate
 * pool queries, so a failure between them left a check-in with no fix.
 */
async function withTransaction(run) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await run(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function readFix(body) {
  const latitude = Number(body?.latitude);
  const longitude = Number(body?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

async function currentRow(conn, employeeId, day) {
  const [[row]] = await conn.query(
    'SELECT * FROM checkins WHERE employee_id = ? AND checkin_date = ?',
    [employeeId, day]
  );
  return row || null;
}

/**
 * R-24 — "The check-in is not recorded until the employee takes and uploads a
 * photograph at check-in time. GPS coordinates are automatically embedded.
 * This cannot be bypassed."
 *
 * The photograph is uploaded first through /api/attachments and its id passed
 * here, which is the same two-step the delivery proof uses. Checked against
 * the attachments table rather than trusted: an id the caller invented would
 * otherwise satisfy a mandatory-photo rule with no photograph.
 *
 * Ownership is checked too. A shared id would let one employee punch in on
 * another's photograph, which is the exact substitution the rule exists to
 * prevent.
 */
async function readPhoto(conn, photoId, userId) {
  if (!photoId) {
    return { error: 'A photograph is required. Take one and try again.', code: 'PHOTO_REQUIRED' };
  }
  const [[att]] = await conn.query(
    'SELECT id, uploaded_by FROM attachments WHERE id = ?', [Number(photoId)]);
  if (!att) return { error: 'That photograph was not found.', code: 'PHOTO_NOT_FOUND' };
  if (att.uploaded_by !== userId) {
    return { error: 'That photograph belongs to somebody else.', code: 'PHOTO_NOT_YOURS' };
  }
  return { id: att.id };
}

/** The caller's shift, with its timings. Null for staff not assigned to one. */
async function shiftFor(conn, userId) {
  const [[row]] = await conn.query(
    `SELECT s.* FROM users u JOIN shifts s ON s.code = u.shift_code
      WHERE u.id = ? AND s.is_active = TRUE`, [userId]);
  return row || null;
}

/**
 * "For showroom and godown staff, check-in must occur within a reasonable
 * proximity of the workplace. The application flags if check-in occurs at an
 * unusual location. For field salesmen the check-in location is recorded but
 * not geofenced." (C.2)
 *
 * A flag, never a block: a genuine reason to start the day elsewhere is common
 * enough that refusing would stop the day rather than start it, and the
 * employee has no way to argue with a refusal at 10:02.
 */
async function judgeLocation(conn, userId, fix) {
  const [[user]] = await conn.query('SELECT geofenced FROM users WHERE id = ?', [userId]);
  if (!user?.geofenced) return { flagged: false, note: null };

  const [sites] = await conn.query(
    'SELECT name, latitude, longitude, radius_m FROM workplaces WHERE is_active = TRUE');
  // No workplace on file is not a reason to flag everybody — it is a reason to
  // flag nobody until the coordinates are entered.
  if (!sites.length) return { flagged: false, note: null };

  let nearest = null;
  for (const s of sites) {
    const d = distanceMetres(fix.latitude, fix.longitude, s.latitude, s.longitude);
    if (d === null) continue;
    if (!nearest || d < nearest.d) nearest = { d, s };
  }
  if (!nearest) return { flagged: false, note: null };
  if (nearest.d <= nearest.s.radius_m) return { flagged: false, note: `${nearest.d} m from ${nearest.s.name}` };
  return { flagged: true, note: `${nearest.d} m from ${nearest.s.name}` };
}

router.get('/today', async (req, res) => {
  const today = businessDay();
  const [[row]] = await pool.query(
    'SELECT * FROM checkins WHERE employee_id = ? AND checkin_date = ?',
    [req.user.id, today]
  );
  res.json({ checkin: row || null, businessDate: today });
});

router.post('/checkin', shiftWrites, async (req, res) => {
  const fix = readFix(req.body);
  if (!fix) {
    return res.status(400).json({ error: 'A valid latitude and longitude are required' });
  }
  const today = businessDay();

  try {
    const result = await withTransaction(async (conn) => {
      // R-24 first: the punch is not recorded at all without the photograph,
      // so nothing else is worth computing until it is there.
      const photo = await readPhoto(conn, req.body.photo_id, req.user.id);
      if (photo.error) return { reject: { status: 400, body: photo } };

      const shift = await shiftFor(conn, req.user.id);
      const now = new Date();
      const { isLate, lateMinutes } = judgeCheckIn(now, shift);
      const location = await judgeLocation(conn, req.user.id, fix);

      await conn.query(
        `INSERT INTO checkins
           (employee_id, checkin_date, shift_code, checkin_time, checkin_lat, checkin_lng,
            checkin_photo_id, is_late, late_minutes, location_flagged, location_note)
         VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, today, shift?.code || null, fix.latitude, fix.longitude,
          photo.id, isLate, lateMinutes, location.flagged, location.note]
      );
      await conn.query(
        `INSERT INTO location_logs (user_id, latitude, longitude, recorded_at) VALUES (?, ?, ?, NOW())`,
        [req.user.id, fix.latitude, fix.longitude]
      );

      // "Check-in after the grace period → Marked as Late. Manas receives an
      // immediate notification." (C.2)
      if (isLate) {
        for (const manager of await usersWhoCan(conn, 'attendance.view')) {
          await notify(conn, {
            userId: manager,
            tone: 'warning',
            title: `${req.user.name} checked in late`,
            body: `${lateMinutes} minute(s) after the ${shift?.name || 'shift'} grace period.`,
            actor: req.user.id,
            refType: 'checkin',
            refId: null,
          });
        }
      }
      if (location.flagged) {
        for (const manager of await usersWhoCan(conn, 'attendance.view')) {
          await notify(conn, {
            userId: manager,
            tone: 'warning',
            title: `${req.user.name} checked in away from the workplace`,
            body: location.note,
            actor: req.user.id,
            refType: 'checkin',
            refId: null,
          });
        }
      }

      return {
        checkin: await currentRow(conn, req.user.id, today),
        is_late: isLate,
        late_minutes: lateMinutes,
        location_flagged: location.flagged,
        shift: shift ? { code: shift.code, name: shift.name, grace_until: shift.grace_until } : null,
      };
    });

    if (result.reject) return res.status(result.reject.status).json(result.reject.body);

    res.status(201).json({
      message: result.is_late
        ? `Checked in — ${result.late_minutes} minute(s) late.`
        : 'Checked in successfully',
      ...result,
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'You are already checked in for today' });
    }
    throw err;
  }
});

router.post('/checkout', shiftWrites, async (req, res) => {
  const fix = readFix(req.body);
  if (!fix) {
    return res.status(400).json({ error: 'A valid latitude and longitude are required' });
  }
  const today = businessDay();

  const outcome = await withTransaction(async (conn) => {
    // R-24 applies to the check-out too: "A geotagged photograph is required.
    // Check-out is not recorded without it." (C.3)
    const photo = await readPhoto(conn, req.body.photo_id, req.user.id);
    if (photo.error) return { reject: { status: 400, body: photo } };

    const shift = await shiftFor(conn, req.user.id);
    const { isHalfDay } = judgeCheckOut(new Date(), shift);

    const [result] = await conn.query(
      `UPDATE checkins
          SET checkout_time = NOW(), checkout_lat = ?, checkout_lng = ?,
              checkout_photo_id = ?, is_half_day = ?
        WHERE employee_id = ? AND checkin_date = ? AND checkout_time IS NULL`,
      [fix.latitude, fix.longitude, photo.id, isHalfDay, req.user.id, today]
    );
    if (result.affectedRows === 0) return { checkin: null };

    await conn.query(
      `INSERT INTO location_logs (user_id, latitude, longitude, recorded_at) VALUES (?, ?, ?, NOW())`,
      [req.user.id, fix.latitude, fix.longitude]
    );
    const row = await currentRow(conn, req.user.id, today);
    return {
      checkin: row,
      is_half_day: isHalfDay,
      worked_minutes: workedMinutes(row.checkin_time, row.checkout_time),
      shift: shift ? { code: shift.code, name: shift.name, half_day_before: shift.half_day_before } : null,
    };
  });

  if (outcome.reject) return res.status(outcome.reject.status).json(outcome.reject.body);
  const checkin = outcome.checkin;

  if (!checkin) {
    return res.status(400).json({ error: 'No active shift found to check out from today' });
  }
  res.json({
    message: outcome.is_half_day
      ? 'Checked out before the shift cut-off — the day is recorded as a half day.'
      : 'Checked out successfully',
    checkin,
    is_half_day: outcome.is_half_day,
    worked_minutes: outcome.worked_minutes,
    shift: outcome.shift,
  });
});

router.post('/lunch-out', shiftWrites, async (req, res) => {
  const fix = readFix(req.body);
  if (!fix) {
    return res.status(400).json({ error: 'A valid latitude and longitude are required' });
  }
  const today = businessDay();

  const checkin = await withTransaction(async (conn) => {
    const [result] = await conn.query(
      `UPDATE checkins SET lunch_out_time = NOW()
        WHERE employee_id = ? AND checkin_date = ? AND checkout_time IS NULL AND lunch_out_time IS NULL`,
      [req.user.id, today]
    );
    if (result.affectedRows === 0) return null;

    await conn.query(
      `INSERT INTO location_logs (user_id, latitude, longitude, recorded_at) VALUES (?, ?, ?, NOW())`,
      [req.user.id, fix.latitude, fix.longitude]
    );
    return currentRow(conn, req.user.id, today);
  });

  if (!checkin) {
    return res.status(400).json({ error: 'No active shift found or already on lunch break' });
  }
  res.json({ message: 'Lunch break started', checkin });
});

router.post('/lunch-in', shiftWrites, async (req, res) => {
  const fix = readFix(req.body);
  if (!fix) {
    return res.status(400).json({ error: 'A valid latitude and longitude are required' });
  }
  const today = businessDay();

  const checkin = await withTransaction(async (conn) => {
    const [result] = await conn.query(
      `UPDATE checkins SET lunch_in_time = NOW()
        WHERE employee_id = ? AND checkin_date = ? AND checkout_time IS NULL
          AND lunch_out_time IS NOT NULL AND lunch_in_time IS NULL`,
      [req.user.id, today]
    );
    if (result.affectedRows === 0) return null;

    await conn.query(
      `INSERT INTO location_logs (user_id, latitude, longitude, recorded_at) VALUES (?, ?, ?, NOW())`,
      [req.user.id, fix.latitude, fix.longitude]
    );
    return currentRow(conn, req.user.id, today);
  });

  if (!checkin) {
    return res.status(400).json({ error: 'Not currently on a lunch break' });
  }
  res.json({ message: 'Lunch break ended', checkin });
});

// The workforce whose attendance is tracked. Admins are excluded: they are not
// field staff, and counting them produced an absence for every administrator on
// every working day. /location/live has always filtered the same way — the two
// endpoints used to disagree about who the workforce was.
const WORKFORCE = `u.is_active = TRUE AND u.role = 'employee'`;

/**
 * C.5 — "Manas sees a daily attendance dashboard: who is present, who is
 * late, who is absent. Colour coded: Green (present, on time), Amber (late),
 * Red (absent), Grey (not yet checked in)."
 *
 * `is_late` and `shift_code` are what the colour actually turns on, alongside
 * `checkin_time` itself; both were missing from this row until a screen asked
 * for them, so absent/late could not be told apart from present-on-time
 * without recomputing the grace period client-side against a shift the row
 * did not carry.
 */
router.get('/daily', requirePermission('attendance.view'), async (req, res) => {
  const date = requestedDay(req.query.date);
  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.email, u.phone, u.is_active,
            c.checkin_time, c.checkout_time, c.lunch_out_time, c.lunch_in_time, c.checkin_lat, c.checkin_lng,
            c.checkout_lat, c.checkout_lng, c.is_auto_checkout,
            COALESCE(c.shift_code, u.shift_code) AS shift_code,
            c.is_late, c.late_minutes, c.is_half_day,
            c.location_flagged, c.location_note,
            s.starts_at, s.grace_until, s.absent_after_minutes
       FROM users u
       LEFT JOIN checkins c ON c.employee_id = u.id AND c.checkin_date = ?
       LEFT JOIN shifts s ON s.code = COALESCE(c.shift_code, u.shift_code) AND s.is_active = TRUE
      WHERE ${WORKFORCE}
      ORDER BY u.name ASC`, [date]
  );

  // "Colour coded: Green (present, on time), Amber (late), Red (absent), Grey
  // (not yet checked in)." (C.5) `status` is computed here rather than left to
  // the client so every screen reads the same clock: `isAbsentYet` compares
  // against the business timezone, and a phone set to the wrong zone must not
  // be able to turn somebody's red into grey.
  const isToday = date === businessDay();
  const now = new Date();
  const attendance = rows.map((row) => {
    let status;
    if (row.checkin_time) status = row.is_late ? 'late' : 'present';
    else if (!isToday) status = 'absent'; // the day is over; a no-show stays a no-show
    else status = isAbsentYet(row.starts_at ? row : null, now) ? 'absent' : 'pending';
    return { ...row, status };
  });

  res.json({ date, attendance });
});

router.get('/monthly-summary', requirePermission('attendance.view'), async (req, res) => {
  const year = Number(req.query.year), month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'Valid year and month are required' });
  }

  const monthDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to = `${year}-${String(month).padStart(2, '0')}-${monthDays}`;

  const [holidayRows] = await pool.query(
    'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ? AND is_active = TRUE',
    [from, to]
  );
  const holidaySet = new Set(holidayRows.map((row) => String(row.holiday_date).slice(0, 10)));

  // The month is measured against the business day, not the server's own
  // calendar, and stops at today so an unfinished month is not scored as
  // absences for days that have not happened.
  const today = businessDay();
  const [todayYear, todayMonth, todayDate] = today.split('-').map(Number);
  const lastDay = year === todayYear && month === todayMonth ? todayDate : monthDays;

  // The working calendar and the present-day set are built from the SAME list
  // of dates. Counting every check-in as a present day let a Sunday shift
  // cancel out a missed Monday: 26 check-ins against 26 working days reported
  // zero absences for someone who had in fact been absent four times.
  const workingDays = [];
  for (let day = 1; day <= lastDay; day++) {
    const key = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const isSunday = new Date(`${key}T00:00:00Z`).getUTCDay() === 0;
    if (!isSunday && !holidaySet.has(key)) workingDays.push(key);
  }
  const workingSet = new Set(workingDays);

  const [rows] = await pool.query(
    `SELECT u.id, u.name, u.is_active, c.checkin_date
       FROM users u
       LEFT JOIN checkins c ON c.employee_id = u.id AND c.checkin_date BETWEEN ? AND ?
      WHERE ${WORKFORCE}
      ORDER BY u.name`, [from, to]
  );

  const byEmployee = new Map();
  for (const row of rows) {
    let entry = byEmployee.get(row.id);
    if (!entry) {
      entry = { id: row.id, name: row.name, is_active: row.is_active, present_days: 0, extra_days: 0 };
      byEmployee.set(row.id, entry);
    }
    if (!row.checkin_date) continue;
    const day = String(row.checkin_date).slice(0, 10);
    if (workingSet.has(day)) entry.present_days++;
    // Worked, but on a Sunday or a holiday. Counted separately so it is visible
    // rather than silently offsetting an absence.
    else entry.extra_days++;
  }

  res.json({
    year,
    month,
    workingDays: workingDays.length,
    employees: [...byEmployee.values()].map((row) => ({
      ...row,
      absent_days: Math.max(0, workingDays.length - row.present_days),
    })),
  });
});

router.get('/holidays', requirePermission('attendance.view'), async (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year)) return res.status(400).json({ error: 'Valid year is required' });
  const [rows] = await pool.query('SELECT id, holiday_date, name, is_custom FROM holidays WHERE YEAR(holiday_date) = ? AND is_active = TRUE ORDER BY holiday_date', [year]);
  res.json({ holidays: rows });
});

router.post('/holidays', requirePermission('attendance.create'), async (req, res) => {
  const { date, name } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !name?.trim()) return res.status(400).json({ error: 'Date and holiday name are required' });
  await pool.query(
    `INSERT INTO holidays (holiday_date, name, is_custom, is_active, created_by) VALUES (?, ?, TRUE, TRUE, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), is_custom = TRUE, is_active = TRUE, created_by = VALUES(created_by)`,
    [date, name.trim(), req.user.id]
  );
  const [[holiday]] = await pool.query('SELECT id, holiday_date, name, is_custom FROM holidays WHERE holiday_date = ?', [date]);
  res.status(201).json({ holiday });
});

router.delete('/holidays/:id', requirePermission('attendance.delete'), async (req, res) => {
  const [result] = await pool.query('UPDATE holidays SET is_active = FALSE WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Holiday not found' });
  res.status(204).end();
});

router.get('/employee/:id/monthly', requirePermission('attendance.view'), async (req, res) => {
  const year = Number(req.query.year), month = Number(req.query.month);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return res.status(400).json({ error: 'Valid year and month are required' });
  const prefix = `${year}-${String(month).padStart(2, '0')}`;
  const [rows] = await pool.query(
    `SELECT checkin_date, checkin_time, checkout_time, lunch_out_time, lunch_in_time, checkin_lat, checkin_lng, checkout_lat, checkout_lng, is_auto_checkout
       FROM checkins WHERE employee_id = ? AND checkin_date LIKE CONCAT(?, '%') ORDER BY checkin_date`, [req.params.id, prefix]
  );
  const [holidays] = await pool.query(`SELECT holiday_date, name FROM holidays WHERE holiday_date LIKE CONCAT(?, '%') AND is_active = TRUE`, [prefix]);
  res.json({ employeeId: req.params.id, year, month, attendance: rows, holidays });
});

module.exports = router;
