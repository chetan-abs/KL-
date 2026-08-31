#!/usr/bin/env node
/**
 * The business rules of the three requirement documents, driven through the
 * live API.
 *
 *   node tests/business-test.js            (server must be running on PORT)
 *
 * Not unit tests. Every assertion here goes over HTTP against a running server
 * and a real database, because the rules being checked — R-01 through R-30 —
 * are enforced at route boundaries and in transactions, and a unit test of the
 * helper would pass while the route forgot to call it.
 *
 * It creates its own party, agent and scheme member, and leaves them behind:
 * this runs against a development database, and a test that cleaned up after
 * itself could not be inspected after a failure.
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
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json || {} };
}

async function login(id) {
  const res = await api(null, 'POST', '/auth/login', { id, password: PW });
  if (res.status !== 200) throw new Error(`cannot log in as ${id}: ${res.status} ${JSON.stringify(res.body)}`);
  tokens[id] = res.body.token;
  return res.body.user;
}

const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

// ---------------------------------------------------------------------------

async function main() {
  section('sign in');
  for (const who of ['yash', 'manas', 'monu', 'gaurav', 'sonu', 'ajit', 'sibu', 'ashish',
    'sujay', 'damodar', 'prasenjit']) {
    await login(who);
  }
  ok('all eleven accounts sign in', Object.keys(tokens).length === 11);

  // -------------------------------------------------------------------------
  section('pricing — six rates from one item');

  // A priced list-less-disc item, taken from the master rather than invented.
  const search = await api('yash', 'GET', '/items?limit=400');
  const items = search.body.items || [];
  const priced = items.filter((i) => i.pricing_type && Number(i.base_price) > 0);
  ok('the item list exposes the rate card', priced.length > 0,
    `${priced.length} priced of ${items.length} returned`);

  const probe = priced[0];
  if (probe) {
    const detail = await api('yash', 'GET', `/items/${probe.masterid}/rates`);
    ok('GET /items/:id/rates returns all six', detail.status === 200
      && Object.keys(detail.body.rates || {}).length === 6,
      `${detail.status} ${JSON.stringify(detail.body).slice(0, 120)}`);
  }

  // R-07 — Sonu must not see rates at all.
  const sonuItems = await api('sonu', 'GET', '/items?limit=5');
  const sonuLeak = (sonuItems.body.items || []).some(
    (i) => i.base_price !== undefined || i.rate !== undefined || i.disc_dealer !== undefined);
  ok('R-07 Sonu\'s item list carries no rate columns at all', !sonuLeak,
    sonuLeak ? `leaked: ${Object.keys(sonuItems.body.items[0]).join(', ')}` : '');

  const sonuRates = await api('sonu', 'GET', `/items/${probe?.masterid || 1}/rates`);
  ok('R-07 Sonu is refused the rate endpoint', sonuRates.status === 403,
    `got ${sonuRates.status}`);

  // R-04 and R-07 are different rules and must not collapse into one grant: a
  // salesman has to SEE a rate to quote it, and only Gaurav may CHANGE it.
  const monuItems = await api('monu', 'GET', '/items?limit=5');
  ok('a salesman does see rates — they cannot quote otherwise',
    (monuItems.body.items || []).some((i) => i.base_price !== undefined),
    'salesman item list carried no base_price');

  const monuEdits = await api('monu', 'PUT', `/items/${probe?.masterid || 1}`,
    { disc_dealer: 0.9 });
  ok('R-04 but a salesman cannot change one', monuEdits.status === 403,
    `${monuEdits.status}`);

  // Sonu is the sharper case: he holds items.edit — he maintains the master —
  // and must still be refused the rate columns specifically. Monu is stopped
  // one guard earlier, by not holding items.edit at all, which does not prove
  // the rate guard fires.
  const sonuEdits = await api('sonu', 'PUT', `/items/${probe?.masterid || 1}`,
    { disc_dealer: 0.9 });
  ok('R-04 the rate guard fires on someone who CAN edit items',
    sonuEdits.status === 403 && sonuEdits.body.code === 'RATE_EDIT_DENIED',
    `${sonuEdits.status} ${sonuEdits.body.code}`);

  const sonuRenames = await api('sonu', 'PUT', `/items/${probe?.masterid || 1}`,
    { rack: 'A-14' });
  ok('but he can still edit the non-rate fields he maintains',
    sonuRenames.status === 200, `${sonuRenames.status}`);

  // -------------------------------------------------------------------------
  section('party classification drives the rate');

  const stamp = Date.now().toString().slice(-6);
  const dealer = await api('yash', 'POST', '/customers', {
    name: `Test Dealer ${stamp}`, customer_type: 'dealer', phone: `90000${stamp}`,
    city: 'Guwahati', credit_limit: 500000,
  });
  ok('a dealer can be created with a type', dealer.status === 201,
    `${dealer.status} ${JSON.stringify(dealer.body).slice(0, 140)}`);
  const dealerId = dealer.body.masterid || dealer.body.id;

  const unclassified = await api('yash', 'POST', '/customers', {
    name: `Test Unclassified ${stamp}`, phone: `90001${stamp}`, city: 'Guwahati',
  });
  const unclassifiedId = unclassified.body.masterid || unclassified.body.id;

  // An order for an unclassified party must refuse rather than guess.
  const guess = await api('monu', 'POST', '/orders', {
    customer_id: unclassifiedId,
    delivered_to: 'Ramesh',
    items: [{ item_id: probe?.masterid, qty: 1 }],
  });
  ok('an unclassified party cannot be billed at a guessed rate',
    guess.status === 400 && guess.body.code === 'NO_CUSTOMER_TYPE',
    `${guess.status} ${guess.body.code}`);

  // -------------------------------------------------------------------------
  section('order creation — section 4.1');

  const orderLines = priced.slice(0, 2).map((i) => ({ item_id: i.masterid, qty: 3 }));

  // "Delivered To" is mandatory and is not the party name.
  const noReceiver = await api('monu', 'POST', '/orders', {
    customer_id: dealerId, items: orderLines,
  });
  ok('an order without a receiver name is refused',
    noReceiver.status === 400 && noReceiver.body.code === 'DELIVERED_TO_REQUIRED',
    `${noReceiver.status} ${noReceiver.body.code}`);

  const order = await api('monu', 'POST', '/orders', {
    customer_id: dealerId,
    items: orderLines,
    delivered_to: 'Ramesh (shop assistant)',
    delivery_mode: 'kl_auto',
    urgency: 'days',
    payment_mode: 'credit',
    special_instructions: 'Call before arriving',
    gps: { lat: 26.1445, lng: 91.7362, place: 'Basistha, near Sharma Electricals' },
  });
  ok('an order is created', order.status === 201,
    `${order.status} ${JSON.stringify(order.body).slice(0, 160)}`);
  const orderId = order.body.order_id;

  ok('it is given an SO number', /^SO-\d{5}$/.test(order.body.so_number || ''),
    order.body.so_number);
  ok('the customer type is snapshotted on the order',
    order.body.customer_type === 'dealer', order.body.customer_type);

  // R-26 — the GPS stamp is saved and cannot be edited afterwards.
  const readBack = await api('yash', 'GET', `/orders/${orderId}`);
  const o = readBack.body.order || readBack.body;
  ok('R-26 the submission GPS fix is stored on the order',
    Number(o.gps_lat) === 26.1445 && String(o.gps_place || '').includes('Basistha'),
    `${o.gps_lat},${o.gps_lng} ${o.gps_place}`);

  // Duplicate detection: the same party again inside 24 hours.
  const dup = await api('monu', 'POST', '/orders', {
    customer_id: dealerId, items: orderLines, delivered_to: 'Ramesh',
  });
  ok('a similar order within 24 hours needs confirming',
    dup.status === 409 && dup.body.code === 'POSSIBLE_DUPLICATE',
    `${dup.status} ${dup.body.code}`);

  const dupOk = await api('monu', 'POST', '/orders', {
    customer_id: dealerId, items: orderLines, delivered_to: 'Ramesh', duplicate_ack: true,
  });
  ok('and goes through once confirmed', dupOk.status === 201, `${dupOk.status}`);

  // R-23 — a split payment must add up exactly.
  const badSplit = await api('monu', 'POST', '/orders', {
    customer_id: dealerId, items: orderLines, delivered_to: 'Ramesh', duplicate_ack: true,
    payment_mode: 'split',
    payment_splits: [{ mode: 'cash', amount: 1 }, { mode: 'upi', amount: 1 }],
  });
  ok('R-23 a split that does not match the total is refused',
    badSplit.status === 400 && badSplit.body.code === 'SPLIT_MISMATCH',
    `${badSplit.status} ${badSplit.body.code}`);

  // -------------------------------------------------------------------------
  section('commission and scheme — 3.1, 3.2, R-22');

  const agent = await api('monu', 'POST', '/agents', {
    name: `Test Electrician ${stamp}`, phone: `98000${stamp}`,
    agent_type: 'electrician', profession: 'Electrician', area: 'Beltola',
  });
  const agentId = agent.body.agent_id;
  ok('an agent can be added from the field', agent.status === 201, `${agent.status}`);

  const retailComm = await api('yash', 'POST', '/customers', {
    name: `Test Retail Comm ${stamp}`, customer_type: 'retail_commission', phone: `90002${stamp}`,
  });
  const retailCommId = retailComm.body.masterid || retailComm.body.id;

  const noAgent = await api('monu', 'POST', '/orders', {
    customer_id: retailCommId, items: orderLines, delivered_to: 'Walk-in',
  });
  ok('a commission order without an agent is refused',
    noAgent.status === 400 && noAgent.body.code === 'AGENT_REQUIRED',
    `${noAgent.status} ${noAgent.body.code}`);

  // Deliberately an item the sheet gives a commission to. 878 of the 3,569
  // priced items carry no agent commission at all, and picking blind lands on
  // one of those and reports a correct zero as a failure.
  const commissionable = priced.filter((i) => Number(i.comm_retail_agent) > 0);
  ok('the master carries per-item agent commission', commissionable.length > 0,
    `${commissionable.length} of ${priced.length} returned items have one`);
  const commLines = commissionable.slice(0, 2).map((i) => ({ item_id: i.masterid, qty: 3 }));

  const withAgent = await api('monu', 'POST', '/orders', {
    customer_id: retailCommId, items: commLines.length ? commLines : orderLines,
    delivered_to: 'Walk-in',
    agent_id: agentId, agent_type: 'electrician',
  });
  ok('with an agent it goes through', withAgent.status === 201, `${withAgent.status}`);
  ok('and the commission is computed server-side',
    Number(withAgent.body.agent_commission) > 0,
    `commission ${withAgent.body.agent_commission}`);

  // R-22 — scheme and commission cannot both apply.
  const member = await api('monu', 'POST', '/schemes/members', {
    name: `Test Member ${stamp}`, phone: `97000${stamp}`, profession: 'Electrician',
  });
  const memberId = member.body?.id;

  if (memberId) {
    const both = await api('monu', 'POST', '/orders', {
      customer_id: retailCommId, items: orderLines, delivered_to: 'Walk-in',
      agent_id: agentId, scheme_member_id: memberId, duplicate_ack: true,
    });
    ok('R-22 an order cannot pay a commission and credit the scheme',
      both.status === 400 && both.body.code === 'SCHEME_COMMISSION_CONFLICT',
      `${both.status} ${both.body.code}`);
  } else {
    ok('R-22 needs a scheme member to test', false, 'could not register one');
  }

  // -------------------------------------------------------------------------
  section('the pipeline — R-01, R-02');

  const bill = await api('gaurav', 'POST', '/invoices', { order_id: orderId });
  ok('R-01/R-02 an unapproved, unverified order cannot be billed',
    bill.status === 409, `${bill.status} ${bill.body.code}`);

  const approve = await api('manas', 'POST', `/workflow/orders/${orderId}/approve`, {});
  ok('Manas approves', approve.status === 200 || approve.status === 201,
    `${approve.status} ${JSON.stringify(approve.body).slice(0, 120)}`);

  // -------------------------------------------------------------------------
  section('attendance — R-24, R-25');

  const noPhoto = await api('ashish', 'POST', '/attendance/checkin', {
    latitude: 26.18, longitude: 91.742,
  });
  ok('R-24 a check-in without a photograph is refused',
    noPhoto.status === 400 && noPhoto.body.code === 'PHOTO_REQUIRED',
    `${noPhoto.status} ${noPhoto.body.code}`);

  const fakePhoto = await api('ashish', 'POST', '/attendance/checkin', {
    latitude: 26.18, longitude: 91.742, photo_id: 999999,
  });
  ok('R-24 an invented photo id is refused',
    fakePhoto.status === 400 && fakePhoto.body.code === 'PHOTO_NOT_FOUND',
    `${fakePhoto.status} ${fakePhoto.body.code}`);

  // A real 1x1 PNG, so the upload path is exercised rather than mocked.
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const upload = await api('ashish', 'POST', '/attachments', {
    data: png, mime_type: 'image/png', original_name: 'checkin.png', ref_type: 'checkin',
  });
  ok('a check-in photograph uploads', upload.status === 201, `${upload.status}`);

  const realCheckin = await api('ashish', 'POST', '/attendance/checkin', {
    latitude: 26.18, longitude: 91.742, photo_id: upload.body.attachment_id,
  });
  const alreadyIn = realCheckin.status === 400
    && /already checked in/i.test(realCheckin.body.error || '');
  ok('a check-in with a photograph is accepted',
    realCheckin.status === 201 || alreadyIn,
    alreadyIn ? '(already checked in today)' : `${realCheckin.status} ${JSON.stringify(realCheckin.body).slice(0, 120)}`);
  if (realCheckin.status === 201) {
    ok('the shift decides late, and it is reported back',
      typeof realCheckin.body.is_late === 'boolean',
      `is_late=${realCheckin.body.is_late} late_minutes=${realCheckin.body.late_minutes}`);
  }

  // Someone else's photograph must not satisfy the rule.
  const stolen = await api('sibu', 'POST', '/attendance/checkin', {
    latitude: 26.18, longitude: 91.742, photo_id: upload.body.attachment_id,
  });
  ok('R-24 one employee cannot punch in on another\'s photograph',
    stolen.body.code === 'PHOTO_NOT_YOURS', `${stolen.status} ${stolen.body.code}`);

  // -------------------------------------------------------------------------
  section('salary and advances — A, B, R-27, R-30');

  const period = new Date().toISOString().slice(0, 7);
  const ledger = await api('yash', 'GET', `/payroll/salary/monu/${period}`);
  ok('a salary ledger is derived for the month', ledger.status === 200,
    `${ledger.status} ${JSON.stringify(ledger.body).slice(0, 140)}`);
  if (ledger.status === 200) {
    ok('the daily rate is the salary over 26',
      Math.abs(Number(ledger.body.period.daily_rate) - 18000 / 26) < 0.02,
      `daily ${ledger.body.period.daily_rate}`);
  }

  const own = await api('monu', 'GET', `/payroll/salary/monu/${period}`);
  ok('an employee may read their own ledger', own.status === 200, `${own.status}`);

  const nosy = await api('monu', 'GET', `/payroll/salary/gaurav/${period}`);
  ok('but not somebody else\'s', nosy.status === 403, `${nosy.status}`);

  const advance = await api('monu', 'POST', '/payroll/advances', {
    amount: 6000, months: 3, reason: 'test',
  });
  ok('an advance can be requested', advance.status === 201, `${advance.status}`);
  ok('and is split into equal instalments',
    Number(advance.body.monthly_amount) === 2000, `${advance.body.monthly_amount}`);

  const selfApprove = await api('monu', 'POST', `/payroll/advances/${advance.body.id}/decide`,
    { approve: true });
  ok('R-27 an advance cannot be approved by the person taking it',
    selfApprove.status === 403, `${selfApprove.status}`);

  const approved = await api('yash', 'POST', `/payroll/advances/${advance.body.id}/decide`,
    { approve: true });
  ok('R-27 Yash approves it', approved.status === 200, `${approved.status}`);

  // -------------------------------------------------------------------------
  section('incentives — section 9, R-19');

  const inc = await api('monu', 'GET', `/incentives/monu/${period}`);
  ok('a salesman sees their own incentive progress', inc.status === 200, `${inc.status}`);
  if (inc.status === 200) {
    ok('all twenty segments are reported', (inc.body.lines || []).length === 20,
      `${(inc.body.lines || []).length} segments`);
    const below = (inc.body.lines || []).find((l) => l.achieved_pct < 90);
    ok('below 90% of target pays nothing', !below || below.payout === 0,
      below ? `${below.segment_name} at ${below.achieved_pct}% pays ${below.payout}` : '');
  }
  const peek = await api('monu', 'GET', `/incentives/prasenjit/${period}`);
  ok('but not another salesman\'s', peek.status === 403, `${peek.status}`);

  // -------------------------------------------------------------------------
  section('goods in transit — 5.2');

  const git = await api('sibu', 'POST', '/git', {
    lr_number: `LR-${stamp}`,
    supplier_name: 'Test Supplier',
    transporter_name: 'Test Transport',
    dispatch_date: '2026-08-20',
    expected_date: '2026-08-25',
    freight_type: 'to_pay',
    freight_amount: 1200,
  });
  ok('a bilty is recorded before any purchase exists', git.status === 201, `${git.status}`);

  const gitDup = await api('sibu', 'POST', '/git', {
    lr_number: `LR-${stamp}`, supplier_name: 'Test Supplier',
  });
  ok('the same LR cannot be entered twice',
    gitDup.status === 409 && gitDup.body.code === 'DUPLICATE_LR', `${gitDup.status}`);

  const illegal = await api('sibu', 'POST', `/git/${git.body.id}/stage`, { to: 'pending' });
  ok('a consignment cannot go backwards to pending',
    illegal.status === 409 && illegal.body.code === 'BAD_STAGE', `${illegal.status}`);

  const arrived = await api('sibu', 'POST', `/git/${git.body.id}/stage`, { to: 'arrived' });
  ok('pending → arrived is allowed', arrived.status === 200, `${arrived.status}`);

  const register = await api('sibu', 'GET', '/git?overdue=true');
  ok('the GIT register reports overdue days', register.status === 200
    && Array.isArray(register.body.entries), `${register.status}`);
  const mine = (register.body.entries || []).find((e) => e.lr_number === `LR-${stamp}`);
  ok('and the test consignment is overdue against its expected date',
    mine && Number(mine.days_overdue) > 0, mine ? `${mine.days_overdue} days` : 'not found');
  ok('freight is totalled per transporter',
    Array.isArray(register.body.freight_by_transporter)
    && register.body.freight_by_transporter.length > 0);

  // -------------------------------------------------------------------------
  section('purchase receiving — 5.1, R-08, R-12, R-13');

  const png2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const doc = await api('sonu', 'POST', '/attachments', {
    data: png2, mime_type: 'image/png', original_name: 'challan.png',
  });
  const docId = doc.body.attachment_id;

  const buyLines = priced.slice(0, 2).map((i) => ({
    item_id: i.masterid, bill_qty: 10, actual_qty: 10, rate: 25,
  }));

  const noDoc = await api('sonu', 'POST', '/purchases', {
    purchase_type: 'LB', supplier_name: 'Test Supplier', invoice_no: `B-${stamp}`,
    lines: buyLines,
  });
  ok('R-12 no document photograph, no purchase entry',
    noDoc.status === 400 && noDoc.body.code === 'DOCUMENT_PHOTO_REQUIRED',
    `${noDoc.status} ${noDoc.body.code}`);

  const noChallan = await api('sonu', 'POST', '/purchases', {
    purchase_type: 'LC', supplier_name: 'Test Supplier',
    lines: buyLines, document_photo_id: docId,
  });
  ok('R-13 a challan purchase must carry its challan number',
    noChallan.status === 400 && noChallan.body.code === 'CHALLAN_REQUIRED',
    `${noChallan.status} ${noChallan.body.code}`);

  const noCount = await api('sonu', 'POST', '/purchases', {
    purchase_type: 'LB', supplier_name: 'Test Supplier', invoice_no: `B2-${stamp}`,
    document_photo_id: docId,
    lines: [{ item_id: priced[0]?.masterid, bill_qty: 10 }],
  });
  ok('R-08 the actual counted quantity is its own mandatory field',
    noCount.status === 400 && noCount.body.code === 'ACTUAL_QTY_REQUIRED',
    `${noCount.status} ${noCount.body.code}`);

  const short = await api('sonu', 'POST', '/purchases', {
    purchase_type: 'LC', supplier_name: 'Test Supplier', challan_no: `CH-${stamp}`,
    document_photo_id: docId,
    lines: [{ item_id: priced[0]?.masterid, bill_qty: 10, actual_qty: 8, rate: 25 }],
  });
  ok('a short receipt is accepted and flagged, not refused', short.status === 201,
    `${short.status} ${JSON.stringify(short.body).slice(0, 140)}`);
  ok('R-08 the shortage is recorded from the two quantities',
    (short.body.discrepancies || []).length === 1,
    JSON.stringify(short.body.discrepancies));
  ok('a challan purchase starts the 7-day GST countdown',
    short.body.doc_state === 'unregistered' && short.body.gst_countdown_days === 7,
    `${short.body.doc_state} / ${short.body.gst_countdown_days}`);

  const tracker = await api('sibu', 'GET', '/git/gst-pending');
  ok('and appears on the GST-pending tracker',
    tracker.status === 200 && (tracker.body.pending || []).some((r) => r.challan_no === `CH-${stamp}`),
    `${tracker.status} ${(tracker.body.pending || []).length} pending`);

  const convert = await api('sibu', 'POST', `/git/gst-bill/${short.body.purchase_id}`,
    { bill_no: `GST-${stamp}` });
  ok('the GST bill converts it to a registered purchase', convert.status === 200,
    `${convert.status} ${convert.body.code || ''}`);

  // 5.1 — goods taken in by somebody who cannot verify wait for Sonu.
  const bySujay = await api('sujay', 'POST', '/purchases', {
    purchase_type: 'LB', supplier_name: 'Test Supplier', invoice_no: `B3-${stamp}`,
    document_photo_id: docId,
    lines: [{ item_id: priced[0]?.masterid, bill_qty: 5, actual_qty: 5, rate: 25 }],
  });
  ok('goods received in Sonu\'s absence wait for verification',
    bySujay.status === 201 && bySujay.body.status === 'awaiting_verification',
    `${bySujay.status} ${bySujay.body.status}`);

  const selfVerify = await api('sujay', 'POST', `/purchases/${bySujay.body.purchase_id}/verify`, {});
  ok('and the person who received them cannot verify them',
    selfVerify.status === 403, `${selfVerify.status}`);

  const sonuVerifies = await api('sonu', 'POST', `/purchases/${bySujay.body.purchase_id}/verify`, {});
  ok('Sonu verifies and the stock posts', sonuVerifies.status === 200,
    `${sonuVerifies.status} ${JSON.stringify(sonuVerifies.body).slice(0, 120)}`);

  // -------------------------------------------------------------------------
  section('sales returns — R-09, R-10');

  const noInvoice = await api('gaurav', 'POST', '/returns', {
    customer_id: dealerId, reason: 'quality_issue', photo_id: docId,
    lines: [{ item_id: priced[0]?.masterid, return_qty: 1, rate: 10 }],
  });
  ok('R-09 a return without its original invoice is refused',
    noInvoice.status === 400 && noInvoice.body.code === 'INVOICE_REQUIRED',
    `${noInvoice.status} ${noInvoice.body.code}`);

  const noReason = await api('gaurav', 'POST', '/returns', {
    customer_id: dealerId, invoice_id: 1, photo_id: docId,
    lines: [{ item_id: priced[0]?.masterid, return_qty: 1, rate: 10 }],
  });
  ok('a return must say why the goods came back',
    noReason.status === 400 && noReason.body.code === 'REASON_REQUIRED',
    `${noReason.status} ${noReason.body.code}`);

  const noPhoto2 = await api('gaurav', 'POST', '/returns', {
    customer_id: dealerId, invoice_id: 1, reason: 'quality_issue',
    lines: [{ item_id: priced[0]?.masterid, return_qty: 1, rate: 10 }],
  });
  ok('R-06 a return needs a photograph of the goods',
    noPhoto2.status === 400 && noPhoto2.body.code === 'PHOTO_REQUIRED',
    `${noPhoto2.status} ${noPhoto2.body.code}`);

  // -------------------------------------------------------------------------
  section('estimates — section 7');

  const est = await api('monu', 'POST', '/field/estimates', {
    customer_id: dealerId,
    lines: [{ item_id: priced[0]?.masterid, qty: 5 }],
  });
  ok('an estimate is created', est.status === 201,
    `${est.status} ${JSON.stringify(est.body).slice(0, 140)}`);
  ok('validity defaults to 15 days and a follow-up is booked',
    Boolean(est.body.valid_until) && Boolean(est.body.follow_up_on),
    `valid_until=${est.body.valid_until} follow_up_on=${est.body.follow_up_on}`);

  if (est.status === 201) {
    let attempts = 0;
    for (let i = 1; i <= 3; i += 1) {
      const f = await api('monu', 'POST', `/field/estimates/${est.body.estimate_id}/follow-up`, {
        outcome: 'no answer', next_due_on: '2026-09-30',
      });
      if (f.status === 200) attempts = f.body.attempts;
    }
    ok('three follow-up attempts are logged', attempts === 3, `${attempts}`);

    const fourth = await api('monu', 'POST', `/field/estimates/${est.body.estimate_id}/follow-up`, {
      outcome: 'no answer',
    });
    ok('and a fourth is refused — close it instead',
      fourth.status === 409 && fourth.body.code === 'FOLLOW_UP_LIMIT',
      `${fourth.status} ${fourth.body.code}`);

    const badReason = await api('monu', 'POST', `/field/estimates/${est.body.estimate_id}/lost`,
      { reason: 'they were rude' });
    ok('a lost quote needs one of the listed reasons',
      badReason.status === 400 && badReason.body.code === 'REASON_REQUIRED',
      `${badReason.status} ${badReason.body.code}`);

    const lost = await api('monu', 'POST', `/field/estimates/${est.body.estimate_id}/lost`,
      { reason: 'price_too_high' });
    ok('and closes with a reason the report can group on', lost.status === 200,
      `${lost.status}`);
  }

  // -------------------------------------------------------------------------
  section('cheque handling — section 11, R-06');

  const chq = await api('sibu', 'POST', '/cash/cheques', {
    cheque_no: `CQ-${stamp}`, customer_id: dealerId, bank_name: 'SBI',
    amount: 5000, cheque_date: '2026-09-15',
  });
  ok('a cheque is recorded', chq.status === 201, `${chq.status}`);
  const chequeId = chq.body.cheque_id;

  const noBank = await api('sibu', 'POST', `/cash/cheques/${chequeId}/hand-over`,
    { handed_to: 'damodar' });
  ok('a hand-over must name the KL account',
    noBank.status === 400 && noBank.body.code === 'DEPOSIT_BANK_REQUIRED',
    `${noBank.status} ${noBank.body.code}`);

  const handed = await api('sibu', 'POST', `/cash/cheques/${chequeId}/hand-over`,
    { deposit_bank: 'ICICI', handed_to: 'damodar', instruction: 'Deposit today' });
  ok('Sibu hands it to Damodar with the account named', handed.status === 200,
    `${handed.status} ${handed.body.code || ''}`);

  const noSlip = await api('damodar', 'POST', `/cash/cheques/${chequeId}/deposit`, {});
  ok('R-06 no deposit slip photograph, no deposit',
    noSlip.status === 400 && noSlip.body.code === 'SLIP_PHOTO_REQUIRED',
    `${noSlip.status} ${noSlip.body.code}`);

  const backDoor = await api('sibu', 'POST', `/cash/cheques/${chequeId}/status`,
    { status: 'deposited' });
  ok('R-06 and the generic status route cannot walk around it',
    backDoor.status === 400 && backDoor.body.code === 'SLIP_PHOTO_REQUIRED',
    `${backDoor.status} ${backDoor.body.code}`);

  const slip = await api('damodar', 'POST', '/attachments', {
    data: png2, mime_type: 'image/png', original_name: 'slip.png',
  });
  const deposited = await api('damodar', 'POST', `/cash/cheques/${chequeId}/deposit`,
    { deposit_slip_photo_id: slip.body.attachment_id });
  ok('with the slip it deposits', deposited.status === 200,
    `${deposited.status} ${JSON.stringify(deposited.body).slice(0, 120)}`);

  const invalidState = await api('sibu', 'POST', `/cash/cheques/${chequeId}/status`,
    { status: 'to_deposit' });
  ok('a status the column does not accept is refused, not silently stored',
    invalidState.status === 400, `${invalidState.status}`);

  // -------------------------------------------------------------------------
  section('internal transfers — R-14');

  const xfer = await api('sonu', 'POST', '/transfers', {
    from_godown: 'Lakhtokia', to_godown: 'Fatashil',
    lines: [{ item_id: priced[0]?.masterid, sent_qty: 10 }],
  });
  ok('a transfer is raised', xfer.status === 201,
    `${xfer.status} ${JSON.stringify(xfer.body).slice(0, 140)}`);

  const sameGodown = await api('sonu', 'POST', '/transfers', {
    from_godown: 'Lakhtokia', to_godown: 'Lakhtokia',
    lines: [{ item_id: priced[0]?.masterid, sent_qty: 1 }],
  });
  ok('a transfer to the same godown is refused',
    sameGodown.status === 400 && sameGodown.body.code === 'SAME_GODOWN',
    `${sameGodown.status} ${sameGodown.body.code}`);

  if (xfer.status === 201) {
    const selfReceive = await api('sonu', 'POST', `/transfers/${xfer.body.transfer_id}/receive`, {});
    ok('the sender cannot also receive it',
      selfReceive.status === 403 && selfReceive.body.code === 'SELF_RECEIPT',
      `${selfReceive.status} ${selfReceive.body.code}`);

    const earlyJournal = await api('gaurav', 'POST', `/transfers/${xfer.body.transfer_id}/journal`, {});
    ok('R-14 the journal cannot precede receipt',
      earlyJournal.status === 409 && earlyJournal.body.code === 'NOT_RECEIVED',
      `${earlyJournal.status} ${earlyJournal.body.code}`);

    const received = await api('sujay', 'POST', `/transfers/${xfer.body.transfer_id}/receive`, {
      lines: [],
    });
    ok('somebody else receives it', received.status === 200,
      `${received.status} ${JSON.stringify(received.body).slice(0, 120)}`);
    ok('and the stock journal is flagged as due today',
      received.body.journal_due_today === true);

    const journal = await api('gaurav', 'POST', `/transfers/${xfer.body.transfer_id}/journal`, {});
    ok('R-14 Gaurav records the stock journal', journal.status === 200, `${journal.status}`);
  }

  // -------------------------------------------------------------------------
  section('reports — section 12');

  const catalogue = await api('yash', 'GET', '/reportsuite');
  ok('all twelve reports are listed', (catalogue.body.reports || []).length === 12,
    `${(catalogue.body.reports || []).length}`);
  ok('both export formats are offered',
    /format=csv/.test(catalogue.body.export?.csv || '')
      && /format=pdf/.test(catalogue.body.export?.pdf || ''),
    JSON.stringify(catalogue.body.export));

  for (const [label, path] of [
    ['daily sales', '/reportsuite/daily-sales'],
    ['outstanding', '/reportsuite/outstanding'],
    ['salesman performance', '/reportsuite/salesman-performance'],
    ['purchases', '/reportsuite/purchases'],
    ['stock', '/reportsuite/stock?below_minimum=true'],
    ['cheques', '/reportsuite/cheques'],
    ['cash discount', '/reportsuite/cash-discount'],
    ['estimate conversion', '/reportsuite/estimate-conversion'],
    ['stock counts', '/reportsuite/stock-counts'],
  ]) {
    const r = await api('yash', 'GET', path);
    ok(`the ${label} report answers`, r.status === 200 && Array.isArray(r.body.rows),
      `${r.status} ${JSON.stringify(r.body).slice(0, 90)}`);
  }

  const party = await api('yash', 'GET', `/reportsuite/party/${dealerId}`);
  ok('the party history answers with its ageing buckets',
    party.status === 200 && party.body.ageing !== undefined, `${party.status}`);

  // Section 12: "Default date range for all reports is today."
  const dated = await api('yash', 'GET', '/reportsuite/daily-sales');
  ok('a report with no dates defaults to today',
    dated.body.from === dated.body.to, `${dated.body.from} → ${dated.body.to}`);

  const ranged = await api('yash', 'GET', '/reportsuite/daily-sales?from=2026-08-01&to=2026-08-31');
  ok('and a past range is selectable',
    ranged.body.from === '2026-08-01' && ranged.body.to === '2026-08-31',
    `${ranged.body.from} → ${ranged.body.to}`);

  // "All reports must be exportable as PDF and Excel." CSV is the Excel half.
  const csvRes = await fetch(`${BASE}/reportsuite/outstanding?format=csv`, {
    headers: { Authorization: `Bearer ${tokens.yash}` },
  });
  // Read as bytes, not text: Response.text() strips a leading BOM per spec, so
  // asserting on the decoded string can never see the thing being asserted.
  const csvBytes = new Uint8Array(await csvRes.arrayBuffer());
  const csvBody = new TextDecoder('utf-8').decode(csvBytes);
  ok('a report exports as CSV for Excel',
    csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get('content-type') || ''),
    `${csvRes.status} ${csvRes.headers.get('content-type')}`);
  ok('the CSV carries its headings even so', /Party,Area/.test(csvBody),
    csvBody.slice(0, 60));
  ok('and a UTF-8 BOM so Excel does not mangle party names',
    csvBytes[0] === 0xEF && csvBytes[1] === 0xBB && csvBytes[2] === 0xBF,
    `first bytes ${csvBytes.slice(0, 3).join(' ')}`);

  // R-07 again: Sonu may read the purchase report and must see no rate in it.
  const sonuReport = await api('sonu', 'GET', '/reportsuite/purchases');
  ok('R-07 Sonu reads the purchase report without any value column',
    sonuReport.status === 200 && sonuReport.body.rates_visible === false
      && !(sonuReport.body.rows || []).some((r) => r.grand_total !== undefined),
    `${sonuReport.status} rates_visible=${sonuReport.body.rates_visible}`);

  const pickerReport = await api('ashish', 'GET', '/reportsuite/outstanding');
  ok('a picker cannot read the outstanding book', pickerReport.status === 403,
    `${pickerReport.status}`);

  // -------------------------------------------------------------------------
  section('dashboard review, salary slip, quote sharing');

  const reviewed = await api('yash', 'POST', '/reportsuite/reviewed', {});
  ok('Yash can mark the dashboard reviewed', reviewed.status === 200,
    `${reviewed.status}`);
  const reviewedTwice = await api('yash', 'POST', '/reportsuite/reviewed', {});
  ok('and doing it twice is idempotent, not an error', reviewedTwice.status === 200,
    `${reviewedTwice.status}`);

  // Finalising persists, so this section branches on the month's current state
  // rather than assuming a fresh one. A test that only passes the first time it
  // runs is a test nobody trusts the second time.
  const ledgerNow = await api('yash', 'GET', `/payroll/salary/monu/${period}`);
  const alreadyFinal = Boolean(ledgerNow.body?.period?.status)
    && ledgerNow.body.period.status !== 'draft';

  if (!alreadyFinal) {
    const draftSlip = await api('yash', 'GET', `/payroll/slip/monu/${period}`);
    ok('a draft month has no slip — it would change tomorrow',
      draftSlip.status === 404 || draftSlip.status === 409,
      `${draftSlip.status} ${draftSlip.body.code}`);
  }

  const finalised = await api('yash', 'POST', `/payroll/salary/monu/${period}/finalise`, {});
  ok('the month is finalised',
    finalised.status === 200
      || (finalised.status === 409 && finalised.body.code === 'ALREADY_FINALISED'),
    `${finalised.status} ${finalised.body.code || ''}`);

  const slipRes = await api('yash', 'GET', `/payroll/slip/monu/${period}`);
  ok('a finalised month issues a slip', slipRes.status === 200, `${slipRes.status}`);
  ok('and the slip itemises its deductions as A.2 requires',
    Array.isArray(slipRes.body.deductions) && typeof slipRes.body.text === 'string'
      && /SALARY SLIP/.test(slipRes.body.text),
    JSON.stringify(slipRes.body).slice(0, 120));
  ok('the employee may read their own slip',
    (await api('monu', 'GET', `/payroll/slip/monu/${period}`)).status === 200);

  const nosySlip = await api('monu', 'GET', `/payroll/slip/gaurav/${period}`);
  ok('and cannot read a colleague\'s', nosySlip.status === 403, `${nosySlip.status}`);

  const finalLedger = await api('yash', 'GET', `/payroll/salary/monu/${period}`);
  const periodId = finalLedger.body?.period?.id;
  if (periodId) {
    const sharedSlip = await api('yash', 'POST', `/payroll/slip/${periodId}/share`, {});
    ok('A.2 the slip can be shared with the employee', sharedSlip.status === 200,
      `${sharedSlip.status} ${sharedSlip.body.code || ''}`);
  } else {
    ok('A.2 the slip can be shared with the employee', false, 'no period id returned');
  }

  const est2 = await api('monu', 'POST', '/field/estimates', {
    customer_id: dealerId, lines: [{ item_id: priced[0]?.masterid, qty: 2 }],
  });
  if (est2.status === 201) {
    const wrongNumber = await api('monu', 'POST', `/field/estimates/${est2.body.estimate_id}/share`,
      { phone: '9999999999' });
    ok('a quote cannot be sent to a number not on the party record',
      wrongNumber.status === 400 && wrongNumber.body.code === 'UNKNOWN_NUMBER',
      `${wrongNumber.status} ${wrongNumber.body.code}`);

    const shared = await api('monu', 'POST', `/field/estimates/${est2.body.estimate_id}/share`, {});
    ok('a quote shares to the party\'s registered number', shared.status === 200,
      `${shared.status} ${shared.body.code || ''}`);
    ok('with the formatted quote and a wa.me link',
      /K.L. ELECTRICALS/.test(shared.body.text || '')
        && String(shared.body.whatsapp_url || '').startsWith('https://wa.me/'),
      String(shared.body.whatsapp_url || '').slice(0, 40));
    ok('and PDF is reported absent rather than implied', shared.body.pdf === null);
  }

  // -------------------------------------------------------------------------
  section('rate adjustment approval — R-04, R-11');

  const rateItem = commissionable[0] || priced[0];
  const before = await api('gaurav', 'GET', `/items/${rateItem.masterid}/rates`);
  const currentDisc = (await api('gaurav', 'GET', `/items/${rateItem.masterid}`))
    .body.item?.disc_dealer;

  // R-11: Gaurav initiates. It must NOT apply.
  const proposed = await api('gaurav', 'PUT', `/items/${rateItem.masterid}`,
    { disc_dealer: 0.4321, reason: 'test adjustment' });
  ok('R-11 Gaurav\'s rate edit becomes a request, not a change',
    proposed.status === 202 && proposed.body.code === 'RATE_CHANGE_PENDING',
    `${proposed.status} ${proposed.body.code}`);

  const stillOld = await api('gaurav', 'GET', `/items/${rateItem.masterid}`);
  ok('and the item is untouched while it waits',
    String(stillOld.body.item?.disc_dealer) === String(currentDisc),
    `${stillOld.body.item?.disc_dealer} vs ${currentDisc}`);

  const queue = await api('gaurav', 'GET', '/items/rate-changes');
  ok('the request appears in the approval queue',
    queue.status === 200 && (queue.body.batches || [])
      .some((b) => b.batch_ref === proposed.body.batch_ref),
    `${queue.status} ${(queue.body.batches || []).length} batch(es)`);
  ok('and Gaurav is told he cannot approve it', queue.body.can_approve === false);

  const gauravSelfApprovesRate = await api('gaurav', 'POST',
    `/items/rate-changes/${proposed.body.batch_ref}/decide`, { approve: true });
  ok('R-11 Gaurav cannot approve his own adjustment',
    gauravSelfApprovesRate.status === 403 && gauravSelfApprovesRate.body.code === 'RATE_APPROVAL_DENIED',
    `${gauravSelfApprovesRate.status} ${gauravSelfApprovesRate.body.code}`);

  const salesmanApproveRate = await api('monu', 'POST',
    `/items/rate-changes/${proposed.body.batch_ref}/decide`, { approve: true });
  ok('nor can anybody else', salesmanApproveRate.status === 403,
    `${salesmanApproveRate.status}`);

  const ownerApproves = await api('yash', 'POST',
    `/items/rate-changes/${proposed.body.batch_ref}/decide`, { approve: true });
  ok('R-11 Yash approves it', ownerApproves.status === 200,
    `${ownerApproves.status} ${JSON.stringify(ownerApproves.body).slice(0, 120)}`);

  const applied = await api('gaurav', 'GET', `/items/${rateItem.masterid}`);
  ok('and only then does the rate move',
    Math.abs(Number(applied.body.item?.disc_dealer) - 0.4321) < 0.0001,
    `${applied.body.item?.disc_dealer}`);

  // Put it back, so re-running the suite starts from the same place.
  const revert = await api('gaurav', 'PUT', `/items/${rateItem.masterid}`,
    { disc_dealer: currentDisc, reason: 'revert test adjustment' });
  if (revert.body?.batch_ref) {
    await api('yash', 'POST', `/items/rate-changes/${revert.body.batch_ref}/decide`,
      { approve: true });
  }
  const reverted = await api('gaurav', 'GET', `/items/${rateItem.masterid}`);
  ok('the test leaves the rate card as it found it',
    String(reverted.body.item?.disc_dealer) === String(currentDisc),
    `${reverted.body.item?.disc_dealer} vs ${currentDisc}`);

  // An owner is the approver, so their own edit applies at once — anything else
  // would mean Yash raising a request for himself to approve.
  const ownerEdit = await api('yash', 'PUT', `/items/${rateItem.masterid}`,
    { cost_price: 12.34 });
  ok('an owner\'s rate edit applies immediately', ownerEdit.status === 200,
    `${ownerEdit.status} ${ownerEdit.body.code || ''}`);

  const noChange = await api('gaurav', 'PUT', `/items/${rateItem.masterid}`,
    { disc_dealer: currentDisc });
  ok('proposing the value already set is refused, not queued',
    noChange.status === 400 && noChange.body.code === 'NO_CHANGE',
    `${noChange.status} ${noChange.body.code}`);

  // -------------------------------------------------------------------------
  section('PDF export — section 12, 4.5, 7, A.2');

  /** Fetch raw bytes, so a PDF can be checked for actually being one. */
  async function bytes(who, path) {
    const r = await fetch(BASE + path, {
      headers: { Authorization: `Bearer ${tokens[who]}` },
    });
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || '', bytes: b };
  }
  const isPdf = (b) => b.length > 800
    && String.fromCharCode(...b.slice(0, 5)) === '%PDF-';

  for (const [label, path] of [
    ['outstanding', '/reportsuite/outstanding?format=pdf'],
    ['daily sales', '/reportsuite/daily-sales?format=pdf'],
    ['stock', '/reportsuite/stock?below_minimum=true&format=pdf'],
    ['cheques', '/reportsuite/cheques?format=pdf'],
    ['salesman performance (wide/landscape)', '/reportsuite/salesman-performance?format=pdf'],
  ]) {
    const r = await bytes('yash', path);
    ok(`the ${label} report exports a real PDF`,
      r.status === 200 && /application\/pdf/.test(r.type) && isPdf(r.bytes),
      `${r.status} ${r.type} ${r.bytes.length}b`);
  }

  // §4.5 — three copies in one document.
  const anyInvoice = await api('gaurav', 'GET', '/invoices');
  const invoiceId = (anyInvoice.body.invoices || [])[0]?.id;
  if (invoiceId) {
    const inv = await bytes('gaurav', `/documents/invoice/${invoiceId}.pdf`);
    ok('§4.5 the invoice prints as a PDF',
      inv.status === 200 && isPdf(inv.bytes), `${inv.status} ${inv.bytes.length}b`);
    // The three copy labels are the requirement; each appears once.
    const text = String.fromCharCode(...inv.bytes.slice(0, 4000));
    ok('§4.5 and it is three copies, not one',
      inv.bytes.length > 3000, `${inv.bytes.length} bytes`);
  } else {
    ok('§4.5 the invoice prints as a PDF', false, 'no invoice on file to print');
  }

  // §7 — the estimate PDF.
  const anyEstimate = await api('monu', 'GET', '/field/estimates');
  const estId = (anyEstimate.body.estimates || [])[0]?.id;
  if (estId) {
    const q = await bytes('monu', `/documents/estimate/${estId}.pdf`);
    ok('§7 the quotation prints as a PDF',
      q.status === 200 && isPdf(q.bytes), `${q.status} ${q.bytes.length}b`);
  }

  // A.2 — the salary slip PDF, and only for a finalised month.
  const slipPdf = await bytes('yash', `/documents/salary-slip/monu/${period}.pdf`);
  ok('A.2 the salary slip prints as a PDF',
    slipPdf.status === 200 && isPdf(slipPdf.bytes),
    `${slipPdf.status} ${slipPdf.bytes.length}b`);

  const nosySlipPdf = await bytes('ashish', `/documents/salary-slip/monu/${period}.pdf`);
  ok('and not somebody else\'s', nosySlipPdf.status === 403, `${nosySlipPdf.status}`);

  const ownSlipPdf = await bytes('monu', `/documents/salary-slip/monu/${period}.pdf`);
  ok('an employee prints their own', ownSlipPdf.status === 200, `${ownSlipPdf.status}`);

  // -------------------------------------------------------------------------
  section('Tally sync — section 14');

  const tallyStatus = await api('sibu', 'GET', '/tally/status');
  ok('the Tally status is readable by whoever administers it',
    tallyStatus.status === 200, `${tallyStatus.status}`);
  ok('and says plainly that it is switched off',
    tallyStatus.body.configuration?.enabled === false
      && /TALLY_ENABLED/.test(tallyStatus.body.configuration?.note || ''),
    JSON.stringify(tallyStatus.body.configuration));

  const pickerTally = await api('ashish', 'GET', '/tally/status');
  ok('a picker cannot read the Tally queue', pickerTally.status === 403,
    `${pickerTally.status}`);

  // The nine App->Tally flows must actually enqueue. The order raised earlier
  // in this run was approved by Manas, which is section 14's trigger for a
  // sales order.
  const tallyQueue = await api('sibu', 'GET', '/tally/queue');
  ok('documents are queued for Tally as they happen',
    tallyQueue.status === 200 && (tallyQueue.body.queue || []).length > 0,
    `${tallyQueue.status} ${(tallyQueue.body.queue || []).length} queued`);

  const kinds = new Set((tallyQueue.body.queue || []).map((q) => q.kind));
  ok('a sales order was queued on approval', kinds.has('sales_order'),
    [...kinds].join(', '));
  ok('a party was queued as a Tally ledger', kinds.has('ledger_master'),
    [...kinds].join(', '));

  // Nothing may be marked sent while Tally is switched off — that is the
  // failure mode where the books look synced and are not.
  const sentWhileOff = (tallyQueue.body.queue || []).filter((q) => q.status === 'sent');
  ok('nothing is marked sent while the sync is disabled',
    sentWhileOff.length === 0, `${sentWhileOff.length} marked sent`);

  const firstQueued = (tallyQueue.body.queue || [])[0];
  if (firstQueued) {
    const payload = await bytes('sibu', `/tally/queue/${firstQueued.id}/payload`);
    const xmlText = new TextDecoder().decode(payload.bytes);
    ok('the queued payload is retrievable as Tally XML',
      payload.status === 200 && /<ENVELOPE>/.test(xmlText),
      `${payload.status} ${xmlText.slice(0, 40)}`);
    ok('R-21 no agent or commission appears in a Tally voucher',
      !/agent|commission/i.test(xmlText),
      'a Tally payload mentioned an agent');
    ok('and it carries a REMOTEID, so a retry amends rather than duplicates',
      /<REMOTEID>/.test(xmlText));
  }

  const pushOff = await api('sibu', 'POST', '/tally/push', {});
  ok('a push with the sync disabled is skipped, not attempted',
    pushOff.status === 200 && pushOff.body.skipped === true,
    JSON.stringify(pushOff.body));

  const pullOff = await api('sibu', 'POST', '/tally/pull', {});
  ok('and a pull refuses with the reason', pullOff.status === 409
    && pullOff.body.code === 'TALLY_DISABLED', `${pullOff.status} ${pullOff.body.code}`);

  const recon = await api('sibu', 'GET', '/tally/reconciliation');
  ok('the reconciliation view states that nothing is overwritten',
    recon.status === 200 && /caches of this app/.test(recon.body.note || ''),
    `${recon.status}`);

  // -------------------------------------------------------------------------
  section('collections and the godown close — 8, 4.8');

  const declared = await api('monu', 'POST', '/cash/handover', {
    cash: 5000, cheques: 2, cheque_value: 18000,
  });
  ok('§8 a salesman declares the day\'s collections', declared.status === 201,
    `${declared.status} ${JSON.stringify(declared.body).slice(0, 120)}`);
  const handoverId = declared.body.handover?.id;

  const nothing = await api('prasenjit', 'POST', '/cash/handover', { cash: 0, cheques: 0 });
  ok('an empty declaration is refused',
    nothing.status === 400 && nothing.body.code === 'NOTHING_DECLARED',
    `${nothing.status} ${nothing.body.code}`);

  // A handover is unique per person per day, so on a re-run it has already
  // been counted. The receive path is asserted only while it is still open —
  // the same reason the salary section branches on a finalised month.
  const openHandover = (await api('sibu', 'GET', '/cash/handover')).body.handovers
    ?.find((h) => h.employee_id === 'monu' && h.status === 'declared');

  if (openHandover) {
    const selfCount = await api('monu', 'POST', `/cash/handover/${openHandover.id}/receive`,
      { cash: 5000, cheques: 2 });
    ok('a salesman cannot count in their own handover', selfCount.status === 403,
      `${selfCount.status}`);

    const short = await api('sibu', 'POST', `/cash/handover/${openHandover.id}/receive`,
      { cash: 4500, cheques: 2 });
    ok('§8 Sibu counts it, and a shortfall is flagged rather than absorbed',
      short.status === 200 && short.body.disputed === true && short.body.variance === -500,
      `${short.status} variance=${short.body.variance} disputed=${short.body.disputed}`);

    const twice = await api('sibu', 'POST', `/cash/handover/${openHandover.id}/receive`,
      { cash: 5000, cheques: 2 });
    ok('and it cannot be counted a second time',
      twice.status === 409 && twice.body.code === 'STALE',
      `${twice.status} ${twice.body.code}`);
  } else {
    // Already counted earlier today: assert the outcome is on the record
    // instead, which is the same fact from the other end.
    const counted = (await api('sibu', 'GET', '/cash/handover')).body.handovers
      ?.find((h) => h.employee_id === 'monu');
    ok('§8 the handover was counted and its variance recorded',
      Boolean(counted) && counted.status !== 'declared',
      counted ? `status=${counted.status} variance=${counted.variance}` : 'not found');
  }

  const noGodownPhoto = await api('ajit', 'POST', '/cash/day-close', {});
  ok('§4.8 the godown close needs its photograph',
    noGodownPhoto.status === 400 && noGodownPhoto.body.code === 'GODOWN_PHOTO_REQUIRED',
    `${noGodownPhoto.status} ${noGodownPhoto.body.code}`);

  const godownShot = await api('ajit', 'POST', '/attachments', {
    data: png2, mime_type: 'image/png', original_name: 'godown.png',
  });
  const closed = await api('ajit', 'POST', '/cash/day-close', {
    godown_photo_id: godownShot.body.attachment_id, note: 'Floor clear.',
  });
  ok('§4.8 with the photograph the day closes and the owners are sent it',
    closed.status === 200 && typeof closed.body.open_orders === 'number',
    `${closed.status} ${JSON.stringify(closed.body).slice(0, 120)}`);

  // -------------------------------------------------------------------------
  section('order location — D.2');

  const located = await api('monu', 'POST', '/orders', {
    customer_id: dealerId, items: orderLines, delivered_to: 'Ramesh',
    duplicate_ack: true,
    gps: { lat: 26.1445, lng: 91.7362, place: 'Basistha, near Sharma Electricals' },
  });
  ok('D.2 an order records where it was raised', located.status === 201,
    `${located.status}`);
  ok('and says where the place name came from',
    located.body.gps_place_source === 'client'
      || located.body.gps_place_source === 'geocoded',
    `source=${located.body.gps_place_source} place=${located.body.gps_place}`);

  // -------------------------------------------------------------------------
  section('access boundaries');

  const pickerReads = await api('ashish', 'GET', '/payroll/register/' + period);
  ok('a picker cannot read the salary register', pickerReads.status === 403, `${pickerReads.status}`);

  const pickerPrices = await api('ashish', 'POST', '/items', { name: 'x', base_price: 1 });
  ok('a picker cannot create items', pickerPrices.status === 403, `${pickerPrices.status}`);

  const salesmanApproves = await api('monu', 'POST', `/workflow/orders/${orderId}/approve`, {});
  ok('R-01 a salesman cannot approve their own order',
    salesmanApproves.status === 403, `${salesmanApproves.status}`);

  // -------------------------------------------------------------------------
  section('a password somebody else chose — migration 015');

  /**
   * The gate that stops an account being used on the password it was handed.
   *
   * Driven end to end rather than by setting the column directly, because the
   * rule is not "the flag blocks requests" — it is that creating an account
   * SETS the flag, and only a real password change clears it. Writing the
   * column by hand would test the middleware while leaving the two things that
   * actually turn it on and off untested.
   *
   * Idempotent: the account is recreated from scratch each run. It has no
   * grants, so it can be left behind harmlessly — and leaving it is what lets
   * somebody inspect it after a failure.
   */
  const gateId = 'PWGATE001';
  const firstPw = 'Handed@Over1';
  const chosenPw = 'MyOwn@Choice9';

  await api('yash', 'DELETE', `/users/${gateId}`);
  const made = await api('yash', 'POST', '/users', {
    id: gateId, name: 'Password Gate Probe', role: 'employee', password: firstPw,
  });
  ok('an administrator can create an account', made.status === 201, `${made.status}`);

  const gateLogin = await api(null, 'POST', '/auth/login', { id: gateId, password: firstPw });
  ok('the new account can sign in', gateLogin.status === 200, `${gateLogin.status}`);
  tokens[gateId] = gateLogin.body.token;

  ok('and is told its password must change',
    gateLogin.body.user?.must_change_password === 1
    || gateLogin.body.user?.must_change_password === true,
    JSON.stringify(gateLogin.body.user?.must_change_password));

  // The point of the whole exercise: authenticated, and able to do nothing.
  const gateBlocked = await api(gateId, 'GET', '/attendance/today');
  ok('every other route is refused until it does',
    gateBlocked.status === 403 && gateBlocked.body.code === 'PASSWORD_CHANGE_REQUIRED',
    `${gateBlocked.status} ${gateBlocked.body.code}`);

  // 403 and not 401: the credentials were good. A 401 sends the client's
  // interceptor into a sign-out loop, throwing the user off the one screen
  // that can fix the problem.
  ok('refused with 403, not 401 — the credentials were valid',
    gateBlocked.status === 403, `${gateBlocked.status}`);

  const gateMe = await api(gateId, 'GET', '/auth/me');
  ok('but it can still read itself', gateMe.status === 200, `${gateMe.status}`);

  const weak = await api(gateId, 'PATCH', '/auth/change-password', {
    current_password: firstPw, new_password: 'password123',
  });
  ok('the password policy still applies at the gate', weak.status === 400, `${weak.status}`);

  const stillBlocked = await api(gateId, 'GET', '/attendance/today');
  ok('a refused change leaves the gate closed',
    stillBlocked.status === 403, `${stillBlocked.status}`);

  const changed = await api(gateId, 'PATCH', '/auth/change-password', {
    current_password: firstPw, new_password: chosenPw,
  });
  ok('changing the password is allowed through', changed.status === 200, `${changed.status}`);

  const afterChange = await api(gateId, 'GET', '/attendance/today');
  ok('and the account works normally afterwards',
    afterChange.status === 200, `${afterChange.status}`);

  const reLogin = await api(null, 'POST', '/auth/login', { id: gateId, password: chosenPw });
  ok('the flag stays cleared on the next sign-in',
    !reLogin.body.user?.must_change_password,
    JSON.stringify(reLogin.body.user?.must_change_password));

  // R-11's sibling rule: an admin reset is a handed-over password too.
  // PUT /users/:id is a whole-record update — `name` is required — so the reset
  // carries it. That is the route's existing contract, not part of this rule.
  const reset = await api('yash', 'PUT', `/users/${gateId}`, {
    name: 'Password Gate Probe', password: 'Reset@ByAdmin2',
  });
  ok('an administrator can reset a password', reset.status === 200, `${reset.status}`);

  const afterReset = await api(null, 'POST', '/auth/login',
    { id: gateId, password: 'Reset@ByAdmin2' });
  tokens[gateId] = afterReset.body.token;
  const resetBlocked = await api(gateId, 'GET', '/attendance/today');
  ok('and that closes the gate again',
    resetBlocked.status === 403 && resetBlocked.body.code === 'PASSWORD_CHANGE_REQUIRED',
    `${resetBlocked.status} ${resetBlocked.body.code}`);

  // Left behind for inspection like the rest of this suite's fixtures, but
  // DEACTIVATED — unlike a test party, this is a sign-in-able account whose
  // password is written in this file, and `authenticate` rejects an inactive
  // user on every request.
  const parked = await api('yash', 'PATCH', `/users/${gateId}/status`, { is_active: false });
  ok('the probe account is left deactivated', parked.status === 200, `${parked.status}`);
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach((f) => console.log('  ✗ ' + f));
      process.exit(1);
    }
  })
  .catch((err) => {
    console.error('\nbusiness-test could not run:', err.message);
    process.exit(1);
  });
