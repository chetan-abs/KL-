#!/usr/bin/env node
/**
 * Regenerate schema.sql from the live database.
 *
 *   npm run rebuild-schema             rewrite schema.sql
 *   npm run rebuild-schema -- --check  report drift, write nothing
 *
 * schema.sql is the fresh-install path: scripts/init-db.js applies it and then
 * marks every migration as already applied. So the moment a migration adds a
 * column that schema.sql does not have, a NEW database is created without that
 * column AND told the migration that would add it has already run. Nothing
 * fails; the table is simply missing, and the failure surfaces weeks later as
 * an "Unknown column" from a route nobody has touched.
 *
 * Hand-editing forty ALTER statements back into forty CREATE TABLE statements
 * is how that drift happens. This reads the shape from a database the
 * migrations HAVE been applied to and writes it out, so the two cannot
 * disagree.
 *
 * The documentation is preserved. Every comment block above a CREATE TABLE in
 * the existing schema.sql is matched to its table by name and carried across —
 * those comments are the reason the file is worth reading, and a naive dump
 * would throw all of them away.
 *
 * Workflow when you add a migration:
 *   npm run migrate && npm run rebuild-schema && npm run build-init-sql
 */

const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

const SCHEMA = path.join(__dirname, '..', 'schema.sql');

/**
 * Split the existing file into its preamble and one entry per table.
 *
 * A table's documentation is the run of comment lines immediately above its
 * CREATE TABLE, back to the last blank line that is not itself part of a
 * comment block. That is the shape the file is already written in.
 */
function parseExisting(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let preamble = [];
  let seenFirstTable = false;
  let buffer = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^CREATE TABLE(?: IF NOT EXISTS)? [`"]?(\w+)[`"]?/i.exec(line);

    if (!m) {
      buffer.push(line);
      continue;
    }

    // Everything buffered since the last table is this one's comment, except
    // the very first time, where the file's own header comes first.
    if (!seenFirstTable) {
      // The header ends at the first "-- ---" rule; what follows belongs to
      // the first table.
      const ruleAt = buffer.findIndex((l) => /^-- -{20,}/.test(l));
      if (ruleAt === -1) {
        preamble = buffer;
        buffer = [];
      } else {
        preamble = buffer.slice(0, ruleAt);
        buffer = buffer.slice(ruleAt);
      }
      seenFirstTable = true;
    }

    // Skip to the end of the statement.
    let j = i;
    while (j < lines.length && !/^\) ENGINE=/i.test(lines[j])) j += 1;

    blocks.push({ table: m[1], comment: trimBlank(buffer) });
    buffer = [];
    i = j;
  }

  return { preamble: trimBlank(preamble), blocks };
}

const trimBlank = (arr) => {
  const out = [...arr];
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
};

/**
 * Tables in an order where every foreign-key target precedes its referrer.
 *
 * The existing file's order is honoured first — it was chosen deliberately and
 * keeps the diff small — and anything new is appended in dependency order. A
 * table whose referent has not been emitted yet is deferred rather than
 * dropped, so a cycle degrades to "some order" instead of losing a table.
 */
async function orderTables(conn, knownOrder) {
  const [rows] = await conn.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`);
  const all = rows.map((r) => r.TABLE_NAME)
    // schema_migrations is created by the migration runner, not the schema.
    .filter((t) => t !== 'schema_migrations');

  const [fks] = await conn.query(
    `SELECT DISTINCT TABLE_NAME, REFERENCED_TABLE_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
  const deps = new Map(all.map((t) => [t, new Set()]));
  for (const f of fks) {
    if (f.TABLE_NAME === f.REFERENCED_TABLE_NAME) continue; // self-reference
    deps.get(f.TABLE_NAME)?.add(f.REFERENCED_TABLE_NAME);
  }

  const emitted = new Set();
  const out = [];
  const queue = [...knownOrder.filter((t) => all.includes(t)),
    ...all.filter((t) => !knownOrder.includes(t))];

  let progress = true;
  while (queue.length && progress) {
    progress = false;
    for (let i = 0; i < queue.length;) {
      const t = queue[i];
      const ready = [...deps.get(t)].every((d) => emitted.has(d) || !all.includes(d));
      if (ready) {
        out.push(t);
        emitted.add(t);
        queue.splice(i, 1);
        progress = true;
      } else {
        i += 1;
      }
    }
  }
  // Anything left is in a cycle. `purchases` and `git_entries` reference each
  // other on purpose — a bilty is recorded days before the purchase exists
  // (5.2), and the purchase then points back at the bilty it arrived on — so
  // neither can be created with both constraints in place.
  const cyclic = [...queue];
  out.push(...cyclic);
  return { order: out, cyclic };
}

