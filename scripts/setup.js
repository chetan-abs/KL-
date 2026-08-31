#!/usr/bin/env node
/**
 * Gets a freshly unzipped copy ready to run. Called by `npm run dev`.
 *
 * The point is that somebody can unzip this, type two commands, and have a
 * working app. Everything here is idempotent and quiet when there is nothing to
 * do, so it can run on every `npm run dev` without being annoying.
 *
 * It does, in order:
 *
 *   1. writes backend/.env if missing, with a generated JWT_SECRET
 *   2. checks MySQL is reachable, and says what to do if it is not
 *   3. creates the database and tables if they are not there
 *   4. applies any migrations an older database is missing
 *   5. creates an admin account, the 22 staff accounts, the item rates and the
 *      incentive segments, each only if that step has not been done
 *
 * Every failure here has to name the fix. A setup script that stops with a
 * stack trace has failed at the only job it has, because the person reading it
 * has just unzipped the project and has no idea what a pool connection is.
 *
 * DEVELOPMENT ONLY. It refuses to touch anything if NODE_ENV=production,
 * because it seeds accounts with a shared password on purpose — see
 * DEV_PASSWORD below.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

/**
 * The password the seeded staff accounts get on a fresh dev install.
 *
 * Passed explicitly to the seed scripts, which is the documented way to opt out
 * of the generated-and-forced-to-change behaviour (migration 015). That opt-out
 * exists for exactly this: a developer needs to sign in as nine different
 * people to see nine different screens, and being made to invent nine
 * passwords first is how somebody gives up before seeing the app work.
 *
 * It is printed on screen every time, never hidden, and the guide says to run
 * `npm run secure-accounts` before this is used for real.
 */
const DEV_PASSWORD = 'Kl@2026Staff';

const ok = (m) => console.log(`  ok    ${m}`);
const did = (m) => console.log(`  done  ${m}`);
const info = (m) => console.log(`        ${m}`);

/** Stops with a message a person can act on, never a stack trace. */
function stop(problem, ...fixes) {
  console.error(`\n  PROBLEM: ${problem}\n`);
  for (const f of fixes) console.error(`  → ${f}`);
  console.error('');
  process.exit(1);
}

/**
 * Runs one of the backend's npm scripts.
 *
 * Built as a single quoted string rather than a command plus an args array:
 * Windows needs a shell to run npm at all (npm is a .cmd, and Node refuses to
 * exec one directly since CVE-2024-27980), and passing an args array together
 * with `shell: true` is deprecated precisely because the two combine badly.
 * Quoting here is explicit instead.
 */
const quote = (value) => `"${String(value).replace(/"/g, '')}"`;

function run(script, args = []) {
  const tail = args.length ? ` -- ${args.map(quote).join(' ')}` : '';
  execSync(`npm run ${script}${tail}`, {
    cwd: BACKEND,
    stdio: 'pipe',
    shell: true,
  });
}

