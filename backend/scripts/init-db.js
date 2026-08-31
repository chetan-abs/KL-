/**
 * Creates the database if it does not exist, then applies schema.sql.
 *
 * Structure only — this script never inserts a row. Use create-admin.js to make
 * the first login. Safe to re-run: every statement is CREATE TABLE IF NOT EXISTS.
 *
 *   node scripts/init-db.js
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { build: buildInitSql } = require('./build-init-sql');
require('dotenv').config();

const host = process.env.DB_HOST || 'localhost';
const port = parseInt(process.env.DB_PORT) || 3306;
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD || '';
const dbName = process.env.DB_NAME || 'kl_electricals';

/**
 * Splits a SQL script into statements.
 *
 * The previous version stripped whole lines beginning with `--` and then split
 * on every `;` in the file. That held only for as long as no comment trailed a
 * statement and no literal contained a semicolon — an ENUM value or a default
 * string would have silently torn one statement into two. This walks the text
 * instead, so quoted strings, backtick identifiers, and all three comment forms
 * are skipped over rather than parsed.
 */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // -- line comment (SQL requires whitespace after the dashes) and # comment
    if ((ch === '-' && next === '-' && /[\s]/.test(sql[i + 2] ?? '\n')) || ch === '#') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      current += ' ';
      continue;
    }

    // /* block comment */
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }

    // Quoted string or quoted identifier — copied through verbatim.
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < sql.length) {
        // Backslash escape (MySQL default; harmless if NO_BACKSLASH_ESCAPES).
        if (sql[i] === '\\' && quote !== '`') {
          current += sql[i] + (sql[i + 1] ?? '');
          i += 2;
          continue;
        }
        // A doubled quote is a literal quote, not the end of the token.
        if (sql[i] === quote && sql[i + 1] === quote) {
          current += quote + quote;
          i += 2;
          continue;
        }
        current += sql[i];
        if (sql[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  // A trailing statement with no terminating semicolon still counts.
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function main() {
  // Connect without selecting a database so we can create it.
  let conn = await mysql.createConnection({ host, port, user, password, multipleStatements: false });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  console.log(`[DB] database ready: ${dbName}`);
  await conn.end();

  conn = await mysql.createConnection({ host, port, user, password, database: dbName });

  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  const statements = splitStatements(sql);

  for (const statement of statements) {
    const table = statement.match(/CREATE TABLE IF NOT EXISTS (\w+)/i)?.[1];
    await conn.query(statement);
    if (table) console.log(`[DB] table ready: ${table}`);
  }

  // A database built from schema.sql already contains everything the files in
  // migrations/ do, so they are recorded as applied rather than left pending —
  // running them here would fail on columns that are already present. This is
  // the same thing init.sql does, for the path that goes through Node.
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    VARCHAR(255) PRIMARY KEY,
      applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const migrations = fs
    .readdirSync(path.join(__dirname, '..', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of migrations) {
    await conn.query('INSERT IGNORE INTO schema_migrations (filename) VALUES (?)', [name]);
  }
  if (migrations.length) {
    console.log(`[DB] ${migrations.length} migration(s) marked applied — npm run migrate is a no-op.`);
  }

  const [rows] = await conn.query('SHOW TABLES');
  console.log(`\n[DB] ${rows.length} table(s) present in ${dbName}.`);
  console.log('[DB] No rows were inserted. Run scripts/create-admin.js to add the first user.');

  // Regenerated from the schema that was just applied, so the standalone file
  // and this path can never describe different databases.
  buildInitSql();
  console.log('[DB] init.sql regenerated from schema.sql.');

  await conn.end();
}

// Guarded so splitStatements can be imported (by a test, say) without the
// import itself connecting to MySQL and applying the schema.
if (require.main === module) {
  main().catch((err) => {
    console.error('[DB] init failed:', err.sqlMessage || err.message);
    process.exit(1);
  });
}

module.exports = { splitStatements };
