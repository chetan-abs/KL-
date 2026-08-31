/**
 * Reading the server's timestamps.
 *
 * The API hands back what MySQL stored, verbatim: `2026-08-26 05:28:47`. That
 * is UTC — `config/db.js` pins every connection to it — but the string carries
 * no zone, and JavaScript reads a space-separated date-time as *local* time. So
 * `new Date('2026-08-26 05:28:47')` produced 05:28 in Guwahati for an instant
 * that was really 10:58 there, and every check-in, check-out, lunch time and
 * GPS timestamp in the app was displayed 5 hours 30 minutes early.
 *
 * Everything that renders a server timestamp goes through here. Nothing calls
 * `new Date(value)` on an API string directly.
 */

/**
 * A Date from whatever the API returned, or null.
 *
 * Three shapes arrive in practice: the MySQL DATETIME string, an ISO string
 * with an explicit zone (which needs no help), and a Date that some caller has
 * already parsed. Anything unrecognisable is null rather than Invalid Date, so
 * a bad value renders as an em dash instead of "NaN:NaN".
 */
export function parseServerDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;

  // Already zoned — a trailing Z or a +05:30 style offset.
  const zoned = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(value);
  const iso = zoned ? value : `${value.replace(' ', 'T')}Z`;

  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** '09:15 AM', in the reader's own timezone. Em dash when there is nothing. */
export function formatTime(value, { fallback = '—' } = {}) {
  const date = parseServerDate(value);
  if (!date) return fallback;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
}

/** '26 Aug 2026'. Accepts a timestamp or a plain 'YYYY-MM-DD' date column. */
export function formatDate(value, { fallback = '' } = {}) {
  const date = parseServerDate(value);
  if (!date) return fallback;
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** '26 Aug 2026, 09:15 AM'. */
export function formatDateTime(value, { fallback = '—' } = {}) {
  const date = parseServerDate(value);
  if (!date) return fallback;
  return `${formatDate(date)}, ${formatTime(date)}`;
}

/**
 * Hours between two server timestamps, to one decimal, minus the lunch break
 * when both ends of it are present. Null when the shift is not closed yet.
 */
export function shiftHours({ checkin_time, checkout_time, lunch_out_time, lunch_in_time }) {
  const start = parseServerDate(checkin_time);
  const end = parseServerDate(checkout_time);
  if (!start || !end) return null;

  let worked = end.getTime() - start.getTime();

  const lunchOut = parseServerDate(lunch_out_time);
  const lunchIn = parseServerDate(lunch_in_time);
  if (lunchOut && lunchIn && lunchIn > lunchOut) {
    worked -= lunchIn.getTime() - lunchOut.getTime();
  }

  if (worked <= 0) return null;
  return Math.round((worked / 3_600_000) * 10) / 10;
}

/**
 * Today as 'YYYY-MM-DD' in the reader's own timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is today in London, which is the
 * previous day for the first five and a half hours of every Indian morning.
 * The server decides the service day for writes; this is for the date the UI
 * offers as a default when someone opens a screen.
 */
export function todayString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * A 'YYYY-MM-DD' string shifted by whole days, without going through UTC.
 *
 * Date arithmetic on 'YYYY-MM-DD' parsed as UTC midnight and read back with
 * local getters happens to work east of Greenwich and silently slips a day
 * west of it. Splitting the string keeps it a calendar operation.
 */
export function addDays(dateString, amount) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  const shifted = new Date(y, m - 1, d + amount);
  return todayString(shifted);
}

/** The weekday index (0 = Sunday) of a 'YYYY-MM-DD' string, read as a calendar date. */
export function dayOfWeek(dateString) {
  const [y, m, d] = String(dateString).split('-').map(Number);
  return new Date(y, m - 1, d).getDay();
}

/**
 * "2 min ago", "18 min ago", "3 h ago", "27 Jun".
 *
 * The queue screens are read to answer "how stale is this", and an absolute
 * clock time makes the reader do the subtraction. Past a day the absolute date
 * is the more useful answer, so it switches over rather than counting to "31
 * days ago".
 *
 * Goes through parseServerDate, so the API's naked DATETIME string is read as
 * UTC rather than as local time — without it every age here is 5½ hours out.
 */
export function relativeTime(value, { fallback = '' } = {}) {
  const then = parseServerDate(value);
  if (!then) return fallback;

  const seconds = Math.floor((Date.now() - then.getTime()) / 1000);

  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return formatDate(value, { fallback });
}

/**
 * Today, as the headers print it — "27 Jun".
 *
 * The service day, not the UTC one: a shift starting at 05:15 IST is today's,
 * and toISOString() would call it yesterday's.
 */
export function businessDate(date = new Date()) {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
