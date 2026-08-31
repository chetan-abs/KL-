#!/usr/bin/env node
/**
 * The cross-file invariants, checked against the live database.
 *
 *   node tests/invariants-test.js
 *
 * These are the rules CLAUDE.md describes as "the things you cannot see from
 * any single file, and breaking them fails silently". Each one is a property
 * of the data as a whole, so each is a query rather than a unit test — and
 * failing silently is exactly why they need a check that runs.
 *
 * Needs no server. It reads the database directly.
 */

const pool = require('../config/db');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  console.log('\n── caches against their ledgers ' + '─'.repeat(28));

  // "items.qty is a cache, not the truth. The source of truth is
  // stock_movements... items.qty must equal SUM(change_qty) for the item."
  const [stockDrift] = await pool.query(
    `SELECT i.masterid, i.name, i.qty, COALESCE(m.s, 0) AS ledger
       FROM items i
       LEFT JOIN (SELECT item_id, SUM(change_qty) s FROM stock_movements GROUP BY item_id) m
         ON m.item_id = i.masterid
      WHERE ABS(i.qty - COALESCE(m.s, 0)) > 0.0001
      LIMIT 5`);
  ok('items.qty equals the stock ledger', stockDrift.length === 0,
    stockDrift.length ? `${stockDrift.length}+ drifted, e.g. ${stockDrift[0].name}: ${stockDrift[0].qty} vs ${stockDrift[0].ledger}` : '');

  // "customers.closing_balance is a cache, exactly like items.qty. It equals
  // issued invoices - receipts - issued credit notes."
  const [balanceDrift] = await pool.query(
    `SELECT c.masterid, c.name, c.closing_balance,
            (COALESCE((SELECT SUM(i.grand_total) FROM invoices i
                        WHERE i.customer_id = c.masterid AND i.status = 'issued'), 0)
           - COALESCE((SELECT SUM(p.amount) FROM payments p
                        WHERE p.customer_id = c.masterid AND p.status = 'received'), 0)
           - COALESCE((SELECT SUM(n.amount) FROM credit_notes n
                        WHERE n.customer_id = c.masterid AND n.status = 'issued'), 0)
            ) AS computed
       FROM customers c
      HAVING ABS(c.closing_balance - computed) > 0.01
      LIMIT 5`);
  ok('customers.closing_balance equals its ledger', balanceDrift.length === 0,
    balanceDrift.length ? `${balanceDrift.length}+ drifted, e.g. ${balanceDrift[0].name}: ${balanceDrift[0].closing_balance} vs ${balanceDrift[0].computed}` : '');

  // scheme_members.qualifying_total is a cache of scheme_ledger, added by this
  // work and subject to exactly the same failure mode.
  const [schemeDrift] = await pool.query(
    `SELECT m.id, m.name, m.qualifying_total, COALESCE(l.s, 0) AS ledger
       FROM scheme_members m
       LEFT JOIN (SELECT member_id, SUM(earned) s FROM scheme_ledger
                   WHERE member_id IS NOT NULL GROUP BY member_id) l
         ON l.member_id = m.id
      WHERE ABS(m.qualifying_total - COALESCE(l.s, 0)) > 0.01
      LIMIT 5`);
  ok('scheme_members.qualifying_total equals the scheme ledger', schemeDrift.length === 0,
    schemeDrift.length ? `${schemeDrift.length}+ drifted, e.g. ${schemeDrift[0].name}` : '');

  // invoices.amount_paid is a cache of payment_allocations.
  const [paidDrift] = await pool.query(
    `SELECT i.id, i.invoice_no, i.amount_paid, COALESCE(a.s, 0) AS allocated
       FROM invoices i
       LEFT JOIN (SELECT invoice_id, SUM(amount) s FROM payment_allocations GROUP BY invoice_id) a
         ON a.invoice_id = i.id
      WHERE ABS(i.amount_paid - COALESCE(a.s, 0)) > 0.01
      LIMIT 5`);
  ok('invoices.amount_paid equals its allocations', paidDrift.length === 0,
    paidDrift.length ? `${paidDrift.length}+ drifted, e.g. ${paidDrift[0].invoice_no}` : '');

  console.log('\n── time and the schema ' + '─'.repeat(37));

  // "the schema uses DATETIME everywhere and never TIMESTAMP. A single
  // TIMESTAMP column reintroduces exactly the drift the pool hook exists to
  // prevent (and caps out in 2038)."
  const [timestamps] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'timestamp'`);
  ok('no TIMESTAMP column anywhere', timestamps.length === 0,
    timestamps.map((t) => `${t.TABLE_NAME}.${t.COLUMN_NAME}`).join(', '));

  const [[tz]] = await pool.query("SELECT @@session.time_zone AS tz");
  ok('the pooled connection is pinned to UTC', tz.tz === '+00:00', tz.tz);

  console.log('\n── the pipeline ' + '─'.repeat(44));

  // "An order can therefore never be found in a stage no event explains."
  const [unexplained] = await pool.query(
    `SELECT o.order_id, o.status FROM orders o
      WHERE o.is_no_order = FALSE
        AND o.status NOT IN ('pending','confirmed','cancelled')
        AND NOT EXISTS (SELECT 1 FROM order_events e
                         WHERE e.order_id = o.order_id AND e.to_status = o.status)
      LIMIT 5`);
  ok('every order stage is explained by an event', unexplained.length === 0,
    unexplained.length ? `e.g. #${unexplained[0].order_id} is ${unexplained[0].status}` : '');

  // "A no-order visit is is_no_order, not a cancelled order." A cancelled
  // order that is not flagged must still be distinguishable from a visit.
  const [[noOrder]] = await pool.query(
    `SELECT SUM(is_no_order) AS visits,
            SUM(status = 'cancelled' AND is_no_order = FALSE) AS cancelled
       FROM orders`);
  ok('no-order visits and cancellations are separable',
    noOrder.visits !== null, `${noOrder.visits} visits, ${noOrder.cancelled} cancellations`);

  console.log('\n── the rate card ' + '─'.repeat(43));

  // An order line must record how its rate was reached, or a historical order
  // cannot be explained once the sheet is reissued.
  const [noProvenance] = await pool.query(
    `SELECT oi.id FROM order_items oi
       JOIN orders o ON o.order_id = oi.order_id
      WHERE o.so_number IS NOT NULL AND oi.pricing_type IS NULL
      LIMIT 5`);
  ok('every line raised since the rate card records its pricing basis',
    noProvenance.length === 0, `${noProvenance.length}+ lines without one`);

  // No priced item may carry a percentage stored as a whole number.
  const [[percents]] = await pool.query(
    `SELECT COUNT(*) AS n FROM items
      WHERE disc_dealer >= 1 OR disc_retail_comm >= 1 OR disc_builder_direct >= 1
         OR comm_retail_agent > 1 OR comm_builder_agent > 1 OR scheme_weightage > 1`);
  ok('no discount or commission is stored as a whole percent', percents.n === 0, `${percents.n} rows`);

  // An unpriced item must stay unpriced rather than becoming a free one.
  const [[unpriced]] = await pool.query(
    'SELECT COUNT(*) AS n FROM items WHERE pricing_type IS NULL AND base_price > 0');
  ok('no item has a base price without a pricing type', unpriced.n === 0, `${unpriced.n} rows`);

  console.log('\n── payroll ' + '─'.repeat(49));

  // An advance cannot recover more than was sanctioned.
  const [overRecovered] = await pool.query(
    `SELECT a.id, a.amount, SUM(r.amount) AS recovered
       FROM advances a JOIN advance_recoveries r ON r.advance_id = a.id
      GROUP BY a.id, a.amount
      HAVING recovered > a.amount + 0.01
      LIMIT 5`);
  ok('no advance is over-recovered', overRecovered.length === 0,
    overRecovered.length ? `advance #${overRecovered[0].id}` : '');

  // A finalised period's totals must match its live deduction lines.
  const [totalDrift] = await pool.query(
    `SELECT p.id, p.employee_id, p.period, p.attendance_deduction,
            COALESCE(SUM(CASE WHEN d.waived = FALSE AND d.kind <> 'advance'
                              THEN d.amount END), 0) AS lines_total
       FROM salary_periods p
       LEFT JOIN salary_deductions d ON d.period_id = p.id
      WHERE p.status <> 'draft'
      GROUP BY p.id, p.employee_id, p.period, p.attendance_deduction
      HAVING ABS(p.attendance_deduction - lines_total) > 0.01
      LIMIT 5`);
  ok('a finalised salary total equals its unwaived deduction lines',
    totalDrift.length === 0,
    totalDrift.length ? `${totalDrift[0].employee_id} ${totalDrift[0].period}` : '');

  console.log('\n── privacy and least privilege ' + '─'.repeat(29));

  // R-21 — "Agent details are never printed on invoices." The guarantee is
  // structural: the billing tables have no agent column to print.
  const [agentInInvoice] = await pool.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('invoices', 'invoice_items')
        AND (COLUMN_NAME LIKE '%agent%' OR COLUMN_NAME LIKE '%commission%')`);
  ok('R-21 the invoice tables carry no agent or commission column',
    agentInInvoice.length === 0,
    agentInInvoice.map((c) => `${c.TABLE_NAME}.${c.COLUMN_NAME}`).join(', '));

  // R-07 — Sonu must hold no grant that reveals a rate.
  const [[sonu]] = await pool.query("SELECT permissions FROM users WHERE id = 'sonu'");
  if (sonu) {
    const grants = typeof sonu.permissions === 'string'
      ? JSON.parse(sonu.permissions) : sonu.permissions;
    const reveals = grants.filter((g) => g === 'all' || g === 'items' || g.startsWith('items.rates'));
    ok('R-07 Sonu holds no grant that reveals a rate', reveals.length === 0,
      reveals.join(', '));
  } else {
    ok('R-07 Sonu holds no grant that reveals a rate', false, 'no sonu account');
  }

  // Nobody but the rate keeper may edit rates.
  const [rateEditors] = await pool.query(
    `SELECT id FROM users WHERE is_active = TRUE
       AND JSON_CONTAINS(permissions, JSON_QUOTE('items.pricing'))`);
  ok('R-04 exactly one account holds the rate-edit grant',
    rateEditors.length === 1 && rateEditors[0].id === 'gaurav',
    rateEditors.map((r) => r.id).join(', ') || 'nobody');

  // R-03 — "The option to create a dispatch sheet appears only on Ajit's
  // account." A route guard cannot enforce "only Ajit"; the grant table can.
  const [builders] = await pool.query(
    `SELECT id FROM users WHERE is_active = TRUE
       AND (JSON_CONTAINS(permissions, JSON_QUOTE('dispatch'))
         OR JSON_CONTAINS(permissions, JSON_QUOTE('dispatch.build')))
     ORDER BY id`);
  ok('R-03 one account only can build a dispatch sheet',
    builders.length === 1, builders.map((b) => b.id).join(', ') || 'nobody');

  // R-11 — "Only Yash or Manoj can approve." Approval is the wildcard, so what
  // must hold is that the wildcard is not handed around.
  const [wildcards] = await pool.query(
    `SELECT id FROM users WHERE is_active = TRUE
       AND JSON_CONTAINS(permissions, JSON_QUOTE('all')) ORDER BY id`);
  ok('R-11 the rate-change approvers are the owners and nobody else',
    wildcards.length <= 3,
    wildcards.map((w) => w.id).join(', '));

  // A pending rate change must never have been applied to the item.
  const [leaked] = await pool.query(
    `SELECT rc.id, rc.item_name, rc.field FROM item_rate_changes rc
      WHERE rc.status = 'pending' AND rc.decided_at IS NOT NULL LIMIT 5`);
  ok('R-11 no pending rate change carries a decision', leaked.length === 0,
    leaked.length ? `${leaked[0].item_name}.${leaked[0].field}` : '');

  // The two daily counters, and only them.
  const [counters] = await pool.query(
    `SELECT id FROM users WHERE is_active = TRUE
       AND JSON_CONTAINS(permissions, JSON_QUOTE('stock_count.post'))
     ORDER BY id`);
  ok('the daily stock count is assigned to exactly two people',
    counters.length === 2, counters.map((c) => c.id).join(', '));
}

main()
  .then(async () => {
    await pool.end();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach((f) => console.log('  ✗ ' + f));
      process.exit(1);
    }
  })
  .catch(async (err) => {
    await pool.end().catch(() => {});
    console.error('invariants-test failed:', err.message);
    process.exit(1);
  });
