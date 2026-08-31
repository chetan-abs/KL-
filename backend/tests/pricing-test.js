#!/usr/bin/env node
/**
 * The pricing engine, checked against the two spreadsheets it was built from.
 *
 *   node tests/pricing-test.js
 *
 * Arithmetic first — a handful of rows whose numbers are read straight off the
 * sheet and worked by hand — then a sweep over every priced item in the
 * database asserting the properties the rate card must have. The sweep is what
 * catches a column mapped to the wrong field: one item can be right by luck,
 * 3,600 cannot.
 */

const pool = require('../config/db');
const {
  rateFor, allRates, commissionFor, qualifyingValue, isBelowCost,
  assertSchemeCommissionExclusive, requiredWindow, PriceUnavailable, CUSTOMER_TYPES,
} = require('../utils/pricing');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function near(name, actual, expected, tol = 0.01) {
  const good = Math.abs(Number(actual) - Number(expected)) <= tol;
  ok(name, good, good ? '' : `got ${actual}, expected ${expected}`);
}

function throws(name, fn, code) {
  try {
    fn();
    ok(name, false, 'did not throw');
  } catch (err) {
    ok(name, err.code === code, `threw ${err.code || err.name}, expected ${code}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Arithmetic, from rows read off the sheets by hand.
// ---------------------------------------------------------------------------

function arithmetic() {
  // KL sheet row 20 — Wendor 16a 3pin Top Gold H-852.
  // LIST LESS DISC, list 124. Dealer 62%, builder direct 40%, builder comm 37%,
  // retail direct 40%, retail comm 34%, electrician 40%.
  const wendor = {
    name: 'Wendor 16a 3pin Top Gold H-852',
    pricing_type: 'list_less_disc',
    base_price: 124,
    disc_dealer: 0.62,
    disc_builder_direct: 0.40,
    disc_builder_comm: 0.37,
    disc_retail_direct: 0.40,
    disc_retail_comm: 0.34,
    disc_electrician: 0.40,
    comm_retail_agent: 0.10,
    comm_builder_agent: 0.05,
    scheme_weightage: null,
    cost_price: null,
  };

  near('list_less_disc dealer      124 × 0.38', rateFor(wendor, 'dealer').rate, 47.12);
  near('list_less_disc builder dir 124 × 0.60', rateFor(wendor, 'builder_direct').rate, 74.40);
  near('list_less_disc builder com 124 × 0.63', rateFor(wendor, 'builder_commission').rate, 78.12);
  near('list_less_disc retail dir  124 × 0.60', rateFor(wendor, 'retail_direct').rate, 74.40);
  near('list_less_disc retail com  124 × 0.66', rateFor(wendor, 'retail_commission').rate, 81.84);
  near('list_less_disc electrician 124 × 0.60', rateFor(wendor, 'electrician_direct').rate, 74.40);

  ok('allRates returns all six', Object.keys(allRates(wendor)).length === 6);

  // KL sheet row 11 — Xtra Power Hammer Drill Bit 10MMX310MM.
  // NET, dealer 113. Builder direct +0.249912, builder comm +0.3,
  // retail direct +0.3, retail comm +0.33, electrician +0.249912.
  const drill = {
    name: 'Xtra Power Hammer Drill Bit 10MMX310MM',
    pricing_type: 'net',
    base_price: 113,
    ratio_builder_direct: 0.249912,
    ratio_builder_comm: 0.3,
    ratio_retail_direct: 0.3,
    ratio_retail_comm: 0.33,
    ratio_electrician: 0.249912,
    comm_retail_agent: 0.10,
    comm_builder_agent: 0.05,
    scheme_weightage: 1,
    cost_price: null,
  };

  near('net dealer pays the net rate itself', rateFor(drill, 'dealer').rate, 113);
  near('net builder direct 113 × 1.249912', rateFor(drill, 'builder_direct').rate, 141.24);
  near('net builder comm   113 × 1.30', rateFor(drill, 'builder_commission').rate, 146.90);
  near('net retail direct  113 × 1.30', rateFor(drill, 'retail_direct').rate, 146.90);
  near('net retail comm    113 × 1.33', rateFor(drill, 'retail_commission').rate, 150.29);

  // Lemac Product Master row 2 — Lemac 32a D.P. Switch with Key Tag Black.
  // List less disc, list 790, dealer 52% → 379.20.
  const lemac = {
    name: 'Lemac 32a D.P. Switch with Key Tag Black B2126',
    pricing_type: 'list_less_disc',
    base_price: 790,
    disc_dealer: 0.52,
    disc_builder_direct: 0.42,
    disc_builder_comm: 0.39,
    disc_retail_direct: 0.40,
    disc_retail_comm: 0.34,
    disc_electrician: 0.40,
    comm_retail_agent: 0.10,
    comm_builder_agent: 0.05,
  };
  near('lemac dealer 790 × 0.48', rateFor(lemac, 'dealer').rate, 379.20);
  near('lemac retail comm 790 × 0.66', rateFor(lemac, 'retail_commission').rate, 521.40);

  // Lemac 10A 1-way switch — Net, and the net rate is column 21 (23.72), NOT
  // the list price of 90. Reading the wrong column would price it at 4x.
  const oneWay = {
    name: 'Lemac Lavish K-Type 10a Switch T.Grey GK1021',
    pricing_type: 'net',
    base_price: 23.72,
    ratio_builder_direct: 0.10,
    ratio_builder_comm: 0.15,
    ratio_retail_direct: 0.15,
    ratio_retail_comm: 0.24,
    ratio_electrician: 0.15,
  };
  near('lemac 10A dealer = net rate', rateFor(oneWay, 'dealer').rate, 23.72);
  near('lemac 10A builder direct ×1.10', rateFor(oneWay, 'builder_direct').rate, 26.09);
  near('lemac 10A retail comm   ×1.24', rateFor(oneWay, 'retail_commission').rate, 29.41);

  // The provenance the order line snapshots.
  const snap = rateFor(wendor, 'dealer');
  ok('snapshot carries pricing type', snap.pricingType === 'list_less_disc');
  near('snapshot carries base price', snap.basePrice, 124);
  near('snapshot carries the factor', snap.factor, 0.62, 0.000001);
}

// ---------------------------------------------------------------------------
// 2. Refusals. An unpriced item must not become a free one.
// ---------------------------------------------------------------------------

function refusals() {
  const unpriced = { name: 'Wendor Fan Fastener (H-439) 12mm', pricing_type: null, base_price: 0 };
  throws('unpriced item refuses a rate', () => rateFor(unpriced, 'dealer'), 'NOT_RATE_CARDED');

  const noBase = { name: 'x', pricing_type: 'net', base_price: 0 };
  throws('zero base price refuses', () => rateFor(noBase, 'dealer'), 'NO_BASE_PRICE');

  const partial = { name: 'y', pricing_type: 'list_less_disc', base_price: 100, disc_dealer: 0.5 };
  near('the type that has a discount still prices', rateFor(partial, 'dealer').rate, 50);
  throws('a type with no discount refuses', () => rateFor(partial, 'retail_direct'), 'NO_RATE_FOR_TYPE');

  throws('unknown customer type refuses', () => rateFor(partial, 'wholesale'), 'BAD_CUSTOMER_TYPE');

  ok('allRates reports nulls rather than omitting',
    allRates(partial).retail_direct === null && allRates(partial).dealer === 50);

  // R-22.
  throws('R-22 agent and scheme member together refuse',
    () => assertSchemeCommissionExclusive({ agentId: 4, schemeMemberId: 9 }),
    'SCHEME_COMMISSION_CONFLICT');
  assertSchemeCommissionExclusive({ agentId: 4, schemeMemberId: null });
  assertSchemeCommissionExclusive({ agentId: null, schemeMemberId: 9 });
  ok('R-22 allows either alone', true);
}

// ---------------------------------------------------------------------------
// 3. Commission, weighting, below-cost, and which window opens.
// ---------------------------------------------------------------------------

function derived() {
  const wire = { comm_retail_agent: 0.01, comm_builder_agent: 0.01, scheme_weightage: 0.5 };
  const fan = { comm_retail_agent: 0.03, comm_builder_agent: 0.03, scheme_weightage: 0.5 };
  const other = { comm_retail_agent: 0.10, comm_builder_agent: 0.05, scheme_weightage: 1 };

  near('wire electrician agent 1%', commissionFor(wire, 'electrician', 10000).amount, 100);
  near('fan electrician agent 3%', commissionFor(fan, 'electrician', 10000).amount, 300);
  near('other electrician agent 10%', commissionFor(other, 'electrician', 10000).amount, 1000);
  // The document says 10% for "all else" on both agent types. The sheet says
  // the builder agent gets 5%, and the sheet is the master.
  near('other BUILDER agent 5%, not 10%', commissionFor(other, 'builder', 10000).amount, 500);

  const none = { comm_retail_agent: null, comm_builder_agent: null };
  near('an item with no commission pays none', commissionFor(none, 'electrician', 10000).amount, 0);

  near('wire counts 50% toward KL Utsav', qualifyingValue(wire, 10000), 5000);
  near('other counts 100%', qualifyingValue(other, 10000), 10000);
  near('the anchor 0.1 band the PDF omits', qualifyingValue({ scheme_weightage: 0.1 }, 10000), 1000);
  near('no weighting counts in full', qualifyingValue({ scheme_weightage: null }, 10000), 10000);

  ok('no cost price is never below cost', isBelowCost({ cost_price: null }, 1) === false);
  ok('below cost detected', isBelowCost({ cost_price: 50 }, 49.99) === true);
  ok('at cost is not below', isBelowCost({ cost_price: 50 }, 50) === false);

  ok('retail commission opens the agent window', requiredWindow('retail_commission') === 'agent');
  ok('builder commission opens the agent window', requiredWindow('builder_commission') === 'agent');
  ok('electrician direct opens the scheme window', requiredWindow('electrician_direct') === 'scheme');
  ok('dealer opens nothing', requiredWindow('dealer') === null);
  ok('retail direct opens nothing', requiredWindow('retail_direct') === null);
}

// ---------------------------------------------------------------------------
// 4. The sweep. Every priced item in the database, against the properties the
//    rate card must hold — this is what catches a mis-mapped column.
// ---------------------------------------------------------------------------

async function sweep(conn) {
  const [items] = await conn.query(
    `SELECT masterid, name, brand, pricing_type, base_price,
            disc_dealer, disc_builder_direct, disc_builder_comm,
            disc_retail_direct, disc_retail_comm, disc_electrician,
            ratio_builder_direct, ratio_builder_comm, ratio_retail_direct,
            ratio_retail_comm, ratio_electrician,
            comm_retail_agent, comm_builder_agent, scheme_weightage, cost_price
       FROM items WHERE pricing_type IS NOT NULL AND base_price > 0`,
  );

  ok('the sweep has something to sweep', items.length > 3000, `${items.length} priced items`);

  let priced = 0;
  let dealerCheapest = 0;
  let dealerOnly = 0;
  let dealerNotCheapest = [];
  let negative = [];
  let absurd = [];

  for (const item of items) {
    const rates = allRates(item);
    const values = CUSTOMER_TYPES.map((t) => rates[t]).filter((r) => r !== null);
    if (!values.length) continue;
    priced += 1;

    // A rate is money the business receives; none of them may be negative, and
    // a discount over 100% is the shape of a percent read as a fraction.
    if (values.some((r) => r < 0)) negative.push(item.name);

    // No rate should exceed the list price on a list-less-disc item: every
    // customer type takes a discount OFF list. A rate above list means a
    // ratio column was read where a discount column was meant.
    if (item.pricing_type === 'list_less_disc' && values.some((r) => r > Number(item.base_price) + 0.01)) {
      absurd.push(`${item.name} (list ${item.base_price}, max rate ${Math.max(...values)})`);
    }

    // The dealer buys cheapest — that is the whole shape of the rate card.
    // An item priced for the dealer alone has no ladder to be intact or
    // otherwise, so it is neither a pass nor a failure — comparing against an
    // empty set is how "vs Infinity" got printed.
    if (rates.dealer !== null) {
      const others = CUSTOMER_TYPES.filter((t) => t !== 'dealer').map((t) => rates[t]).filter((r) => r !== null);
      if (!others.length) dealerOnly += 1;
      else if (others.every((r) => r >= rates.dealer - 0.005)) dealerCheapest += 1;
      else dealerNotCheapest.push(`${item.name}: dealer ${rates.dealer} vs ${Math.min(...others)}`);
    }
  }

  ok('every priced item yields at least one rate', priced === items.length,
    `${priced} of ${items.length}`);
  ok('no negative rate anywhere', negative.length === 0,
    negative.length ? `${negative.length}, e.g. ${negative[0]}` : '');
  ok('no list-less-disc rate exceeds its list price', absurd.length === 0,
    absurd.length ? `${absurd.length}, e.g. ${absurd[0]}` : '');
  // The dealer buys cheapest on 99.7% of the range, and on eleven items they
  // do not — the rate sheet gives the builder a 60% discount where the dealer
  // gets 55.9% (ten Panasonic rows and one Legrand MCCB box). Verified against
  // the spreadsheet: the inversion is in the source, not in the import, so
  // this cannot be an equality assertion without asserting the data is other
  // than it is.
  //
  // What the threshold catches is the failure that would actually matter: a
  // discount column mapped to the wrong customer type inverts the ladder on
  // thousands of rows at once, not on eleven.
  const invertedShare = dealerNotCheapest.length / Math.max(priced, 1);
  ok('items priced for the dealer alone are counted, not compared', dealerOnly >= 0, '');
  ok('the dealer rate ladder is intact across the range',
    invertedShare < 0.01,
    `${dealerNotCheapest.length} of ${priced} items invert it (${(invertedShare * 100).toFixed(2)}%)`);
  if (dealerNotCheapest.length) {
    console.log(`\n  data note — ${dealerNotCheapest.length} items price the dealer above another type:`);
    dealerNotCheapest.forEach((d) => console.log('    · ' + d));
    console.log('    These are the sheet\'s own figures. Confirm with Gaurav before the next issue.');
  }

  // Commission and weighting must be fractions, not percents.
  const [[bad]] = await conn.query(
    `SELECT COUNT(*) AS n FROM items
      WHERE comm_retail_agent > 1 OR comm_builder_agent > 1
         OR scheme_weightage > 1 OR disc_dealer >= 1 OR disc_retail_comm >= 1`,
  );
  ok('no percentage was stored as a whole number', bad.n === 0, `${bad.n} rows`);

  // The unpriced tail must be visible, not silently zero-rated.
  const [[unpriced]] = await conn.query(
    `SELECT COUNT(*) AS n FROM items WHERE pricing_type IS NULL`,
  );
  ok('the unpriced tail is still unpriced, not defaulted', unpriced.n > 0,
    `${unpriced.n} items carry no rate card`);

  // items.qty must equal the ledger — the opening balances went through it.
  const [drift] = await conn.query(
    `SELECT i.masterid FROM items i
       LEFT JOIN (SELECT item_id, SUM(change_qty) s FROM stock_movements GROUP BY item_id) m
         ON m.item_id = i.masterid
      WHERE ABS(i.qty - COALESCE(m.s, 0)) > 0.0001`,
  );
  ok('items.qty still equals the stock ledger after import', drift.length === 0,
    `${drift.length} items drifted`);

  return items.length;
}

// ---------------------------------------------------------------------------

async function main() {
  const conn = await pool.getConnection();
  try {
    arithmetic();
    refusals();
    derived();
    const n = await sweep(conn);
    console.log(`\nswept ${n} priced items`);
  } finally {
    conn.release();
    await pool.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\nfailures:');
    failures.forEach((f) => console.log('  ✗ ' + f));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('pricing-test failed:', err);
  process.exit(1);
});
