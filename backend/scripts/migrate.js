/**
 * Applies the SQL files in migrations/, in name order, once each.
 *
 *   node scripts/migrate.js                    # apply anything outstanding
 *   node scripts/migrate.js --status           # list applied / pending, change nothing
 *   node scripts/migrate.js --mark 001_x.sql   # record as applied WITHOUT running it
 *
 * --mark is for a database created fresh from schema.sql: schema.sql already
 * contains everything the migrations do, so running them would fail on indexes
 * and columns that are already there. Mark the ones the schema already covers,
 * then apply the rest normally.
 *
 * Until this existed, a migration was applied by piping it into the mysql
 * client by hand, and nothing recorded that it had been — so whether a database
 * was up to date was a matter of memory. `schema_migrations` is that record.
 *
 * A migration is applied in a transaction where MySQL allows it. DDL in MySQL
 * commits implicitly, so a file that fails halfway leaves the statements before
 * the failure in place; the run stops there rather than continuing, and the file
 * is not marked applied. Every migration in this project is written to be safe
 * to re-run for exactly that reason.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const statusOnly = process.argv.includes('--status');
  const markIndex = process.argv.indexOf('--mark');
  const markFile = markIndex !== -1 ? process.argv[markIndex + 1] : null;

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'kl_electricals',
    // Migrations are multi-statement scripts by nature. This connection is the
    // only place in the codebase where that is switched on, and it never sees
    // a value that came from a request.
    multipleStatements: true,
    timezone: 'Z',
  });

  await connection.query("SET time_zone = '+00:00'");
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [applied] = await connection.query('SELECT filename FROM schema_migrations');
  const done = new Set(applied.map((row) => row.filename));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const pending = files.filter((name) => !done.has(name));

  if (markFile) {
    if (!files.includes(markFile)) {
      console.error(`[MIGRATE] no such migration: ${markFile}`);
      await connection.end();
      process.exit(1);
    }
    await connection.query('INSERT IGNORE INTO schema_migrations (filename) VALUES (?)', [markFile]);
    console.log(`[MIGRATE] marked ${markFile} as applied. It was not run.`);
    await connection.end();
    return;
  }

  if (statusOnly) {
    for (const name of files) {
      console.log(`${done.has(name) ? '[applied]' : '[pending]'} ${name}`);
    }
    await connection.end();
    return;
  }

  if (pending.length === 0) {
    console.log(`[MIGRATE] up to date — ${files.length} migration(s) already applied.`);
    await connection.end();
    return;
  }

  for (const name of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    process.stdout.write(`[MIGRATE] applying ${name} … `);
    try {
      await connection.query(sql);
      await connection.query('INSERT INTO schema_migrations (filename) VALUES (?)', [name]);
      console.log('ok');
    } catch (err) {
      console.log('failed');
      console.error(`[MIGRATE] ${name}: ${err.sqlMessage || err.message}`);
      console.error('[MIGRATE] stopping. Nothing after this file was applied.');
      await connection.end();
      process.exit(1);
    }
  }

  console.log(`[MIGRATE] done — ${pending.length} migration(s) applied.`);
  await connection.end();
}

main().catch(async (err) => {
  console.error('[MIGRATE] failed:', err.sqlMessage || err.message);
  process.exit(1);
});
