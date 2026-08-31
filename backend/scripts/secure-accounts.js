/**
 * Finds accounts still carrying a password a script chose, and marks them as
 * having to change it.
 *
 *   npm run secure-accounts -- --dry-run     # report, write nothing
 *   npm run secure-accounts                  # mark what it found
 *   npm run secure-accounts -- --all         # mark EVERY account, chosen or not
 *
 * Why this is a script and not part of migration 015: deciding whether a stored
 * bcrypt hash came from a known string requires bcrypt, and a migration is SQL.
 * The column ships defaulting to FALSE and this is what populates it for a
 * database that already exists.
 *
 * The list below is every password this repository has ever handed out. They are
 * here precisely BECAUSE they are burnt — the point of the file is to find
 * accounts still using them, which needs the strings. Adding a real password to
 * this list would be the opposite of the intent.
 *
 * A match is not a vulnerability that this script fixes; the account keeps
 * working, and the person keeps signing in with what they have. What changes is
 * that `authenticate` will let them do nothing but change it (migration 015).
 * That is the difference between an account that is compromised and one that is
 * about to stop being.
 */
const bcrypt = require('bcryptjs');
const pool = require('../config/db');

/** Every credential this repository has ever shipped. Burnt by publication. */
const KNOWN_SEED_PASSWORDS = [
  'Kl@2026Staff',   // scripts/seed-roles.js and seed-business.js, until 31 Aug 2026
];

const DRY = process.argv.includes('--dry-run');
const ALL = process.argv.includes('--all');

async function main() {
  const [rows] = await pool.query(
    'SELECT id, name, is_active, password, must_change_password FROM users ORDER BY id');

  const flagged = [];
  const alreadyFlagged = [];
  const clean = [];

  for (const user of rows) {
    if (user.must_change_password) { alreadyFlagged.push(user); continue; }

    // Every known value is tried against every account. bcrypt is deliberately
    // slow, so this is seconds rather than milliseconds — it runs once.
    let matched = ALL;
    if (!matched) {
      for (const candidate of KNOWN_SEED_PASSWORDS) {
        if (await bcrypt.compare(candidate, user.password)) { matched = true; break; }
      }
    }
    (matched ? flagged : clean).push(user);
  }

  for (const u of flagged) {
    console.log(`  MUST CHANGE  ${u.id.padEnd(12)} ${String(u.name).padEnd(22)}`
      + `${u.is_active ? 'active' : 'inactive'}`);
  }

  console.log(`\n  ${rows.length} accounts: ${flagged.length} to mark, `
    + `${alreadyFlagged.length} already marked, ${clean.length} with a password somebody chose.`);

  if (!flagged.length) {
    console.log('  Nothing to do.');
    await pool.end();
    return;
  }

  if (DRY) {
    console.log('\n  --dry-run: nothing written. Re-run without it to mark these.');
    await pool.end();
    return;
  }

  // One statement rather than a loop: this either applies to all of them or the
  // operator gets to run it again, and a half-marked user table is a state
  // nobody can reason about afterwards.
  const [res] = await pool.query(
    `UPDATE users SET must_change_password = TRUE WHERE id IN (${flagged.map(() => '?').join(',')})`,
    flagged.map((u) => u.id));

  console.log(`\n  Marked ${res.affectedRows}. Each can sign in, read /me and change`);
  console.log('  their password. Every other request is refused with');
  console.log('  403 PASSWORD_CHANGE_REQUIRED until they do.');

  await pool.end();
}

main().catch(async (err) => {
  console.error('[SECURE] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
