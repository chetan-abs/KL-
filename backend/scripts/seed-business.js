#!/usr/bin/env node
/**
 * The business facts the app needs before anyone can use it.
 *
 *   npm run seed-business             create/update everything below
 *   npm run seed-business -- --reset  reapply shifts, salaries and grants to
 *                                     accounts that already exist
 *
 * Distinct from `seed-roles`, which creates the nine pipeline logins for
 * exercising the workflow. This seeds what the requirements document actually
 * specifies about the business:
 *
 *   · the full staff list of section 2 — twenty-one people across the roles,
 *     each on a shift with a salary
 *   · the two workplaces, so the check-in proximity flag has something to
 *     measure against
 *   · KL Utsav with its six slabs (3.2)
 *
 * Passwords are only ever set on a NEW account. --reset brings an existing
 * account's shift, salary and grants back to what this file says and leaves
 * whatever password the person has chosen alone.
 */

const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { checkPassword, generatePassword } = require('../utils/password');

// ---------------------------------------------------------------------------
// Staff — section 2, with the shift assignments from addendum C.1.
//
// Shift B is Manas, Sibu and Sonu; everyone else is Shift A. The three field
// salesmen are the only staff not geofenced: "the check-in location is
// recorded but not geofenced — they may check in from wherever they begin
// their day."
//
// Salaries are placeholders. The document gives exactly one figure — Monu on
// 18,000, in the worked example at A.1 — and says the rest are entered by Yash.
// Seeding a plausible number would put invented pay into a live payroll, so
// every other account is seeded at 0 and the salary screen shows it as unset.
// ---------------------------------------------------------------------------
const STAFF = [
  // --- owners --------------------------------------------------------------
  { id: 'yash', name: 'Yash Agarwal', title: 'Owner', shift: 'B', salary: 0,
    permissions: ['all'] },
  { id: 'manoj', name: 'Manoj Agarwal', title: 'Owner', shift: 'B', salary: 0,
    permissions: ['all'] },

  // --- office --------------------------------------------------------------
  // CHANGED FROM v1 (2. User roles & access, September 2026): the order desk,
  // order approval, verification and the retail counter all moved. Manas now
  // also does bank reconciliation and purchase entries; Sibu's purchase
  // verification is explicitly "cannot self-approve" — the account only, the
  // second-approver check itself is not yet built and is a known gap.
  { id: 'manas', name: 'Manas', title: 'Sales Orders & Purchase Entry', shift: 'B', salary: 0,
    permissions: ['orders', 'customers.view', 'items.view', 'agents.view',
      'payments.view', 'attendance', 'leave.approve', 'cash.view', 'items.rates',
      'purchases.create', 'purchases.view'] },
  { id: 'gaurav', name: 'Gaurav', title: 'Order & Rate Desk + Billing', shift: 'A', salary: 0,
    // R-04: `items.pricing` is the rate-edit grant and Gaurav is the only
    // account that holds it. `items.rates` — merely SEEING a rate — is held by
    // everyone who quotes or bills; only Sonu is excluded (R-07).
    permissions: ['billing', 'returns', 'orders.view', 'customers.view',
      'items.view', 'items.rates', 'items.pricing', 'payments'] },
  { id: 'sibu', name: 'Sibu', title: 'Purchase, Cash & EOD', shift: 'B', salary: 0,
    permissions: ['cheques', 'eod', 'payments', 'customers.view', 'billing.view',
      'purchases', 'incentives.pay', 'items.rates',
      // Section 8: Sibu counts what a salesman brings in, and closes the
      // cash book. Section 14: he administers the Tally integration.
      // Section 3.2: Sibu approves a rate-change request more than 2% below
      // the current rate (below cost is still owner-only — see routes/items.js).
      'cash.manage', 'tally.manage', 'rate_variance.approve'] },
  // Verification moved off Ajit onto Sonu ("Goods verification + loading —
  // verifies what the picker has picked, after picking") — pickers explicitly
  // "cannot verify: whoever picks does not check". Ajit keeps dispatch, which
  // the September sheet does not reassign.
  { id: 'ajit', name: 'Ajit', title: 'Picking & Dispatch', shift: 'A', salary: 0,
    permissions: ['dispatch', 'orders.view', 'items.view',
      'customers.view', 'employees.view', 'stock_count.post'] },
  { id: 'sonu', name: 'Sonu', title: 'Goods Verification + Loading', shift: 'B', salary: 0,
    // R-07: Sonu must not see rates. `items.view` alone shows names and
    // quantities; `items.rates` is what reveals the rate columns, and he is
    // deliberately not given it. `verification` is new — this is the account
    // that now signs off what a picker picked.
    permissions: ['purchases', 'verification', 'items.view', 'items.create',
      'items.edit', 'stock_count.view', 'returns'] },

  // --- godown --------------------------------------------------------------
  { id: 'sujay', name: 'Sujay', title: 'Godown', shift: 'A', salary: 0,
    permissions: ['purchases.create', 'purchases.view', 'items.view', 'picking'] },
  // Dishal is Counter Stock (rack refill, counter runner), not Godown — was
  // seeded with Sujay's godown grants by mistake; corrected here.
  { id: 'dishal', name: 'Dishal', title: 'Counter Stock', shift: 'A', salary: 0,
    permissions: ['items.view', 'stock_count.view', 'picking'] },

  // --- pickers -------------------------------------------------------------
  { id: 'ashish', name: 'Ashish', title: 'Picker', shift: 'A', salary: 0,
    permissions: ['picking', 'items.view', 'orders.view'] },
  { id: 'rajesh', name: 'Rajesh', title: 'Picker', shift: 'A', salary: 0,
    permissions: ['picking', 'items.view', 'orders.view'] },
  // Hirak is Ambari godown in charge and bin numbering, and the named backup
  // verifier when Sonu is absent — hence the `verification` grant alongside
  // picking, which nobody else on the picker roster holds.
  { id: 'hirak', name: 'Hirak', title: 'Ambari Godown (Backup Verifier)', shift: 'A', salary: 0,
    permissions: ['picking', 'verification', 'items.view', 'orders.view', 'stock_count.post'] },
  { id: 'ganesh', name: 'Ganesh', title: 'Picker', shift: 'A', salary: 0,
    permissions: ['picking', 'items.view', 'orders.view'] },
  // Picks urgent orders only, so a rush order does not disturb the batch.
  { id: 'prabal', name: 'Prabal', title: 'Picker — Urgent', shift: 'A', salary: 0,
    permissions: ['showroom', 'orders.view', 'orders.create', 'estimates.view',
      'estimates.create', 'customers.view', 'customers.create', 'items.view',
      'agents.view', 'agents.create', 'schemes', 'items.rates', 'picking'] },

  // --- counter ---------------------------------------------------------------
  // `showroom` is what puts Pulen and Prabal in the shared incentive pool —
  // "Pulen and Prabal share a combined incentive pool". A grant rather than a
  // list of names in code, so replacing one is an admin action.
  { id: 'pulen', name: 'Pulen', title: 'Counter', shift: 'A', salary: 0,
    permissions: ['showroom', 'orders.view', 'orders.create', 'estimates.view',
      'estimates.create', 'customers.view', 'customers.create', 'items.view',
      'agents.view', 'agents.create', 'schemes', 'items.rates'] },
  // Retail + customer relations: counter support, follow-up and complaints,
  // calls the party before a delivery slot is going to slip.
  { id: 'bhaity', name: 'Bhaity', title: 'Retail + Customer Relations', shift: 'A', salary: 0,
    permissions: ['orders.view', 'customers.view', 'customers.create', 'items.view'] },

  // --- drivers and helpers -------------------------------------------------
  // Deliberately thin: every route a driver uses is scoped to req.user.id.
  { id: 'kamal', name: 'Kamal', title: 'Driver', shift: 'A', salary: 0,
    permissions: ['orders.view'] },
  { id: 'siva', name: 'Siva', title: 'Driver', shift: 'A', salary: 0,
    permissions: ['orders.view'] },
  { id: 'shankar', name: 'Shankar', title: 'Helper — Loading', shift: 'A', salary: 0,
    permissions: ['orders.view'] },
  // Damodar also does cheque deposit and local market purchase.
  { id: 'damodar', name: 'Damodar', title: 'Helper — Cheques & Local Purchase', shift: 'A', salary: 0,
    permissions: ['cheques.view', 'cheques.deposit', 'purchases.create'] },

  // --- field sales ---------------------------------------------------------
  // Action grants, not area: a salesman sees their own book. The area grant is
  // what would widen it to the branch.
  { id: 'monu', name: 'Monu', title: 'Salesman — Guwahati', shift: 'A', salary: 18000,
    geofenced: false,
    permissions: ['orders.view', 'orders.create', 'customers.view', 'customers.create',
      'items.view', 'estimates.view', 'estimates.create', 'agents.view',
      'agents.create', 'schemes.view', 'schemes.create',
      'items.rates', 'payments.create'] },
  // Interior designers, architects, electricians and Lemac — split from
  // Pankaj (builders) in the September 2026 sheet; previously combined here
  // as "Salesman — ID/Builder".
  { id: 'prasenjit', name: 'Prasenjit', title: 'Salesman — ID', shift: 'A', salary: 0,
    geofenced: false,
    permissions: ['orders.view', 'orders.create', 'customers.view', 'customers.create',
      'items.view', 'estimates.view', 'estimates.create', 'agents.view',
      'agents.create', 'schemes.view', 'schemes.create',
      'items.rates', 'payments.create'] },
  { id: 'manish', name: 'Manish', title: 'Salesman — Outside', shift: 'A', salary: 0,
    geofenced: false,
    permissions: ['orders.view', 'orders.create', 'customers.view', 'customers.create',
      'items.view', 'estimates.view', 'estimates.create', 'agents.view',
      'agents.create', 'schemes.view', 'schemes.create',
      'items.rates', 'payments.create'] },
  // Builders and contractors — measured on collected value, not orders
  // booked (the sheet flags this as a different KPI; nothing here changes
  // how the app measures it, that is a reporting decision, not a permission).
  { id: 'pankaj', name: 'Pankaj', title: 'Salesman — Builder', shift: 'A', salary: 0,
    geofenced: false,
    permissions: ['orders.view', 'orders.create', 'customers.view', 'customers.create',
      'items.view', 'estimates.view', 'estimates.create', 'agents.view',
      'agents.create', 'schemes.view', 'schemes.create',
      'items.rates', 'payments.create'] },
];

