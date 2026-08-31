/**
 * Attendance judgement and the salary it produces.
 *
 * Sources: KL_App_Requirements_FINAL.pdf section 6, and the addendum's
 * sections A, B and C. Rules R-24, R-25, R-27, R-28, R-29, R-30.
 *
 * Two halves that must not be confused:
 *
 *   judgeCheckIn / judgeCheckOut  run once, at the moment of the punch, and
 *   write is_late / is_half_day onto the checkins row. They are stored, not
 *   recomputed, because they are judgements against the shift timings AS THEY
 *   STOOD THAT DAY — management moves the grace period, and recomputing March
 *   against September's grace would silently rewrite deductions already paid.
 *
 *   computePeriod  derives the month from those flags plus the working
 *   calendar. It is recomputed on every read while the period is a draft, and
 *   frozen when it is finalised.
 *
 * The standing invariant holds throughout: no table records "present" or
 * "absent". An absence is a working date with no checkins row.
 */

const { businessTime, parseServerDate, minutesBetween } = require('./businessDay');
const { money } = require('./workflow');

/**
 * "Daily salary for deduction purposes = Fixed Monthly Salary ÷ 26 working
 * days." (C.4) A constant divisor, not the month's actual working days —
 * the document is explicit, and February would otherwise pay a different
 * daily rate from March.
 */
const SALARY_DIVISOR = 26;

/**
 * The late ladder (C.4), as a monthly total rather than a per-occurrence
 * charge.
 *
 *   1st, 2nd   written record only
 *   3rd        written warning, still no money
 *   4th        Rs. 500
 *   5th+       Rs. 1,000
 *
 * Read as a step: someone late six times owes 1,000, not 1,000 for each late
 * after the fourth. Both documents phrase it as a consequence of reaching a
 * count ("4 instances → Rs.500 salary deduction"), and charging per occurrence
 * would make a seventh late cost more than three days' pay on an 18,000 salary.
 * If the business means it per occurrence, this is the one line to change.
 */
const LATE_LADDER = [
  { from: 5, amount: 1000, note: '5 or more late arrivals' },
  { from: 4, amount: 500, note: '4th late arrival' },
  { from: 3, amount: 0, note: '3rd late arrival — written warning' },
];

/** Half Day → 50% of that day's salary (C.4). */
const HALF_DAY_FACTOR = 0.5;

/** Absent without any information → double the day's salary (R-29). */
const ABSENT_UNINFORMED_FACTOR = 2;

/**
 * Absent with prior information, leave approved.
 *
 * The document says "Deduction as per leave policy" and never states the
 * policy. One day's pay is the conservative reading — the day was not worked —
 * and it is a named constant so that when the policy is written down there is
 * exactly one place to put it. It is deliberately not zero: guessing that
 * approved leave is paid would quietly overpay every month.
 */
const ABSENT_INFORMED_FACTOR = 1;

/** Fixed monthly salary to a day's pay. */
const dailyRate = (fixedSalary) => money(Number(fixedSalary || 0) / SALARY_DIVISOR);

/**
 * Was this check-in late, and by how much?
 *
 * `instant` is the UTC moment of the punch; the shift's grace is a wall-clock
 * time in Guwahati. Comparing the two without converting compares 04:40 UTC
 * against 10:10 IST and marks the entire company late every morning.
 */
function judgeCheckIn(instant, shift) {
  if (!shift) return { isLate: false, lateMinutes: 0 };
  const at = businessTime(instant);
  const late = minutesBetween(shift.grace_until, at);
  return late > 0
    ? { isLate: true, lateMinutes: Math.round(late) }
    : { isLate: false, lateMinutes: 0 };
}

/**
 * Was this check-out early enough to make the day a half day? (R-25)
 *
 * Shift A before 18:00, Shift B before 19:00 — both held on the shift row.
 */
function judgeCheckOut(instant, shift) {
  if (!shift) return { isHalfDay: false };
  const at = businessTime(instant);
  return { isHalfDay: minutesBetween(at, shift.half_day_before) > 0 };
}

/**
 * Is it late enough that a no-show is an absence rather than a pending
 * arrival? (C.2 — "No check-in by 1 hour after shift start")
 */
function isAbsentYet(shift, now = new Date()) {
  if (!shift) return false;
  return minutesBetween(shift.starts_at, businessTime(now)) > shift.absent_after_minutes;
}

/** Hours worked, for the day's record. Lunch is not deducted. */
function workedMinutes(checkinTime, checkoutTime) {
  const a = parseServerDate(checkinTime);
  const b = parseServerDate(checkoutTime);
  if (!a || !b) return null;
  return Math.max(0, Math.round((b - a) / 60000));
}

/** What the late count costs this month. */
function lateDeduction(count, rate = 1) {
  const rung = LATE_LADDER.find((r) => count >= r.from);
  if (!rung) return { amount: 0, note: count ? `${count} late arrival(s) — recorded` : null };
  return { amount: money(rung.amount * rate), note: rung.note };
}

/**
 * The working calendar for a month.
 *
 * "Sunday is a full weekly off and is not counted in attendance calculations"
 * and "The application must account for public holidays if entered by Yash."
 * (C.6) Built as strings rather than Date arithmetic so no UTC midnight can
 * shift a day across a boundary.
 */
function workingDates(period, holidays = new Set()) {
  const [year, month] = period.split('-').map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const iso = `${period}-${String(d).padStart(2, '0')}`;
    // getUTCDay on a UTC-midnight date is the weekday of that calendar date,
    // which is what a calendar day means here — no timezone is involved.
    if (new Date(`${iso}T00:00:00Z`).getUTCDay() === 0) continue;
    if (holidays.has(iso)) continue;
    out.push(iso);
  }
  return out;
}

