/**
 * Creates the first admin user. One-shot, explicit, never automatic.
 *
 * The source project seeded an admin on every server start with a fixed
 * password and stored the plaintext in a temp_password column. This replaces
 * that: nothing is created unless you run this command and supply the values.
 *
 *   node scripts/create-admin.js --id ADMIN001 --name "Your Name" \
 *        --email you@example.com --password "choose-a-strong-one"
 *
 * --phone is optional. The password is bcrypt-hashed and never stored in clear.
 */
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { checkPassword } = require('../utils/password');

function arg(flag) {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const id = arg('id') || process.env.ADMIN_ID;
  const name = arg('name') || process.env.ADMIN_NAME;
  const email = arg('email') || process.env.ADMIN_EMAIL;
  const phone = arg('phone') || process.env.ADMIN_PHONE || null;
  const password = arg('password') || process.env.ADMIN_PASSWORD;

  const missing = Object.entries({ id, name, email, password })
    .filter(([, v]) => !v)
    .map(([k]) => `--${k}`);

  if (missing.length) {
    console.error(`Missing required argument(s): ${missing.join(', ')}`);
    console.error('\nUsage:\n  node scripts/create-admin.js --id ADMIN001 --name "Your Name" \\\n       --email you@example.com --password "choose-a-strong-one" [--phone 9999999999]');
    process.exit(1);
  }

  // The same rule POST /api/users and the change-password route apply, so an
  // admin created here cannot be weaker than an employee created in the app.
  const passwordError = checkPassword(password);
  if (passwordError) {
    console.error(passwordError);
    process.exit(1);
  }

  // No SELECT-then-INSERT here. id is the primary key and email is UNIQUE, so
  // the database rejects a duplicate outright; a prior existence check would
  // only widen the window between the check and the insert without preventing
  // anything the constraints do not already prevent.
  const hash = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      `INSERT INTO users (id, name, email, phone, role, password, permissions, is_active)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, TRUE)`,
      [id, name, email, phone, hash, JSON.stringify(['all'])]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const field = /unique_email/.test(err.sqlMessage || '') ? `email (${email})` : `id (${id})`;
      console.error(`A user with that ${field} already exists. Nothing was changed.`);
      await pool.end().catch(() => {});
      process.exit(1);
    }
    throw err;
  }

  console.log(`[ADMIN] created: ${id} (${email})`);
  console.log('[ADMIN] the password was hashed and is not recoverable — store it somewhere safe.');
  await pool.end();
}

main().catch(async (err) => {
  console.error('[ADMIN] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