/**
 * The foreign keys that cannot be declared inline because their target is
 * created later in the file.
 *
 * Emitted as ALTER TABLE at the end, which keeps FOREIGN_KEY_CHECKS on
 * throughout. Turning the checks off to make the file load would also have
 * silently accepted a genuinely malformed constraint, which is the one thing
 * this file is checked for.
 */
async function deferredKeys(conn, cyclic, order) {
  if (!cyclic.length) return { deferred: new Map(), statements: [] };

  const position = new Map(order.map((t, i) => [t, i]));
  const [rows] = await conn.query(
    `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_NAME,
            k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`);

  const deferred = new Map();
  const statements = [];
  for (const r of rows) {
    const here = position.get(r.TABLE_NAME);
    const target = position.get(r.REFERENCED_TABLE_NAME);
    if (here === undefined || target === undefined) continue;
    if (r.TABLE_NAME === r.REFERENCED_TABLE_NAME) continue;
    // Only a key whose target is created LATER has to wait.
    if (target < here) continue;

    if (!deferred.has(r.TABLE_NAME)) deferred.set(r.TABLE_NAME, new Set());
    deferred.get(r.TABLE_NAME).add(r.CONSTRAINT_NAME);

    const onDelete = r.DELETE_RULE && r.DELETE_RULE !== 'RESTRICT'
      ? ` ON DELETE ${r.DELETE_RULE}` : '';
    const onUpdate = r.UPDATE_RULE && r.UPDATE_RULE !== 'RESTRICT'
      ? ` ON UPDATE ${r.UPDATE_RULE}` : '';
    statements.push(
      `ALTER TABLE ${r.TABLE_NAME}\n`
      + `  ADD CONSTRAINT ${r.CONSTRAINT_NAME} FOREIGN KEY (${r.COLUMN_NAME})\n`
      + `  REFERENCES ${r.REFERENCED_TABLE_NAME} (${r.REFERENCED_COLUMN_NAME})`
      + `${onDelete}${onUpdate};`,
    );
  }
  return { deferred, statements };
}

/** Remove a named CONSTRAINT clause from a CREATE TABLE statement. */
function stripConstraint(ddl, name) {
  const lines = ddl.split('\n');
  const kept = lines.filter(
    (l) => !new RegExp(`^\\s*CONSTRAINT \`?${name}\`? FOREIGN KEY`).test(l),
  );
  // Dropping the last line before the closing paren leaves a trailing comma on
  // the one above it, which MariaDB rejects.
  for (let i = kept.length - 1; i > 0; i -= 1) {
    if (/^\)/.test(kept[i])) {
      kept[i - 1] = kept[i - 1].replace(/,\s*$/, '');
      break;
    }
  }
  return kept.join('\n');
}

/**
 * Tables whose ROWS are part of the schema, not application data.
 *
 * schema.sql is otherwise structure only — no seed rows, no default users. The
 * exception is vocabulary: a fixed, small set of rows the code reads by key and
 * cannot work without.
 *
 *   shifts               the two shifts of addendum C.1. Without them
 *                        judgeCheckIn has nothing to compare against, so
 *                        nobody is ever late and no day is ever a half day.
 *   cash_discount_bands  the 0-2 / 3-10 / 11-20 day ladder of 3.3. Without
 *                        them every early payment earns nothing.
 *
 * Both are things management edits — that is why they are rows rather than
 * constants in code — but a fresh database with neither is a broken one, not
 * an empty one. Emitted with ON DUPLICATE KEY UPDATE so re-running the file
 * refreshes them rather than failing.
 */
const REFERENCE_TABLES = ['shifts', 'cash_discount_bands'];

