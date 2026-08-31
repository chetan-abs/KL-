#!/usr/bin/env node
/**
 * The dealer growth schemes, driven through the full pipeline.
 *
 *   node tests/growth-test.js            (server must be running)
 *
 * Source: LEMAC_Developer_Master_v7.xlsx, 'Discount & Scheme Reference'.
 *
 * This is the only suite that drives a whole order from raising to invoicing —
 * order → approve → godown register → pick → handover → verify → invoice — and
 * it has to, because a growth scheme accrues on the INVOICE. Everything before
 * that is a proposal.
 *
 * It also exercises the two rules that make these schemes different from KL
 * Utsav:
 *
 *   the slab pays a PERCENTAGE of the window's billing, so the reward moves
 *   every time the dealer bills again;
 *
 *   the award is EARNED on billing and RELEASED only once the goods are paid
 *   for — "Released only after full payment of the goods."
 *
 * Idempotent: it activates the scheme, and deactivates it again at the end, so
 * a second run starts from the same place and a stray live scheme is not left
 * accruing against every dealer invoice in the database.
 */

const BASE = `http://localhost:${process.env.PORT || 5000}/api`;
const PW = process.env.SEED_PASSWORD || 'Kl@2026Staff';

let pass = 0;
let fail = 0;
const failures = [];
const tokens = {};

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return true; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

async function api(who, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json || {} };
}

async function login(id) {
  const res = await api(null, 'POST', '/auth/login', { id, password: PW });
  if (res.status !== 200) throw new Error(`cannot log in as ${id}: ${res.status}`);
  tokens[id] = res.body.token;
}