/**
 * The two sites (section 1: "Lakhtokia + Fatashil, Guwahati").
 *
 * Coordinates are the localities, not surveyed shopfronts, and the radius is
 * wide to match. They are here so the proximity flag has something to measure;
 * tighten them once someone stands in each doorway with a phone. Until then a
 * generous radius flags nobody wrongly, which is the right way round for a
 * rule that is a flag rather than a block.
 */
const WORKPLACES = [
  { name: 'Lakhtokia', latitude: 26.1800, longitude: 91.7420, radius_m: 600 },
  { name: 'Fatashil', latitude: 26.1620, longitude: 91.7180, radius_m: 600 },
];

/**
 * KL Utsav — the slabs of 3.2, in order.
 *
 * "Only the highest slab reached is rewarded. Gifts are not cumulative."
 * min_value is the qualifying total that reaches the rung; reward_gift is what
 * it pays. reward_rate is zero throughout because this scheme pays goods, not
 * money — the column belongs to the percentage-based dealer schemes.
 */
const KL_UTSAV = {
  name: 'KL Utsav',
  kind: 'electrician_gift',
  period: 'once',
  early_bird_days: 30,
  referral_bonus: 5000,
  // "The scheme runs for 90 days from the launch date."
  days: 90,
  note: 'Qualifying value is the net purchase after discount, before GST. Wire counts 50%.',
  slabs: [
    { min_value: 50000, gift: 'Mixer Grinder' },
    { min_value: 100000, gift: 'boAt Smartwatch' },
    { min_value: 150000, gift: 'Microwave Oven' },
    { min_value: 250000, gift: 'Smartphone' },
    { min_value: 500000, gift: 'LED TV (32 inch)' },
    { min_value: 750000, gift: '1-Ton Air Conditioner' },
  ],
};

