/**
 * Creates the nine staff accounts the phone app signs in as.
 *
 *   npm run seed-roles                    # create any that are missing
 *   npm run seed-roles -- --password X    # set one shared password explicitly
 *   npm run seed-roles -- --reset         # also reset existing accounts' grants
 *
 * The grants here are the whole point: each role gets exactly the areas its
 * screens need and nothing else, so the permission split is demonstrable rather
 * than theoretical. Only Yash holds the wildcard.
 *
 * Idempotent. An existing account is left alone unless --reset is passed, and
 * even then only its permissions and name are touched — never its password, so
 * re-seeding cannot quietly reset a real person's credentials.
 *
 * These are development accounts, and the script refuses to run against
 * NODE_ENV=production.
 *
 * **No password is hard-coded here any more.** A literal in this file is a
 * literal in the repository, and 22 live accounts were found still carrying the
 * one that used to be on this line — `yash` among them, who holds `all`. So a
 * distinct random password is generated per account and printed once; nothing
 * stores it, and re-running the script cannot recover it.
 *
 * Every account created that way is marked `must_change_password` (migration
 * 015), which `authenticate` enforces: a password this script chose gets the
 * account as far as the change-password screen and no further.
 *
 * `--password X` opts out of both, because the test suites need one shared
 * value they can put in SEED_PASSWORD. A password a person typed is a password
 * a person chose, so it is not forced to change — but it is still checked
 * against the policy, and NODE_ENV=production still refuses the whole script.
 */
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { checkPassword, generatePassword } = require('../utils/password');


// Mirrors constants/roles.js on the client. The client decides what a role is
// *shown*; these grants decide what it may actually do, and the server is the
// only one of the two that is authoritative.
const ROLES = [
  {
    id: 'manas', name: 'Manas', title: 'Approvals',
    permissions: ['orders', 'customers.view', 'items.view', 'agents.view', 'payments.view'],
  },
  {
    id: 'monu', name: 'Monu', title: 'Field Sales',
    // Action grants, not area: a salesman sees their own order book and their
    // own quotes. The area grant is what would widen that to the branch.
    permissions: [
      'orders.view', 'orders.create', 'customers.view', 'customers.create',
      'items.view', 'estimates.view', 'estimates.create',
      'agents.view', 'agents.create', 'schemes.view',
    ],
  },
  {
    id: 'ashish', name: 'Ashish', title: 'Picking',
    permissions: ['picking', 'stock_count', 'items.view', 'orders.view'],
  },
  {
    id: 'ajit', name: 'Ajit', title: 'Verify & Dispatch',
    // employees.view is needed to build a sheet at all: the dispatcher picks
    // which driver takes the run, and cannot do that without the staff list.
    permissions: ['verification', 'dispatch', 'orders.view', 'items.view', 'customers.view', 'employees.view'],
  },
  {
    id: 'gaurav', name: 'Gaurav', title: 'Billing',
    permissions: ['billing', 'returns', 'orders.view', 'customers.view', 'items.view', 'payments'],
  },
  {
    id: 'kamal', name: 'Kamal', title: 'Delivery',
    // Deliberately thin. Every route a driver uses — their route, their stops,
    // their deliveries — is scoped to req.user.id and needs no grant at all.
    permissions: ['orders.view'],
  },
  {
    id: 'sonu', name: 'Sonu', title: 'Purchase',
    permissions: ['purchases', 'items', 'stock_count.view'],
  },
  {
    id: 'sibu', name: 'Sibu', title: 'Cash & Close',
    permissions: ['cheques', 'eod', 'payments', 'customers.view', 'billing.view'],
  },
  {
    id: 'yash', name: 'Yash', title: 'Owner',
    permissions: ['all'],
  },
];

function arg(flag) {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : null;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('[SEED] refusing to run in production — these are shared-password demo accounts.');
    process.exit(1);
  }

  const shared = arg('--password');
  const reset = process.argv.includes('--reset');

  // Run through the same policy as every other password path, so the seed
  // cannot create an account the change-password screen would refuse.
  // checkPassword returns a message when the password is bad, and nothing when
  // it is fine.
  if (shared) {
    const complaint = checkPassword(shared);
    if (complaint) {
      console.error(`[SEED] password rejected: ${complaint}`);
      process.exit(1);
    }
  }

  // Collected and printed at the end rather than as each account is made, so an
  // interrupted run cannot leave half the list scrolled off the top.
  const issued = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const role of ROLES) {
    const [[existing]] = await pool.query('SELECT id FROM users WHERE id = ?', [role.id]);

    if (existing) {
      if (!reset) {
        skipped += 1;
        continue;
      }
      // Password deliberately untouched: re-seeding must not reset a real
      // person's credentials just because their id matches a demo role.
      await pool.query(
        'UPDATE users SET name = ?, permissions = ?, is_active = TRUE WHERE id = ?',
        [role.name, JSON.stringify(role.permissions), role.id]
      );
      updated += 1;
      console.log(`[SEED] updated ${role.id.padEnd(8)} ${role.title}`);
      continue;
    }

    // Generated per account unless one shared value was named explicitly.
    const password = shared || generatePassword();
    if (!shared) issued.push([role.id, password]);

    await pool.query(
      `INSERT INTO users (id, name, email, role, password, permissions, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        role.id,
        role.name,
        `${role.id}@klelectricals.local`,
        role.id === 'yash' ? 'admin' : 'employee',
        await bcrypt.hash(password, 10),
        JSON.stringify(role.permissions),
        // A password this script chose must be replaced before the account can
        // do anything. One a person named is one a person chose.
        !shared,
      ]
    );
    created += 1;
    console.log(`[SEED] created ${role.id.padEnd(8)} ${role.title.padEnd(18)} ${role.permissions.join(', ')}`);
  }

  console.log(`\n[SEED] ${created} created, ${updated} updated, ${skipped} already present.`);
  if (issued.length) {
    console.log('\n[SEED] One-time passwords. These are not stored anywhere and cannot');
    console.log('[SEED] be recovered — copy them now. Each must be changed at first');
    console.log('[SEED] sign-in before the account can do anything else.\n');
    for (const [id, pw] of issued) console.log(`         ${id.padEnd(10)} ${pw}`);
    console.log('');
  }
  if (created && shared) {
    console.log('[SEED] all new accounts share the password you supplied and are NOT');
    console.log('[SEED] forced to change it. Development only.');
  }
  if (skipped && !reset) console.log('[SEED] pass --reset to bring existing accounts back to these grants.');

  await pool.end();
}

main().catch(async (err) => {
  console.error('[SEED] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