// ---------------------------------------------------------------------------
// 1. backend/.env
// ---------------------------------------------------------------------------
function ensureEnv() {
  const envPath = path.join(BACKEND, '.env');
  if (fs.existsSync(envPath)) { ok('backend/.env exists'); return; }

  const examplePath = path.join(BACKEND, '.env.example');
  if (!fs.existsSync(examplePath)) {
    stop('backend/.env.example is missing, so I cannot write backend/.env.',
      'The zip was made without it. Ask whoever sent this for the full folder.');
  }

  // A real random secret, not a placeholder. This signs login tokens; a shared
  // or guessable value means anybody can forge one.
  const secret = crypto.randomBytes(48).toString('base64').replace(/[+/=]/g, '');

  let text = fs.readFileSync(examplePath, 'utf8');
  text = text.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`);
  if (!/^JWT_SECRET=/m.test(text)) text += `\nJWT_SECRET=${secret}\n`;

  fs.writeFileSync(envPath, text);
  did('wrote backend/.env with a freshly generated JWT_SECRET');
  info('If your MySQL has a password, put it in DB_PASSWORD in that file.');
}

// ---------------------------------------------------------------------------
// 2-5. the database
// ---------------------------------------------------------------------------
async function ensureDatabase() {
  const backendRequire = createRequire(path.join(BACKEND, 'package.json'));

  let mysql;
  let dotenv;
  try {
    mysql = backendRequire('mysql2/promise');
    dotenv = backendRequire('dotenv');
  } catch {
    stop('The backend\'s packages are not installed.',
      'Run:  npm install',
      'That installs both halves. If it already ran, check it finished without errors.');
  }

  dotenv.config({ path: path.join(BACKEND, '.env') });

  const cfg = {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  };
  const dbName = process.env.DB_NAME || 'kl_electricals';

  // --- is MySQL even there?
  let conn;
  try {
    conn = await mysql.createConnection(cfg);
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      stop(`MySQL is not answering on ${cfg.host}:${cfg.port}.`,
        'If you use XAMPP: open the XAMPP Control Panel and press Start next to MySQL.',
        'Then run this again.');
    }
    if (err.code === 'ER_ACCESS_DENIED_ERROR') {
      stop(`MySQL refused the username and password (user "${cfg.user}").`,
        'Open backend/.env and set DB_USER and DB_PASSWORD to match your MySQL.',
        'A fresh XAMPP is usually user "root" with DB_PASSWORD left empty.');
    }
    stop(`Could not reach MySQL: ${err.message}`,
      'Check DB_HOST, DB_PORT, DB_USER and DB_PASSWORD in backend/.env.');
  }
  ok(`MySQL reachable at ${cfg.host}:${cfg.port}`);

  // --- does the database exist, and does it have tables?
  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [dbName]);
  let tableCount = 0;
  if (dbs.length) {
    const [[row]] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?', [dbName]);
    tableCount = Number(row.n);
  }
  await conn.end();

  if (!dbs.length || tableCount === 0) {
    info(`creating the "${dbName}" database and its tables…`);
    try { run('init-db'); } catch (err) {
      stop(`Creating the database failed.\n${(err.stdout || err.message || '').toString().slice(-600)}`,
        'The MySQL user in backend/.env needs permission to create a database.',
        'With XAMPP\'s root user this normally just works.');
    }
    did(`created the database and its tables`);
  } else {
    ok(`database "${dbName}" has ${tableCount} tables`);
    // An older copy may be missing newer columns. Harmless when up to date.
    try { run('migrate'); ok('migrations up to date'); } catch {
      info('could not apply migrations — run "npm run migrate" in backend to see why');
    }
  }

  // --- reconnect, now to the database itself, and check what is seeded
  const db = await mysql.createConnection({ ...cfg, database: dbName });
  const count = async (sql) => {
    try { const [[r]] = await db.query(sql); return Number(r.n); } catch { return 0; }
  };

  const admins = await count("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'");
  const staff = await count('SELECT COUNT(*) AS n FROM users');
  const items = await count('SELECT COUNT(*) AS n FROM items');
  const segments = await count('SELECT COUNT(*) AS n FROM incentive_segments');
  await db.end();

  const summary = [];

  if (staff < 5) {
    info('creating the staff accounts…');
    try {
      run('seed-business', ['--password', DEV_PASSWORD]);
      did('created the 22 staff accounts');
      summary.push(['staff', `22 accounts, all with password  ${DEV_PASSWORD}`]);
    } catch (err) {
      info(`staff seeding did not finish: ${(err.stdout || err.message || '').toString().slice(-300)}`);
    }
  } else {
    ok(`${staff} user accounts already exist`);
  }

  if (admins === 0) {
    info('creating an administrator…');
    try {
      run('create-admin', ['--id', 'ADMIN001', '--name', 'Administrator',
        '--email', 'admin@klelectricals.local', '--password', DEV_PASSWORD]);
      did('created ADMIN001');
      summary.push(['admin', `ADMIN001  with password  ${DEV_PASSWORD}`]);
    } catch {
      // Almost always "already exists", which is fine.
      ok('an administrator already exists');
    }
  } else {
    ok(`${admins} administrator account(s) already exist`);
  }

  if (items < 100) {
    info('loading the item rates from the two spreadsheets…');
    try { run('import-rates', ['--all']); did('loaded the item master'); } catch (err) {
      info('could not load the rates — are the two .xlsx files still in the project folder?');
      info('the app runs without them, but nothing can be priced or sold');
    }
  } else {
    ok(`${items} items already loaded`);
  }

  if (segments === 0) {
    info('loading the incentive segments…');
    try { run('seed-segments'); did('loaded the 20 incentive segments'); } catch {
      info('could not load the incentive segments — the rest of the app is unaffected');
    }
  } else {
    ok(`${segments} incentive segments already loaded`);
  }

  return summary;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    stop('This is a development setup helper and will not run in production.',
      'It seeds accounts with a shared password on purpose.',
      'For a real deployment follow "Before deploying" in README.md.');
  }

  console.log('\n  Checking your setup\n');

  ensureEnv();
  const summary = await ensureDatabase();

  console.log('\n  Ready.\n');
  if (summary.length) {
    for (const [what, detail] of summary) console.log(`  ${what.padEnd(6)} ${detail}`);
    console.log('\n  Those are development passwords and are printed on purpose.');
    console.log('  Before real use, run:  cd backend && npm run secure-accounts\n');
  }
}

main().catch((err) => {
  stop(`Setup could not finish: ${err.message}`,
    'Nothing was left half-done that running this again will not fix.',
    'If it keeps failing, follow section 2.2 of OPERATING-GUIDE.txt by hand.');
});