async function referenceRows(conn, table) {
  const [rows] = await conn.query(`SELECT * FROM \`${table}\` ORDER BY 1`);
  if (!rows.length) return null;

  const columns = Object.keys(rows[0]);
  const literal = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
    return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  };

  const values = rows.map((r) => `  (${columns.map((c) => literal(r[c])).join(', ')})`);
  // Every non-key column is refreshed; the primary key is what the row is
  // matched on, so updating it would be a no-op at best.
  const updates = columns.slice(1).map((c) => `${c} = VALUES(${c})`).join(', ');

  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values.join(',\n')}\n`
    + (updates ? `ON DUPLICATE KEY UPDATE ${updates};` : ';');
}

/** SHOW CREATE TABLE, normalised to the house style. */
async function createStatement(conn, table) {
  const [[row]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
  let ddl = row['Create Table'];

  // IF NOT EXISTS, so the file stays re-runnable.
  ddl = ddl.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ');
  // Backticks off identifiers that do not need them — the file is written
  // without them and a mixed style reads as an accident.
  ddl = ddl.replace(/`(\w+)`/g, (m, name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : m));
  // MariaDB appends its own collation and AUTO_INCREMENT counter; neither
  // belongs in a schema file, and the counter changes on every insert.
  ddl = ddl.replace(/\s+AUTO_INCREMENT=\d+/g, '');
  ddl = ddl.replace(/DEFAULT CHARSET=(\w+) COLLATE=\S+/g, 'DEFAULT CHARSET=$1');
  return `${ddl};`;
}

async function main() {
  const check = process.argv.includes('--check');
  const existing = fs.readFileSync(SCHEMA, 'utf8');
  const { preamble, blocks } = parseExisting(existing);
  const commentFor = new Map(blocks.map((b) => [b.table, b.comment]));

  const conn = await pool.getConnection();
  let out;
  try {
    const { order, cyclic } = await orderTables(conn, blocks.map((b) => b.table));
    const { deferred, statements } = await deferredKeys(conn, cyclic, order);

    const parts = [preamble.join('\n')];
    for (const table of order) {
      const comment = commentFor.get(table);
      parts.push('');
      if (comment && comment.length) {
        parts.push(comment.join('\n'));
      } else {
        // A new table with no prose yet. Says so, rather than appearing to be
        // documented by the table above it.
        parts.push('-- ---------------------------------------------------------------------------');
        parts.push(`-- ${table}`);
        parts.push(`-- Added by migration. See migrations/ for the reasoning behind this table.`);
        parts.push('-- ---------------------------------------------------------------------------');
      }
      let ddl = await createStatement(conn, table);
      for (const name of deferred.get(table) || []) ddl = stripConstraint(ddl, name);
      parts.push(ddl);
    }

    if (statements.length) {
      parts.push('');
      parts.push('-- ---------------------------------------------------------------------------');
      parts.push('-- Foreign keys that close a cycle.');
      parts.push('--');
      parts.push('-- `purchases` and `git_entries` reference each other deliberately: a bilty is');
      parts.push('-- recorded days before the purchase exists (requirements 5.2), and the purchase');
      parts.push('-- then points back at the bilty it arrived on. Neither table can be created');
      parts.push('-- with both constraints in place, so the one that closes the loop is added');
      parts.push('-- here, after both exist.');
      parts.push('--');
      parts.push('-- Added rather than skipped with FOREIGN_KEY_CHECKS = 0, which would also have');
      parts.push('-- silently accepted a genuinely malformed constraint.');
      parts.push('-- ---------------------------------------------------------------------------');
      parts.push(statements.join('\n\n'));
    }

    const reference = [];
    for (const table of REFERENCE_TABLES) {
      if (!order.includes(table)) continue;
      const sql = await referenceRows(conn, table);
      if (sql) reference.push(sql);
    }
    if (reference.length) {
      parts.push('');
      parts.push('-- ---------------------------------------------------------------------------');
      parts.push('-- Reference rows.');
      parts.push('--');
      parts.push('-- The one exception to "structure only". These are vocabulary the code reads');
      parts.push('-- by key and cannot work without: the two shift timings that decide whether a');
      parts.push('-- check-in was late, and the cash-discount ladder that decides what an early');
      parts.push('-- payment earns. A database without them is broken, not empty.');
      parts.push('--');
      parts.push('-- They are rows rather than constants because management adjusts them — the');
      parts.push('-- grace period and the half-day cut-off are business decisions, and changing');
      parts.push('-- one should not need a deployment.');
      parts.push('-- ---------------------------------------------------------------------------');
      parts.push(reference.join('\n\n'));
    }

    out = `${parts.join('\n')}\n`;
  } finally {
    conn.release();
    await pool.end();
  }

  if (out === existing) {
    console.log('[SCHEMA] schema.sql already matches the database.');
    return;
  }

  const before = existing.split('\n').length;
  const after = out.split('\n').length;

  if (check) {
    console.log(`[SCHEMA] DRIFT — schema.sql does not match the database (${before} lines vs ${after}).`);
    console.log('         Run: npm run rebuild-schema && npm run build-init-sql');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(SCHEMA, out);
  console.log(`[SCHEMA] schema.sql rewritten from the database — ${before} → ${after} lines.`);
  console.log('         Now run: npm run build-init-sql');
}

main().catch((err) => {
  console.error('[SCHEMA] failed:', err.message);
  process.exit(1);
});
