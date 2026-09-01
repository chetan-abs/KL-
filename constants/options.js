/**
 * Fixed choice lists the forms offer.
 *
 * These are not data — nothing here is fetched, and nothing here changes per
 * party or per day. They are the vocabulary the business uses: the two
 * commission columns, the reasons a delivery fails, the units an item is sold
 * in.
 *
 * Kept on the client because the server does not enumerate them either. Where a
 * value is stored it is stored as the string, so adding an option here is all
 * that is needed to start recording it — and where a value drives behaviour
 * (`agent_type`, the return reasons) the server validates against its own list,
 * so a client that invents one is refused rather than obeyed.
 */

/**
 * The two commission rate columns.
 *
 * `caption` is the tile's own subtitle; `column` is the bare column name for
 * sentences that add their own noun, so neither ends up reading "Col 21 rates
 * commission rates apply".
 */
export const AGENT_TYPES = [
  { value: 'builder', label: 'Builder Agent', caption: 'Col 21 rates', column: 'Col 21', glyph: '🏗️' },
  { value: 'electrician', label: 'Elec / Interior', caption: 'Col 20 rates', column: 'Col 20', glyph: '⚡' },
];

/**
 * Stated on the screen that captures the agent, because it is a rule about the
 * document rather than about the form: agent identity and commission never
 * reach the printed invoice (R21).
 */
export const AGENT_PRIVACY_NOTE =
  'Agent name + commission NOT on invoice. Internal only. (R21)';

/**
 * The two shifts (C.1). Timings are the seed's own — `schema.sql`'s reference
 * rows — repeated here only as a label; the grace period and half-day cutoff
 * themselves are read from `shifts` on the server for every judgement, never
 * from this list.
 */
export const SHIFTS = [
  { value: 'A', label: 'Shift A', caption: '10:00 am – 6:45 pm' },
  { value: 'B', label: 'Shift B', caption: '11:00 am – 8:00 pm' },
];

export const PROFESSIONS = [
  { value: 'electrician', label: 'Electrician' },
  { value: 'interior', label: 'Interior Designer' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'architect', label: 'Architect' },
  { value: 'plumber', label: 'Plumber' },
];

/**
 * Why a stop did not close.
 *
 * In the drivers' own words rather than translated, because the driver picking
 * from this list is the person who was there, and "Shop band thi" is what they
 * would have written.
 */
/**
 * 4.3, September 2026 — "Reason mandatory. From a fixed, admin-editable
 * list — no free text." Kept here the same way every other fixed list in
 * this file is (see the file comment) rather than as a DB table: nothing
 * else in the app makes a vocabulary list database-driven, and the value is
 * validated server-side the same way — `URGENT_REASONS` in
 * backend/routes/orders.js is the list that actually matters; this is its
 * client copy. Only marking an order urgent counts against the daily
 * quota, so the list is deliberately short — a reason that does not fit
 * one of these is not the kind of urgent the quota exists to ration.
 */
export const URGENT_REASONS = [
  { value: 'retail_customer', label: 'Retail customer' },
  { value: 'customer_in_shop', label: 'Customer in shop' },
  { value: 'customer_on_the_way', label: 'Customer on the way' },
  { value: 'urgent_site_delivery', label: 'Urgent site delivery' },
  { value: 'promised_earlier', label: 'Party was promised earlier' },
  { value: 'work_stopped', label: 'Work stopped at site' },
];

export const UNDELIVERED_REASONS = [
  { value: 'shop_closed', label: 'Shop band thi' },
  { value: 'party_absent', label: 'Party nahi mila' },
  { value: 'payment_refused', label: 'Payment refuse kiya' },
  { value: 'wrong_goods', label: 'Galat maal' },
  { value: 'address_wrong', label: 'Address galat' },
];

export const RETURN_REASONS = [
  { value: 'damaged', label: 'Damaged in transit' },
  { value: 'wrong_item', label: 'Wrong item supplied' },
  { value: 'excess', label: 'Excess supplied' },
  { value: 'quality', label: 'Quality complaint' },
];

/** What a new item can be filed under. */
export const NEW_ITEM_DEFAULTS = {
  categories: [
    { value: 'wire', label: 'Wire & Cable' },
    { value: 'switchgear', label: 'Switchgear' },
    { value: 'lighting', label: 'Lighting' },
    { value: 'fan', label: 'Fans' },
    { value: 'accessories', label: 'Accessories' },
  ],
  units: [
    { value: 'pcs', label: 'Pieces' },
    { value: 'coil', label: 'Coils' },
    { value: 'box', label: 'Box' },
    { value: 'mtr', label: 'Metre' },
  ],
  brands: [
    { value: 'polycab', label: 'Polycab' },
    { value: 'anchor', label: 'Anchor' },
    { value: 'havells', label: 'Havells' },
    { value: 'legrand', label: 'Legrand' },
  ],
};

/** The areas the branch sells into, and the two kinds of account. */
export const NEW_DEALER_FIELDS = {
  types: [
    { value: 'dealer', label: 'Dealer', caption: 'CD applicable', glyph: '🏪' },
    { value: 'builder', label: 'Builder', caption: 'Project rates', glyph: '🏗️' },
  ],
  areas: [
    { value: 'basistha', label: 'Basistha' },
    { value: 'beltola', label: 'Beltola' },
    { value: 'lalganesh', label: 'Lalganesh' },
    { value: 'zoo_road', label: 'Zoo Road' },
    { value: 'lakhtokia', label: 'Lakhtokia' },
  ],
};
