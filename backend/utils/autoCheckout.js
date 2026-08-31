/**
 * Closes shifts nobody checked out of.
 *
 * `checkins.is_auto_checkout` has existed since the first schema and the
 * attendance UI renders it, but nothing ever set it — so a forgotten check-out
 * left the employee-day open forever. The live map orders on "checked in and
 * not checked out", which meant somebody who forgot once stayed permanently
 * Active at their last known position, and their hours for that day could never
 * be computed. Two such shifts had been open for thirteen days when this was
 * written.
 *
 * The rule: any shift on a service day *earlier* than today that still has no
 * checkout_time is closed at AUTO_CHECKOUT_TIME on its own day, in the business
 * timezone, and flagged. Today is never touched — those people are working.
 *
 * The closing fix is the last GPS point recorded for that employee on that day,
 * because that is the last place the system actually saw them. Where there is
 * no such point the coordinates stay NULL rather than being invented.
 */
const pool = require('../config/db');
const { businessDay, timezone } = require('./businessDay');

const DEFAULT_TIME = '19:00';

/** Minutes that `timeZone` is ahead of UTC at the given instant. */
function offsetMinutes(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(instant)
    .filter((p) => p.type !== 'literal');

  const at = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  const asIfUtc = Date.UTC(at.year, at.month - 1, at.day, at.hour % 24, at.minute, at.second);
  return (asIfUtc - instant.getTime()) / 60000;
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC for a wall-clock time on a service day. */
function businessTimeToUtcString(dateStr, hhmm) {
  const [hour, minute] = String(hhmm).split(':').map(Number);
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const utc = new Date(guess.getTime() - offsetMinutes(guess, timezone()) * 60000);
  return utc.toISOString().slice(0, 19).replace('T', ' ');
}

function configuredTime() {
  const value = process.env.AUTO_CHECKOUT_TIME || DEFAULT_TIME;
  if (!/^\d{1,2}:\d{2}$/.test(value)) {
    console.warn(`[SHIFT] AUTO_CHECKOUT_TIME "${value}" is not HH:MM — using ${DEFAULT_TIME}.`);
    return DEFAULT_TIME;
  }
  return value;
}

/**
 * Returns { closed, rows } — rows describes what was (or would have been)
 * closed, so the CLI can print it and the caller can log a count.
 */
async function runAutoCheckout({ dryRun = false } = {}) {
  const today = businessDay();
  const closingTime = configuredTime();

  const [open] = await pool.query(
    `SELECT c.id, c.employee_id, c.checkin_date, c.checkin_time, u.name
       FROM checkins c
       JOIN users u ON u.id = c.employee_id
      WHERE c.checkout_time IS NULL AND c.checkin_date < ?
      ORDER BY c.checkin_date, u.name`,
    [today]
  );

  const rows = open.map((row) => ({
    ...row,
    closingAt: businessTimeToUtcString(String(row.checkin_date).slice(0, 10), closingTime),
  }));

  if (dryRun || rows.length === 0) {
    return { closed: 0, rows, dryRun };
  }

  let closed = 0;
  for (const row of rows) {
    // The last fix of that service day, if there is one.
    const [[lastFix]] = await pool.query(
      `SELECT latitude, longitude FROM location_logs
        WHERE user_id = ? AND recorded_at >= ? AND recorded_at < DATE_ADD(?, INTERVAL 1 DAY)
        ORDER BY recorded_at DESC LIMIT 1`,
      [row.employee_id, String(row.checkin_date).slice(0, 10), String(row.checkin_date).slice(0, 10)]
    );

    // GREATEST guards the one case the rule cannot cover on its own: a shift
    // that began after the closing time. Checking out before checking in would
    // be worse than closing it a second later.
    const [result] = await pool.query(
      `UPDATE checkins
          SET checkout_time = GREATEST(?, checkin_time),
              checkout_lat = ?,
              checkout_lng = ?,
              is_auto_checkout = TRUE
        WHERE id = ? AND checkout_time IS NULL`,
      [row.closingAt, lastFix?.latitude ?? null, lastFix?.longitude ?? null, row.id]
    );
    closed += result.affectedRows;
  }

  return { closed, rows, dryRun };
}

module.exports = { runAutoCheckout, businessTimeToUtcString, DEFAULT_TIME };