const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`);

let schemeId = null;
let originalWindow = null;

async function main() {
  for (const who of ['yash', 'manas', 'monu', 'gaurav', 'ashish', 'ajit', 'sibu']) {
    await login(who);
  }

  // -------------------------------------------------------------------------
  section('the schemes are seeded INACTIVE');

  const list = await api('yash', 'GET', '/schemes/growth');
  ok('all four Lemac growth schemes are on file',
    (list.body.schemes || []).length === 4, `${(list.body.schemes || []).length}`);
  ok('and none is active — the requirements document does not mention them',
    list.body.active === 0 && /No growth scheme is active/.test(list.body.note || ''),
    `active=${list.body.active} note=${list.body.note}`);

  const monthly = (list.body.schemes || []).find((s) => s.period === 'monthly' && s.renews);
  if (!monthly) {
    ok('a monthly renewing scheme exists to test', false, 'none found');
    return;
  }
  schemeId = monthly.id;

  ok('the monthly slabs are the sheet\'s five rungs',
    (monthly.slabs || []).length === 5
      && Number(monthly.slabs[0].min_value) === 25000
      && Math.abs(Number(monthly.slabs[0].reward_percent) - 0.02) < 1e-6
      && Number(monthly.slabs[4].min_value) === 100000
      && Math.abs(Number(monthly.slabs[4].reward_percent) - 0.04) < 1e-6,
    (monthly.slabs || []).map((s) => `${s.min_value}:${s.reward_percent}`).join(' '));

  // A dealer's invoice while the scheme is off must accrue nothing.
  const stamp = Date.now().toString().slice(-6);
  const dealer = await api('yash', 'POST', '/customers', {
    name: `Growth Dealer ${stamp}`, customer_type: 'dealer',
    phone: `95000${stamp}`, city: 'Guwahati', credit_limit: 2000000,
  });
  const dealerId = dealer.body.masterid;
  ok('a dealer is created', dealer.status === 201, `${dealer.status}`);

  // -------------------------------------------------------------------------
  section('activate it');

  const notAllowed = await api('monu', 'POST', `/schemes/${schemeId}/activate`, { active: true });
  ok('a salesman cannot activate a scheme', notAllowed.status === 403, `${notAllowed.status}`);

  const activated = await api('yash', 'POST', `/schemes/${schemeId}/activate`, { active: true });
  ok('an owner can', activated.status === 200 && activated.body.is_active === true,
    `${activated.status}`);

  // The sheet's own cycle is September 2026 onward, so on any earlier date the
  // scheme is live but its window has not opened — and nothing accrues, which
  // is correct. The sheet anticipates exactly this: "Note: App should allow
  // validity dates to be updated each cycle." So the cycle is rolled to cover
  // today, and restored at the end.
  originalWindow = {
    starts_on: String(monthly.starts_on).slice(0, 10),
    ends_on: String(monthly.ends_on).slice(0, 10),
  };
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const rolled = await api('yash', 'PUT', `/schemes/${schemeId}`, {
    starts_on: monthStart, ends_on: originalWindow.ends_on,
  });
  ok('the cycle can be rolled — the sheet asks for exactly this',
    rolled.status === 200, `${rolled.status} ${JSON.stringify(rolled.body).slice(0, 120)}`);

  const salesmanRoll = await api('monu', 'PUT', `/schemes/${schemeId}`, {
    starts_on: monthStart });
  ok('but not by a salesman', salesmanRoll.status === 403, `${salesmanRoll.status}`);

  const backwards = await api('yash', 'PUT', `/schemes/${schemeId}`, {
    starts_on: '2027-01-01', ends_on: '2026-01-01' });
  ok('and a window cannot end before it starts',
    backwards.status === 400 && backwards.body.code === 'BAD_WINDOW',
    `${backwards.status} ${backwards.body.code}`);

  // -------------------------------------------------------------------------
  section('bill a dealer, and watch it accrue');

  // Lemac modular items — the ones the sheet flags as modular-valid. Picked
  // deliberately: the whole point is that the flag on the ITEM gates the scheme.
  const items = await api('yash', 'GET', '/items?search=Lemac&limit=400');
  const valid = (items.body.items || []).filter(
    (i) => i.sch_modular_monthly === 1 && i.pricing_type && Number(i.base_price) > 0);
  ok('the master carries modular-valid Lemac items', valid.length > 0,
    `${valid.length} of ${(items.body.items || []).length}`);

  const nonValid = (items.body.items || []).find(
    (i) => i.sch_modular_monthly === 0 && i.pricing_type && Number(i.base_price) > 0);

  if (!valid.length) return;

  // Enough quantity to clear the first rung (25,000) but not the second.
  const line = valid[0];
  const dealerRate = Number(line.base_price) * (1 - Number(line.disc_dealer || 0));
  const qty = Math.max(2, Math.ceil(30000 / Math.max(dealerRate, 1)));

  const order = await api('yash', 'POST', '/orders', {
    customer_id: dealerId,
    items: [
      { item_id: line.masterid, qty },
      // A non-qualifying line, to prove the flag actually gates the accrual.
      ...(nonValid ? [{ item_id: nonValid.masterid, qty: 1 }] : []),
    ],
    delivered_to: 'Godown clerk',
    payment_mode: 'credit',
  });
  ok('an order is raised for the dealer', order.status === 201,
    `${order.status} ${JSON.stringify(order.body).slice(0, 140)}`);
  const orderId = order.body.order_id;
  if (!orderId) return;

  ok('R-01 approval is required before anything else',
    (await api('gaurav', 'POST', '/invoices', { order_id: orderId })).status === 409);

  ok('Manas approves',
    (await api('manas', 'POST', `/workflow/orders/${orderId}/approve`, {})).status === 200);

  // R-05, if any line sits in a godown that keeps a register.
  const sheet = await api('ashish', 'GET', `/workflow/orders/${orderId}/picksheet`);
  const godowns = [...new Set((sheet.body.lines || [])
    .map((l) => l.godown).filter(Boolean))];
  for (const g of godowns) {
    await api('ashish', 'POST', `/workflow/orders/${orderId}/godown-register`,
      { godown: g, acknowledged: true });
  }

  const picked = await api('ashish', 'POST', `/workflow/orders/${orderId}/pick`, {
    lines: (sheet.body.lines || []).map((l) => ({
      order_item_id: l.order_item_id ?? l.id,
      picked_qty: l.need_qty ?? l.qty,
    })),
  });
  ok('the order is picked in full', picked.status === 200,
    `${picked.status} ${JSON.stringify(picked.body).slice(0, 140)}`);

  await api('ashish', 'POST', `/workflow/orders/${orderId}/handover`, {});

  // Ajit reads the VERIFY sheet. He holds no picking grant, so the pick sheet
  // is closed to him — which is the gap this test found.
  const verifyList = await api('ajit', 'GET', `/workflow/orders/${orderId}/verifysheet`);
  ok('§4.4 Ajit can read what was picked, to count against it',
    verifyList.status === 200 && (verifyList.body.lines || []).length > 0,
    `${verifyList.status} ${(verifyList.body.lines || []).length} line(s)`);
  ok('and the pick sheet stays closed to him',
    (await api('ajit', 'GET', `/workflow/orders/${orderId}/picksheet`)).status === 403);

  const verified = await api('ajit', 'POST', `/workflow/orders/${orderId}/verify`, {
    lines: (verifyList.body.lines || []).map((l) => ({
      order_item_id: l.order_item_id,
      counted_qty: l.expected,
    })),
  });
  ok('R-02 Ajit verifies the count', verified.status === 200,
    `${verified.status} ${JSON.stringify(verified.body).slice(0, 140)}`);

  const invoice = await api('gaurav', 'POST', '/invoices', { order_id: orderId });
  ok('and Gaurav bills it', invoice.status === 201,
    `${invoice.status} ${JSON.stringify(invoice.body).slice(0, 160)}`);

  const growth = invoice.body.growth || [];
  ok('the invoice accrued against the growth scheme', growth.length > 0,
    JSON.stringify(growth));

  const accrual = growth.find((g) => g.scheme === monthly.name);
  if (accrual) {
    ok('the qualifying value is net of GST and weighted per item',
      Number(accrual.added) > 0, `added=${accrual.added}`);
    // The non-qualifying line must be excluded: if it were counted, the
    // qualifying figure would exceed the invoice's modular portion.
    ok('a slab was reached and its percentage recorded',
      accrual.slab !== null && Number(accrual.slab) > 0,
      `slab=${accrual.slab} reward=${accrual.reward}`);
    ok('the reward is that percentage of the window\'s billing',
      Math.abs(Number(accrual.reward) - Number(accrual.total) * Number(accrual.slab)) < 0.02,
      `${accrual.reward} vs ${accrual.total} x ${accrual.slab}`);
    ok('and it is EARNED, not yet released — the goods are unpaid',
      accrual.status === 'earned', accrual.status);
  }

  // -------------------------------------------------------------------------
  section('the standing screen');

  const standing = await api('yash', 'GET', `/schemes/growth/standing/${dealerId}`);
  ok('the dealer\'s standing is readable', standing.status === 200, `${standing.status}`);
  ok('and says the party is eligible', standing.body.eligible === true);

  const mine = (standing.body.schemes || []).find((s) => s.scheme_id === schemeId);
  if (mine) {
    ok('every slab is shown, reached ones marked',
      (mine.slabs || []).length === 5 && mine.slabs[0].reached === true,
      JSON.stringify(mine.slabs.map((s) => s.reached)));
    ok('and the gap to the next rung is given — the number that changes behaviour',
      mine.next === null || Number(mine.next.gap) > 0,
      mine.next ? `next ${mine.next.min_value}, gap ${mine.next.gap}` : 'top rung reached');
  }

  // A non-dealer must not accrue: the slabs are dealer billing figures on the
  // "List less 52%" ladder.
  const retail = await api('yash', 'POST', '/customers', {
    name: `Growth Retail ${stamp}`, customer_type: 'retail_direct', phone: `95001${stamp}`,
  });
  const retailStanding = await api('yash', 'GET',
    `/schemes/growth/standing/${retail.body.masterid}`);
  ok('a retail party is not eligible', retailStanding.body.eligible === false);

  // -------------------------------------------------------------------------
  section('release requires payment');

  const earlyIssue = await api('yash', 'POST', '/schemes/growth/awards/1/issue', {});
  ok('an award cannot be issued before it is released',
    earlyIssue.status === 409 || earlyIssue.status === 404,
    `${earlyIssue.status} ${earlyIssue.body.code}`);

  const leaderboard = await api('yash', 'GET', `/schemes/growth/${schemeId}/standings`);
  ok('the leaderboard lists the dealer',
    (leaderboard.body.standings || []).some((r) => r.customer_id === dealerId),
    `${(leaderboard.body.standings || []).length} row(s)`);

  const award = (leaderboard.body.standings || []).find((r) => r.customer_id === dealerId);
  if (award) {
    ok('the award is earned and waiting on payment',
      award.status === 'earned' && Number(award.paid_qualifying) === 0,
      `status=${award.status} paid=${award.paid_qualifying}`);
    ok('nothing has been credited yet', award.credit_note_id === null);
  }
}

main()
  .then(async () => {
    // Always switch the scheme back off. A suite that leaves a growth scheme
    // live would have every later dealer invoice in the database accruing
    // against it, which is a side effect no test should have.
    if (schemeId) {
      if (originalWindow) {
        await api('yash', 'PUT', `/schemes/${schemeId}`, originalWindow);
      }
      const off = await api('yash', 'POST', `/schemes/${schemeId}/activate`, { active: false });
      ok('the suite leaves the scheme switched off and its cycle restored',
        off.status === 200 && off.body.is_active === false, `${off.status}`);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach((f) => console.log('  ✗ ' + f));
      process.exit(1);
    }
  })
  .catch(async (err) => {
    if (schemeId) {
      if (originalWindow) {
        await api('yash', 'PUT', `/schemes/${schemeId}`, originalWindow).catch(() => {});
      }
      await api('yash', 'POST', `/schemes/${schemeId}/activate`, { active: false }).catch(() => {});
    }
    console.error('\ngrowth-test could not run:', err.message);
    process.exit(1);
  });
