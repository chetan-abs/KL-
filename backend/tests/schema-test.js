#!/usr/bin/env node
/**
 * The two fresh-install paths must land where the migrations do.
 *
 *   node tests/schema-test.js
 *
 * There are three ways a database gets built and they must agree:
 *
 *   migrations   an existing database brought forward
 *   schema.sql   what scripts/init-db.js applies to a new one
 *   init.sql     the standalone one-file script for someone who wants SQL
 *
 * init-db.js applies schema.sql and then marks EVERY migration as already
 * applied. So a migration that adds a column schema.sql does not have produces
 * a new database missing that column and convinced the migration has run.
 * Nothing fails at install time; it surfaces weeks later as "Unknown column"
 * from a route nobody has touched.
 *
 * This builds a scratch database from each file and diffs it, column by
 * column, against the live one. It creates and drops `kl_schema_check` and
 * `kl_init_check`, so it needs a user that may create databases.
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shape(conn, db) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE n, COLUMN_DEFAULT d
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, COLUMN_NAME`, [db]);
  const m = new Map();
  for (const r of rows) {
    if (r.t === 'schema_migrations') continue;
    m.set(`${r.t}.${r.c}`, `${r.ty}|${r.n}|${r.d}`);
  }
  return m;
}

function diff(label, fresh, live) {
  const missing = [...live.keys()].filter((k) => !fresh.has(k));
  const extra = [...fresh.keys()].filter((k) => !live.has(k));
  const differ = [...live.keys()].filter((k) => fresh.has(k) && fresh.get(k) !== live.get(k));

  ok(`${label}: no column missing`, missing.length === 0,
    missing.slice(0, 4).join(', '));
  ok(`${label}: no column that should not be there`, extra.length === 0,
    extra.slice(0, 4).join(', '));
  ok(`${label}: every column has the same type`, differ.length === 0,
    differ.slice(0, 3).map((k) => `${k} ${fresh.get(k)} vs ${live.get(k)}`).join('; '));
}

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    multipleStatements: true,
  });

  const live = await shape(conn, process.env.DB_NAME);
  ok('the live database has a schema to compare against', live.size > 500, `${live.size} columns`);

  // ---- schema.sql -------------------------------------------------------
  console.log('\n── schema.sql (what init-db applies) ' + '─'.repeat(23));
  await conn.query('DROP DATABASE IF EXISTS kl_schema_check');
  await conn.query('CREATE DATABASE kl_schema_check CHARACTER SET utf8mb4');
  await conn.query('USE kl_schema_check');
  let applied = true;
  try {
    await conn.query(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  } catch (err) {
    applied = false;
    ok('schema.sql applies cleanly', false, err.sqlMessage || err.message);
  }
  if (applied) {
    ok('schema.sql applies cleanly', true);
    diff('schema.sql', await shape(conn, 'kl_schema_check'), live);

    // Reference rows: a database with no shifts marks nobody late, silently.
    const [[s]] = await conn.query('SELECT COUNT(*) n FROM kl_schema_check.shifts');
    ok('a fresh database has its shift timings', Number(s.n) >= 2, `${s.n} rows`);
    const [[b]] = await conn.query('SELECT COUNT(*) n FROM kl_schema_check.cash_discount_bands');
    ok('a fresh database has its cash-discount ladder', Number(b.n) >= 3, `${b.n} rows`);
  }
  await conn.query('DROP DATABASE IF EXISTS kl_schema_check');

  // ---- init.sql ---------------------------------------------------------
  console.log('\n── init.sql (the standalone one-file script) ' + '─'.repeat(15));
  await conn.query('DROP DATABASE IF EXISTS kl_init_check');
  const initSql = fs.readFileSync(path.join(__dirname, '..', 'init.sql'), 'utf8')
    .replace(/kl_electricals/g, 'kl_init_check');
  let initOk = true;
  try {
    await conn.query(initSql);
  } catch (err) {
    initOk = false;
    ok('init.sql applies cleanly', false, err.sqlMessage || err.message);
  }
  if (initOk) {
    ok('init.sql applies cleanly', true);
    diff('init.sql', await shape(conn, 'kl_init_check'), live);

    // It pre-records the migrations as applied, so it must actually contain
    // what they do — that is the failure this whole test exists to catch.
    const [[m]] = await conn.query('SELECT COUNT(*) n FROM kl_init_check.schema_migrations');
    const onDisk = fs.readdirSync(path.join(__dirname, '..', 'migrations'))
      .filter((f) => f.endsWith('.sql')).length;
    ok('init.sql records every migration on disk as applied',
      Number(m.n) === onDisk, `${m.n} recorded, ${onDisk} on disk`);
  }
  await conn.query('DROP DATABASE IF EXISTS kl_init_check');

  await conn.end();
}

main()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) {
      console.log('\nfailures:');
      failures.forEach((f) => console.log('  ✗ ' + f));
      console.log('\nFix with: npm run migrate && npm run rebuild-schema && npm run build-init-sql');
      process.exit(1);
    }
  })
  .catch((err) => { console.error('schema-test failed:', err.message); process.exit(1); });