/**
 * The Lemac dealer growth schemes.
 *
 * Source: LEMAC_Developer_Master_v7.xlsx, 'Discount & Scheme Reference'. These
 * are the one thing in the spreadsheets that KL_App_Requirements_FINAL.pdf never
 * mentions.
 *
 * SEEDED INACTIVE, deliberately. Whether K.L. Electricals runs Lemac's dealer
 * schemes as a distributor or merely stocks the range is a business fact absent
 * from all three documents. The engine and the slabs are complete; activating
 * one is a decision somebody takes on the Schemes screen
 * (POST /api/schemes/:id/activate), not a side effect of running a seed.
 *
 * The validity dates are the sheet's own current cycle, and the sheet says so
 * itself: "App should allow validity dates to be updated each cycle."
 */
const GROWTH_SCHEMES = [
  {
    name: 'Lemac Modular — Monthly',
    kind: 'growth_credit',
    period: 'monthly',
    renews: true,
    item_flag: 'sch_modular_monthly',
    starts_on: '2026-09-01',
    ends_on: '2027-03-31',
    note: 'Credit note on modular-valid billing. Renews each calendar month.',
    slabs: [
      [25000, 0.020], [40000, 0.025], [60000, 0.030], [80000, 0.035], [100000, 0.040],
    ],
  },
  {
    name: 'Lemac Modular Boxes — Monthly',
    kind: 'growth_credit',
    period: 'monthly',
    renews: true,
    item_flag: 'sch_boxes_monthly',
    starts_on: '2026-09-01',
    ends_on: '2027-03-31',
    note: 'Surface + metal box billing combined. Renews each calendar month.',
    slabs: [[15000, 0.020], [30000, 0.030], [50000, 0.040]],
  },
  {
    // "Modular Quarterly (Puja Bonanza) | 1 September 2026 - 30 November 2026"
    name: 'Lemac Modular — Quarterly (Puja Bonanza)',
    kind: 'growth_gift',
    period: 'quarterly',
    renews: false,
    item_flag: 'sch_modular_quarterly',
    starts_on: '2026-09-01',
    ends_on: '2026-11-30',
    note: 'Gift item (electronics / daily-use) on three months of billing.',
    slabs: [
      [75000, 0.030], [120000, 0.035], [180000, 0.040], [240000, 0.045], [300000, 0.050],
    ],
  },
  {
    // "Modular Yearly (Saalana Utsav) | 1 September 2026 - 31 March 2027"
    name: 'Lemac Modular — Yearly (Saalana Utsav)',
    kind: 'growth_credit',
    period: 'yearly',
    renews: false,
    item_flag: 'sch_modular_yearly',
    starts_on: '2026-09-01',
    ends_on: '2027-03-31',
    note: 'Year-end credit note. Additive with the monthly and quarterly layers.',
    slabs: [
      [175000, 0.010], [280000, 0.015], [420000, 0.020], [560000, 0.025], [700000, 0.030],
    ],
  },
];

