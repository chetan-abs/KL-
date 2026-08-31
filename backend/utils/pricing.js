/**
 * The rate card, as one function.
 *
 * An item does not have a rate. It has six — one per customer type — and they
 * are derived from the master two entirely different ways depending on the
 * item's pricing type:
 *
 *   list_less_disc   base_price is the LIST price and each customer type has a
 *                    discount taken off it.   rate = base * (1 - disc)
 *   net              base_price is the NET DEALER rate — the dealer pays it as
 *                    it stands — and each other type has a markup added on.
 *                    rate = base * (1 + ratio);  dealer = base
 *
 * Which is why this is a function and not six generated columns. Six columns
 * would put the derivation in the importer, where it would be re-implemented
 * (differently) by anyone who later needed to quote a price outside an order.
 *
 * The source of every number here is KL_APP_RATES_markups_3.xlsx for the KL
 * range and LEMAC_Developer_Master_v7.xlsx for the Lemac range. Neither is
 * consulted at runtime: scripts/import-rates.js loads both into `items`, and
 * this reads the columns.
 */

const { money } = require('./workflow');

/**
 * The six types, in the order the order screen's dropdown lists them.
 *
 * The strings are the enum values in customers.customer_type and the snapshot
 * in orders.customer_type. Do not rename one without a migration: the snapshot
 * is what a two-year-old order is read back through.
 */
const CUSTOMER_TYPES = [
  'dealer',
  'retail_direct',
  'retail_commission',
  'electrician_direct',
  'builder_direct',
  'builder_commission',
];

/**
 * Which column pair each type reads.
 *
 * `disc` for a list_less_disc item, `ratio` for a net one. The dealer has no
 * ratio because a net item's base price IS the dealer's rate — the sheet has
 * no dealer ratio column, and inventing one as 0 would be the same number by
 * accident rather than by construction.
 */
const RATE_COLUMNS = {
  dealer:             { disc: 'disc_dealer',         ratio: null },
  retail_direct:      { disc: 'disc_retail_direct',  ratio: 'ratio_retail_direct' },
  retail_commission:  { disc: 'disc_retail_comm',    ratio: 'ratio_retail_comm' },
  electrician_direct: { disc: 'disc_electrician',    ratio: 'ratio_electrician' },
  builder_direct:     { disc: 'disc_builder_direct', ratio: 'ratio_builder_direct' },
  builder_commission: { disc: 'disc_builder_comm',   ratio: 'ratio_builder_comm' },
};

/** The two types that open the commission agent window (3.1). */
const COMMISSION_TYPES = new Set(['retail_commission', 'builder_commission']);

/** The one type that opens the KL Utsav window (3.2). */
const SCHEME_TYPES = new Set(['electrician_direct']);

/** The one type that earns a cash discount on early payment (3.3). */
const CASH_DISCOUNT_TYPES = new Set(['dealer']);

const isCustomerType = (t) => CUSTOMER_TYPES.includes(t);

/**
 * A rate, or an explanation of why there isn't one.
 *
 * Returns `{ rate, pricingType, basePrice, factor }` on success and throws
 * `PriceUnavailable` otherwise. Throwing rather than returning 0 is the whole
 * point: 5,239 of the 8,519 items in the rate sheet have no pricing type at
 * all — they exist in Tally with a stock balance and have never been
 * rate-carded. A zero rate would let every one of them be sold for nothing,
 * silently, and the order would look perfectly ordinary.
 */
class PriceUnavailable extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PriceUnavailable';
    this.code = code;
  }
}

function rateFor(item, customerType) {
  if (!isCustomerType(customerType)) {
    throw new PriceUnavailable('BAD_CUSTOMER_TYPE', `Unknown customer type "${customerType}".`);
  }

  const cols = RATE_COLUMNS[customerType];
  const base = Number(item.base_price);

  if (!item.pricing_type) {
    throw new PriceUnavailable(
      'NOT_RATE_CARDED',
      `"${item.name}" has no rate card yet. Gaurav must set its pricing before it can be sold.`,
    );
  }
  if (!(base > 0)) {
    throw new PriceUnavailable('NO_BASE_PRICE', `"${item.name}" has no base price.`);
  }

  if (item.pricing_type === 'net') {
    // The dealer pays the net rate itself; everyone else pays a markup over it.
    if (!cols.ratio) return { rate: money(base), pricingType: 'net', basePrice: money(base), factor: 0 };
    const ratio = item[cols.ratio];
    if (ratio === null || ratio === undefined) {
      throw new PriceUnavailable(
        'NO_RATE_FOR_TYPE',
        `"${item.name}" has no ${label(customerType)} markup.`,
      );
    }
    return {
      rate: money(base * (1 + Number(ratio))),
      pricingType: 'net',
      basePrice: money(base),
      factor: Number(ratio),
    };
  }

  const disc = item[cols.disc];
  if (disc === null || disc === undefined) {
    throw new PriceUnavailable(
      'NO_RATE_FOR_TYPE',
      `"${item.name}" has no ${label(customerType)} discount.`,
    );
  }
  return {
    rate: money(base * (1 - Number(disc))),
    pricingType: 'list_less_disc',
    basePrice: money(base),
    factor: Number(disc),
  };
}

