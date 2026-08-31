/**
 * The service day, in the timezone the business actually works in.
 *
 * Instants are stored in UTC and that does not change — config/db.js pins every
 * connection to UTC and the schema is DATETIME throughout. What is NOT a UTC
 * quantity is the *day* an employee worked. `checkins.checkin_date` is a
 * calendar day in Guwahati, and `new Date().toISOString().slice(0, 10)` is a
 * calendar day in London.
 *
 * The difference is 5 hours 30 minutes, and it bit in two places:
 *
 *   - Someone starting at 05:15 IST was filed under the previous day, which
 *     collided with the row they had already created and refused the check-in.
 *   - After checking out, the unique key freed up at 05:30 IST rather than at
 *     midnight — while the app told them 7:30 AM.
 *
 * BUSINESS_TIMEZONE is an IANA name and defaults to Asia/Kolkata. Change it in
 * .env if the company ever operates somewhere else; nothing else needs to know.
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

function timezone() {
  return process.env.BUSINESS_TIMEZONE || DEFAULT_TIMEZONE;
}

/**
 * 'YYYY-MM-DD' for the given instant in the business timezone.
 *
 * 'en-CA' is used because its short date format IS ISO order — it needs no
 * reassembly from parts, and no locale in that formatter can reorder it.
 */
function businessDay(instant = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone(),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    // A Node build without full ICU, or a bad timezone name in .env. Falling
    // back to UTC is wrong by the offset, but it is deterministic and it keeps
    // the server answering; the misconfiguration is worth saying out loud.
    console.warn(`[TIME] BUSINESS_TIMEZONE "${timezone()}" is not usable — falling back to UTC.`);
    return instant.toISOString().slice(0, 10);
  }
}

/**
 * 'HH:MM:SS' for the given instant in the business timezone.
 *
 * The shift timings are wall-clock times in Guwahati — 10:10 grace, 18:00
 * half-day cut-off — and the check-in they are compared against is a UTC
 * instant. Reading the hour off the stored string directly compares 04:40 UTC
 * against 10:10 IST and marks everyone late, every day.
 *
 * hourCycle 'h23' is explicit because en-GB gives 24:00 for midnight, which
 * sorts after every other time of day rather than before them.
 */
function businessTime(instant = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone(),
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
  } catch {
    console.warn(`[TIME] BUSINESS_TIMEZONE "${timezone()}" is not usable — falling back to UTC.`);
    return instant.toISOString().slice(11, 19);
  }
}

/**
 * A MySQL DATETIME string as a Date.
 *
 * config/db.js sets dateStrings, so every timestamp arrives as
 * '2026-08-26 05:28:47' with no zone marker — which `new Date()` parses as
 * LOCAL time. On this server that is the same 5½ hour error the client-side
 * utils/datetime.js exists to prevent. The 'Z' is what makes it UTC.
 */
function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value).trim().replace(' ', 'T');
  return new Date(s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s) ? s : `${s}Z`);
}

/** Minutes between two 'HH:MM:SS' wall-clock strings, b − a. */
function minutesBetween(a, b) {
  const toMin = (t) => {
    const [h, m, s] = String(t).split(':').map(Number);
    return h * 60 + m + (s || 0) / 60;
  };
  return toMin(b) - toMin(a);
}

/** True for 'YYYY-MM-DD' and nothing else. Query strings are not to be trusted. */
function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** The caller's requested date if it is one, else today's service day. */
function requestedDay(value) {
  return isDateString(value) ? value : businessDay();
}

module.exports = {
  businessDay,
  businessTime,
  parseServerDate,
  minutesBetween,
  isDateString,
  requestedDay,
  timezone,
  DEFAULT_TIMEZONE,
};