const arg = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[SEED] refusing to run in production — these accounts share one password.');
    process.exit(1);
  }

  // No default. A password literal in this file is a password in the
  // repository — see the note at the top of scripts/seed-roles.js, and
  // migration 015. Generated per account and printed once unless one shared
  // value is named explicitly, which is what the test suites do.
  const shared = arg('--password');
  const reset = process.argv.includes('--reset');

  if (shared) {
    const bad = checkPassword(shared);
    if (bad) {
      console.error(`[SEED] that password would be refused by the app: ${bad}`);
      process.exit(1);
    }
  }

  const issued = [];

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ---- staff ----------------------------------------------------------
    let created = 0;
    let updated = 0;
    let untouched = 0;

    for (const s of STAFF) {
      const [[existing]] = await conn.query('SELECT id FROM users WHERE id = ?', [s.id]);
      const grants = JSON.stringify(s.permissions);
      const geofenced = s.geofenced === false ? 0 : 1;

      if (!existing) {
        // Generated per account unless one shared value was named explicitly.
        const password = shared || generatePassword();
        if (!shared) issued.push([s.id, password]);

        await conn.query(
          `INSERT INTO users
             (id, name, email, role, title, shift_code, fixed_salary, geofenced, password, permissions,
              is_active, must_change_password)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?)`,
          [s.id, s.name, `${s.id}@klelectricals.local`,
            s.permissions.includes('all') ? 'admin' : 'employee',
            s.title || null,
            s.shift, s.salary, geofenced, await bcrypt.hash(password, 10), grants,
            // Forced to change unless a person named the password. Same rule as
            // seed-roles.js; both are enforced by `authenticate`.
            !shared]);
        created += 1;
      } else if (reset) {
        // Never the password. Somebody may have changed theirs, and resetting
        // grants is an administrative act; resetting a password is not.
        await conn.query(
          `UPDATE users SET name = ?, title = ?, shift_code = ?, geofenced = ?, permissions = ?,
                            fixed_salary = CASE WHEN fixed_salary = 0 THEN ? ELSE fixed_salary END
            WHERE id = ?`,
          [s.name, s.title || null, s.shift, geofenced, grants, s.salary, s.id]);
        updated += 1;
      } else {
        untouched += 1;
      }
    }

    // ---- workplaces -----------------------------------------------------
    for (const w of WORKPLACES) {
      const [[existing]] = await conn.query('SELECT id FROM workplaces WHERE name = ?', [w.name]);
      if (existing) {
        if (reset) {
          await conn.query(
            'UPDATE workplaces SET latitude = ?, longitude = ?, radius_m = ? WHERE id = ?',
            [w.latitude, w.longitude, w.radius_m, existing.id]);
        }
      } else {
        await conn.query(
          'INSERT INTO workplaces (name, latitude, longitude, radius_m) VALUES (?, ?, ?, ?)',
          [w.name, w.latitude, w.longitude, w.radius_m]);
      }
    }

    // ---- KL Utsav -------------------------------------------------------
    const [[scheme]] = await conn.query(
      'SELECT id FROM schemes WHERE name = ? AND kind = ?', [KL_UTSAV.name, KL_UTSAV.kind]);

    let schemeId = scheme?.id;
    if (!schemeId) {
      const [r] = await conn.query(
        `INSERT INTO schemes (name, kind, period, starts_on, ends_on, early_bird_days,
                              referral_bonus, is_active, note, created_by)
         VALUES (?, ?, ?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?, ?, TRUE, ?, ?)`,
        [KL_UTSAV.name, KL_UTSAV.kind, KL_UTSAV.period, KL_UTSAV.days,
          KL_UTSAV.early_bird_days, KL_UTSAV.referral_bonus, KL_UTSAV.note, 'yash']);
      schemeId = r.insertId;

      for (const [i, slab] of KL_UTSAV.slabs.entries()) {
        await conn.query(
          `INSERT INTO scheme_slabs
             (scheme_id, slab_order, min_qty, max_qty, min_value, reward_rate, reward_gift, reward_note)
           VALUES (?, ?, 0, NULL, ?, 0, ?, ?)`,
          [schemeId, i + 1, slab.min_value, slab.gift, slab.gift]);
      }
    }

    // ---- the Lemac growth schemes, inactive ------------------------------
    let growthCreated = 0;
    for (const g of GROWTH_SCHEMES) {
      const [[existing]] = await conn.query(
        'SELECT id FROM schemes WHERE name = ?', [g.name]);
      if (existing) continue;

      const [r] = await conn.query(
        `INSERT INTO schemes
           (name, kind, period, renews, requires_payment, item_flag,
            starts_on, ends_on, is_active, note, created_by)
         VALUES (?, ?, ?, ?, TRUE, ?, ?, ?, FALSE, ?, ?)`,
        [g.name, g.kind, g.period, g.renews, g.item_flag,
          g.starts_on, g.ends_on, g.note, 'yash']);

      for (const [i, [minValue, percent]] of g.slabs.entries()) {
        await conn.query(
          `INSERT INTO scheme_slabs
             (scheme_id, slab_order, min_qty, max_qty, min_value, reward_rate,
              reward_percent, reward_gift, reward_note)
           VALUES (?, ?, 0, NULL, ?, 0, ?, ?, ?)`,
          [r.insertId, i + 1, minValue, percent,
            g.kind === 'growth_gift' ? 'Gift item (electronics / daily-use)' : null,
            `${(percent * 100).toFixed(1)}% at ${minValue}`]);
      }
      growthCreated += 1;
    }

    await conn.commit();

    console.log(`[SEED] staff       ${created} created, ${updated} updated, ${untouched} left alone`);
    console.log(`[SEED] workplaces  ${WORKPLACES.length}`);
    console.log(`[SEED] KL Utsav    scheme #${schemeId} with ${KL_UTSAV.slabs.length} slabs`);
    console.log(`[SEED] growth      ${growthCreated} Lemac scheme(s) created — ALL INACTIVE`);
    if (growthCreated) {
      console.log('                   The requirements document does not mention them, so');
      console.log('                   nothing accrues until somebody activates one:');
      console.log('                     POST /api/schemes/:id/activate  { "active": true }');
    }
    if (issued.length) {
      console.log('\n  One-time passwords. Not stored anywhere and not recoverable —');
      console.log('  copy them now. Each must be changed at first sign-in before the');
      console.log('  account can do anything else.\n');
      for (const [id, pw] of issued) console.log(`    ${id.padEnd(12)} ${pw}`);
      console.log('');
    }
    if (created && shared) {
      console.log('\n  New accounts share the password you supplied and are NOT forced');
      console.log('  to change it. Development only.');
    }
    if (!reset && untouched) {
      console.log(`\n  ${untouched} account(s) already existed and were left as they are.`);
      console.log('  Run with --reset to bring their shift and grants back to this file.');
    }
    console.log('\n  Salaries are seeded at 0 apart from the one figure the requirements give.');
    console.log('  Yash must enter the rest before a month can be finalised.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[SEED] failed:', err.message);
  process.exit(1);
});