/**
 * One employee-month, derived.
 *
 * Takes everything it needs rather than querying, so it can be unit-tested
 * without a database and so the caller controls the transaction.
 *
 *   employee   { id, name, fixed_salary }
 *   period     'YYYY-MM'
 *   dates      the working dates, from workingDates()
 *   checkins   rows for the month: { checkin_date, is_late, is_half_day }
 *   leaveDates a Set of 'YYYY-MM-DD' covered by approved leave
 *   advances   [{ id, monthly_amount, amount, recovered }]
 *
 * Returns the totals and the deduction lines that explain them. Nothing is
 * written here — salary_deductions is populated only when the period is
 * finalised, because until then the figures change with every punch.
 */
function computePeriod({ employee, period, dates, checkins, leaveDates, advances }) {
  const fixed = Number(employee.fixed_salary || 0);
  const rate = dailyRate(fixed);
  const byDate = new Map(checkins.map((c) => [String(c.checkin_date), c]));
  const working = new Set(dates);

  const lines = [];
  let present = 0;
  let lateCount = 0;
  let halfDays = 0;
  let absentInformed = 0;
  let absentUninformed = 0;

  for (const date of dates) {
    const row = byDate.get(date);

    if (!row) {
      // A working date with no row is the absence. Which kind it is depends
      // only on whether leave was approved for it.
      if (leaveDates.has(date)) {
        absentInformed += 1;
        lines.push({
          kind: 'absent_informed', on_date: date,
          detail: 'Absent — leave approved',
          amount: money(rate * ABSENT_INFORMED_FACTOR),
        });
      } else {
        absentUninformed += 1;
        lines.push({
          kind: 'absent_uninformed', on_date: date,
          detail: 'Absent without information — double deduction',
          amount: money(rate * ABSENT_UNINFORMED_FACTOR),
        });
      }
      continue;
    }

    present += 1;
    if (row.is_late) lateCount += 1;
    if (row.is_half_day) {
      halfDays += 1;
      lines.push({
        kind: 'half_day', on_date: date,
        detail: 'Half day — checked out before the shift cut-off',
        amount: money(rate * HALF_DAY_FACTOR),
      });
    }
  }

  // A shift worked on a Sunday or a holiday is extra, not a present day — the
  // same reasoning that keeps a Sunday from cancelling out a missed Monday in
  // the monthly summary.
  const extraDays = checkins.filter((c) => !working.has(String(c.checkin_date))).length;

  const late = lateDeduction(lateCount);
  if (late.amount > 0) {
    lines.push({ kind: 'late', on_date: null, detail: late.note, amount: late.amount });
  }

  // Advances recover in equal instalments; the last one takes whatever is left
  // so a rounded instalment cannot leave a few paise outstanding for ever.
  const advanceLines = [];
  let advanceTotal = 0;
  for (const adv of advances) {
    const outstanding = money(Number(adv.amount) - Number(adv.recovered || 0));
    if (outstanding <= 0) continue;
    const take = money(Math.min(Number(adv.monthly_amount), outstanding));
    if (take <= 0) continue;
    advanceTotal = money(advanceTotal + take);
    advanceLines.push({
      kind: 'advance', on_date: null, advance_id: adv.id,
      detail: `Advance recovery (${money(outstanding - take)} remaining after this)`,
      amount: take,
    });
  }
  lines.push(...advanceLines);

  const attendanceDeduction = money(
    lines.filter((l) => l.kind !== 'advance').reduce((a, l) => a + l.amount, 0),
  );

  return {
    period,
    fixed_salary: fixed,
    daily_rate: rate,
    working_days: dates.length,
    days_present: present,
    days_late: lateCount,
    half_days: halfDays,
    days_absent_informed: absentInformed,
    days_absent_uninformed: absentUninformed,
    extra_days: extraDays,
    attendance_deduction: attendanceDeduction,
    advance_deduction: advanceTotal,
    other_deduction: 0,
    net_payable: money(fixed - attendanceDeduction - advanceTotal),
    lines,
  };
}

/**
 * Re-total a period once some of its deduction lines have been waived.
 *
 * "Yash may manually waive any deduction with a reason. The waiver is logged."
 * A waived line stays on the slip at its original amount and simply stops
 * counting — deleting it would erase the fact that it was earned.
 */
function applyWaivers(period, lines) {
  const live = lines.filter((l) => !l.waived);
  const attendance = money(
    live.filter((l) => l.kind !== 'advance').reduce((a, l) => a + Number(l.amount), 0),
  );
  const advance = money(
    live.filter((l) => l.kind === 'advance').reduce((a, l) => a + Number(l.amount), 0),
  );
  const other = Number(period.other_deduction || 0);
  return {
    attendance_deduction: attendance,
    advance_deduction: advance,
    other_deduction: other,
    net_payable: money(Number(period.fixed_salary) - attendance - advance - other),
  };
}

/**
 * Metres between two coordinates, for the workplace proximity flag (C.2).
 * Haversine on a spherical earth — good to a few metres at these distances,
 * which is well inside a 300 m radius.
 */
function distanceMetres(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some((v) => v === null || v === undefined)) return null;
  const R = 6371000;
  const rad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

module.exports = {
  SALARY_DIVISOR,
  LATE_LADDER,
  HALF_DAY_FACTOR,
  ABSENT_UNINFORMED_FACTOR,
  ABSENT_INFORMED_FACTOR,
  dailyRate,
  judgeCheckIn,
  judgeCheckOut,
  isAbsentYet,
  workedMinutes,
  lateDeduction,
  workingDates,
  computePeriod,
  applyWaivers,
  distanceMetres,
};
