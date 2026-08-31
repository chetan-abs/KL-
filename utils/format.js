/**
 * Money and quantity formatting for the phone screens.
 *
 * Amounts group the Indian way — ₹15,764.80, ₹1,25,000 — because that is what
 * the mockups show and what the staff reading them check against a paper
 * invoice. `en-IN` gets the 2-3-2 grouping right; the manual path exists because
 * a Hermes build without full ICU silently falls back to `en-US` grouping and
 * would render ₹1,564,780 with no error to notice.
 */

function groupIndian(whole) {
  if (whole.length <= 3) return whole;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
}

/**
 * `13360` → `13,360`. `15764.8` → `15,764.80` when `decimals` is on.
 *
 * `decimals: 'auto'` shows paise only when there are any, which is how the
 * mockups set a commission list: ₹36.40 beside ₹490, not ₹490.00. Forcing two
 * places on a column of mostly-whole rupees adds a digit of noise to every row
 * to be accurate about one of them.
 */
export function formatAmount(value, { decimals = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';

  const negative = number < 0;
  const places =
    decimals === 'auto' ? (Math.round(Math.abs(number) * 100) % 100 === 0 ? 0 : 2) : decimals ? 2 : 0;
  const fixed = Math.abs(number).toFixed(places);
  const [whole, fraction] = fixed.split('.');
  const grouped = groupIndian(whole);

  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`;
}

/** The same, with the symbol attached. */
export function rupees(value, options) {
  const formatted = formatAmount(value, options);
  return formatted === '—' ? formatted : `₹${formatted}`;
}

/**
 * Compact form for dashboard tiles — ₹42.8L, ₹18.2L, ₹9.4Cr.
 *
 * Lakh and crore rather than K/M: the figures are read by people who think in
 * those units, and "₹4.28M" would have to be converted before it meant
 * anything.
 */
export function rupeesShort(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';

  const abs = Math.abs(number);
  const sign = number < 0 ? '-' : '';

  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(abs >= 100000000 ? 0 : 1)}Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(abs >= 10000000 ? 0 : 1)}L`;
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(abs >= 100000 ? 0 : 1)}k`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Drops a trailing `.0000` so 5 coils reads as "5", not "5.0000". */
export function formatQty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return String(Number(number.toFixed(4)));
}

/** `5` + `coils` → `5 coils`; a missing unit degrades to the bare number. */
export function qtyWithUnit(value, unit) {
  const qty = formatQty(value);
  return unit ? `${qty} ${unit}` : qty;
}