/** All six, for the item screen. Types with no rate are reported, not omitted. */
function allRates(item) {
  const out = {};
  for (const type of CUSTOMER_TYPES) {
    try {
      out[type] = rateFor(item, type).rate;
    } catch (err) {
      if (err.name !== 'PriceUnavailable') throw err;
      out[type] = null;
    }
  }
  return out;
}

/**
 * Agent commission on one line.
 *
 * The percentage comes from the ITEM, not from a category rule. The
 * requirements summarise it as "Wire 1%, Fan 3%, all else 10%", but the rate
 * sheet carries the number per item and disagrees in a way that matters: the
 * builder agent is on 5% where the electrician agent is on 10%. Hard-coding
 * the summary would overpay every builder agent, on every line, forever.
 *
 * agentType is 'electrician' or 'builder' — the choice made at the top of the
 * commission window, which decides which of the item's two columns is read.
 */
function commissionFor(item, agentType, saleAmount) {
  const column = agentType === 'builder' ? 'comm_builder_agent' : 'comm_retail_agent';
  const pct = item[column];
  if (pct === null || pct === undefined) return { percent: 0, amount: 0 };
  return { percent: Number(pct), amount: money(Number(saleAmount) * Number(pct)) };
}

/**
 * KL Utsav qualifying value for one line (3.2).
 *
 * "Wire products → 50% of the purchase amount counts toward qualifying value.
 * All other products → 100%." The sheet holds the weight per item and carries
 * a third band the requirements never mention — 0.1, which is the entire
 * Anchor range. Read the column; the two-line summary is not the master.
 *
 * An item with no weighting counts in full, which is the document's default.
 */
function qualifyingValue(item, lineAmount) {
  const w = item.scheme_weightage;
  const weight = w === null || w === undefined ? 1 : Number(w);
  return money(Number(lineAmount) * weight);
}

/**
 * R-22 — "A single transaction cannot trigger both the KL Utsav Scheme and a
 * commission calculation. The application must prevent this."
 *
 * Enforced here rather than as a CHECK constraint so the refusal carries a
 * sentence the salesman can act on, and so it is refused at the same point the
 * rest of the order is validated.
 */
function assertSchemeCommissionExclusive({ agentId, schemeMemberId }) {
  if (agentId && schemeMemberId) {
    const err = new Error(
      'An order cannot pay an agent commission and count towards the KL Utsav scheme. ' +
      'The same person cannot be the referring agent and the buyer on one transaction.',
    );
    err.code = 'SCHEME_COMMISSION_CONFLICT';
    throw err;
  }
}

/**
 * What the order screen must open next, given the customer type (4.1).
 *
 * Returned to the client so the rule lives on the server: a client that forgot
 * to open the agent window would otherwise submit a commission order with no
 * agent, and the commission would simply never be paid.
 */
function requiredWindow(customerType) {
  if (COMMISSION_TYPES.has(customerType)) return 'agent';
  if (SCHEME_TYPES.has(customerType)) return 'scheme';
  return null;
}

/** Human-readable, for error messages and the rate table's column headings. */
function label(type) {
  return {
    dealer: 'Dealer',
    retail_direct: 'Retail Direct',
    retail_commission: 'Retail Commission',
    electrician_direct: 'Electrician Direct',
    builder_direct: 'Builder Direct',
    builder_commission: 'Builder Commission',
  }[type] || type;
}

/**
 * R-16 — below-cost detection.
 *
 * An item with no cost price cannot be below it. Both spreadsheets are rate
 * cards, not costings, so cost_price is null for every item until somebody
 * enters one; defaulting it to zero would have made every sale look profitable
 * and the alert would never have fired at all.
 */
function isBelowCost(item, rate) {
  const cost = item.cost_price;
  if (cost === null || cost === undefined) return false;
  return Number(rate) < Number(cost);
}

module.exports = {
  CUSTOMER_TYPES,
  RATE_COLUMNS,
  COMMISSION_TYPES,
  SCHEME_TYPES,
  CASH_DISCOUNT_TYPES,
  PriceUnavailable,
  isCustomerType,
  rateFor,
  allRates,
  commissionFor,
  qualifyingValue,
  assertSchemeCommissionExclusive,
  requiredWindow,
  isBelowCost,
  label,
};
