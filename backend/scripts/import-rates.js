#!/usr/bin/env node
/**
 * Load the rate cards into `items`.
 *
 *   npm run import-rates -- --file ../KL_APP_RATES_markups_3.xlsx
 *   npm run import-rates -- --file ../LEMAC_Developer_Master_v7.xlsx
 *   npm run import-rates -- --all                 # both, in the repo root
 *   npm run import-rates -- --all --dry-run       # report, write nothing
 *
 * Two spreadsheets, two layouts, one target. The KL sheet is the 8,519-item
 * house range; the Lemac sheet is a 451-item brand with its own scheme regime
 * and its own column order. Rather than one importer with a pile of branches,
 * each has a LAYOUT describing where its columns are and how its values are
 * written, and the loader is shared.
 *
 * Matched on item name, case- and space-insensitively. Neither sheet has a
 * stable identifier: the KL sheet's "Sl. No." is a row sequence that moves
 * between issues, and "Item Code" is filled on only 1,724 of 8,519 rows. The
 * name is what Tally, the pickers and the salesmen all use.
 *
 * Opening balances are written as `opening` rows in stock_movements and never
 * as an UPDATE to items.qty — the ledger is the truth and the column is its
 * cache. A second run does not re-open a balance it has already opened.
 */

const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const pool = require('../config/db');
const { money, qty, recomputeItemQty } = require('../utils/workflow');

// ---------------------------------------------------------------------------
// Value readers
//
// The two sheets disagree about how to write a percentage. KL holds fractions
// as numbers (0.62). Lemac holds strings ("52%"), and "N/A" where a column
// does not apply to that pricing type. Both have to become the same fraction.
// ---------------------------------------------------------------------------

const BLANK = new Set(['', '-', 'n/a', 'na', 'nil', 'none', '#n/a']);

function text(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** A fraction in 0..1, from either 0.52 or "52%". */
function fraction(v, { row, column, warn }) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    // Guards a sheet that switches to whole percents mid-column. Ratios are
    // markups and can legitimately exceed 1, so the threshold is generous and
    // the coercion is reported rather than silent.
    if (v > 2) {
      warn?.(`row ${row}: ${column} = ${v}, read as ${v / 100}`);
      return v / 100;
    }
    return v;
  }
  const s = String(v).trim().toLowerCase();
  if (BLANK.has(s)) return null;
  const pct = s.endsWith('%');
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return null;
  return pct ? n / 100 : (n > 2 ? n / 100 : n);
}

function number(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (BLANK.has(s.toLowerCase())) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "Yes"/"No" → 1/0/null. */
function flag(v) {
  const s = text(v);
  if (s === null) return null;
  const l = s.toLowerCase();
  if (['yes', 'y', 'true', '1'].includes(l)) return 1;
  if (['no', 'n', 'false', '0'].includes(l)) return 0;
  return null;
}

function pricingType(v) {
  const s = text(v);
  if (!s) return null;
  const l = s.toLowerCase().replace(/\s+/g, ' ');
  if (l === 'net') return 'net';
  if (l.startsWith('list less')) return 'list_less_disc';
  return null;
}

/**
 * The join key. Tally's own names carry doubled spaces and stray control
 * characters ("_x0004_ Primary" is a real brand in the KL sheet), so the key
 * collapses whitespace and lowercases; it never strips punctuation, because
 * "H-982" and "H982" are genuinely different items.
 */
const key = (name) => String(name).replace(/\s+/g, ' ').trim().toLowerCase();

// ---------------------------------------------------------------------------
// Layouts
//
// Columns are 1-based to match what a spreadsheet shows, so a column can be
// checked against the file by eye without counting from zero.
// ---------------------------------------------------------------------------

const KL_LAYOUT = {
  id: 'kl',
  sheet: 'kl app rates 14 june complete',
  headerRow: 10,
  firstDataRow: 11,
  // The workbook carries a second sheet naming 51 rows whose price has been
  // zeroed and which must not be imported.
  skipSheet: 'IGNORE_KBC_SELEKT',
  skipNameColumn: 3,
  map: {
    name: 2,
    brand: 3,
    code: 4,
    unit: 5,
    min_stock: 6,
    pricing_type: 7,
    base_price: 8,
    disc_dealer: 9,
    disc_builder_direct: 10,
    disc_builder_comm: 11,
    disc_retail_direct: 12,
    disc_retail_comm: 13,
    ratio_builder_direct: 14,
    ratio_builder_comm: 15,
    ratio_retail_direct: 16,
    ratio_retail_comm: 17,
    opening_balance: 19,
    comm_retail_agent: 20,
    comm_builder_agent: 21,
    disc_electrician: 22,
    ratio_electrician: 23,
    scheme_weightage: 24,
  },
};

const LEMAC_LAYOUT = {
  id: 'lemac',
  sheet: 'Product Master',
  headerRow: 1,
  firstDataRow: 2,
  map: {
    name: 2,
    brand: 3,
    category: 3,
    base_price: 4,
    pricing_type: 5,
    disc_dealer: 6,
    disc_builder_direct: 7,
    disc_builder_comm: 8,
    disc_electrician: 9,
    disc_retail_direct: 10,
    disc_retail_comm: 11,
    sch_modular_monthly: 12,
    sch_modular_quarterly: 13,
    sch_modular_yearly: 14,
    sch_dream_monthly: 15,
    sch_boxes_monthly: 16,
    sch_electrician: 17,
    sch_cash_discount: 18,
    modular_weightage: 19,
    incentive_category: 20,
    // For a Net row the dealer pays THIS, not the List Price in column 4.
    // "10A 1-way switches have FIXED NET rates — discounts do NOT apply."
    net_rate: 21,
    ratio_builder_direct: 22,
    ratio_builder_comm: 23,
    ratio_electrician: 24,
    ratio_retail_direct: 25,
    ratio_retail_comm: 26,
    comm_retail_agent: 27,
    comm_builder_agent: 28,
  },
};

const FRACTION_COLUMNS = new Set([
  'disc_dealer', 'disc_builder_direct', 'disc_builder_comm', 'disc_retail_direct',
  'disc_retail_comm', 'disc_electrician',
  'ratio_builder_direct', 'ratio_builder_comm', 'ratio_retail_direct',
  'ratio_retail_comm', 'ratio_electrician',
  'comm_retail_agent', 'comm_builder_agent', 'scheme_weightage', 'modular_weightage',
]);

const FLAG_COLUMNS = new Set([
  'sch_modular_monthly', 'sch_modular_quarterly', 'sch_modular_yearly',
  'sch_dream_monthly', 'sch_boxes_monthly', 'sch_electrician', 'sch_cash_discount',
]);

/** Columns written straight into `items`. */
const ITEM_COLUMNS = [
  'brand', 'category', 'code', 'unit', 'min_stock', 'pricing_type', 'base_price',
  ...FRACTION_COLUMNS, ...FLAG_COLUMNS, 'incentive_category',
];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * `wb` is an already-loaded workbook, not a path — the CLI loads one from
 * disk with `XLSX.readFile`; the in-app importer (`routes/items.js`) loads
 * one from an uploaded buffer with `XLSX.read`. Both hand the same shape to
 * everything below this point, which is the only reason the parsing logic
 * did not have to be written twice.
 */
function readSheet(wb, layout, warn) {
  const ws = wb.Sheets[layout.sheet];
  if (!ws) {
    throw new Error(
      `No sheet "${layout.sheet}" — found: ${wb.SheetNames.join(', ')}`,
    );
  }

  // Names to skip, from the workbook's own ignore list.
  const skip = new Set();
  if (layout.skipSheet && wb.Sheets[layout.skipSheet]) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[layout.skipSheet], { header: 1, blankrows: false });
    for (const r of rows.slice(1)) {
      const n = r[layout.skipNameColumn - 1];
      if (n) skip.add(key(n));
    }
  }

  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  const out = [];
  const cell = (row, col) => (col ? row[col - 1] ?? null : null);

  for (let i = layout.firstDataRow - 1; i < grid.length; i += 1) {
    const row = grid[i];
    if (!row) continue;
    const rawName = text(cell(row, layout.map.name));
    if (!rawName) continue;
    // Tally exports a literal "None" for one unnamed pair of rows.
    if (rawName.toLowerCase() === 'none') continue;
    if (skip.has(key(rawName))) continue;

    const rowNo = i + 1;
    const rec = { name: rawName, _row: rowNo, _source: layout.id };

    for (const [field, col] of Object.entries(layout.map)) {
      if (field === 'name') continue;
      const raw = cell(row, col);
      if (FRACTION_COLUMNS.has(field)) {
        rec[field] = fraction(raw, { row: rowNo, column: field, warn });
      } else if (FLAG_COLUMNS.has(field)) {
        rec[field] = flag(raw);
      } else if (field === 'pricing_type') {
        rec[field] = pricingType(raw);
      } else if (['base_price', 'min_stock', 'opening_balance', 'net_rate'].includes(field)) {
        rec[field] = number(raw);
      } else {
        rec[field] = text(raw);
      }
    }

    // A Net row's base price is the net rate column, where the sheet has one.
    if (rec.pricing_type === 'net' && rec.net_rate !== null && rec.net_rate !== undefined) {
      rec.base_price = rec.net_rate;
    }
    delete rec.net_rate;

    // Names longer than the column would be truncated by MariaDB in a way that
    // silently merges two items. The longest in either sheet is 87, so this is
    // a guard against a future issue rather than a live problem.
    if (rec.name.length > 100) {
      warn(`row ${rowNo}: name is ${rec.name.length} characters, skipped — "${rec.name.slice(0, 60)}…"`);
      continue;
    }

    out.push(rec);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * `addOnly` is the in-app importer's mode: "compare with what's already
 * there, add what's missing, leave the rest alone." Skipping the UPDATE
 * branch entirely rather than filtering rows beforehand, so `stats.ignored`
 * still counts every name the sheet and the table agree on — the owner asked
 * for that number, not just the new ones.
 */
async function importFile(conn, wb, layout, { dryRun, warn, addOnly = false }) {
  const rows = readSheet(wb, layout, warn);

  const [existing] = await conn.query('SELECT masterid, name FROM items');
  const byKey = new Map(existing.map((r) => [key(r.name), r.masterid]));

  const stats = {
    read: rows.length, created: 0, updated: 0, ignored: 0, skipped: 0, opened: 0, unpriced: 0,
  };
  const seen = new Set();
  const createdNames = [];

  for (const rec of rows) {
    const k = key(rec.name);
    if (seen.has(k)) {
      // Two rows for one name: the sheet has exactly one such pair. The first
      // wins, because merging them would silently average two rate cards.
      warn(`row ${rec._row}: duplicate name "${rec.name}", second occurrence skipped`);
      stats.skipped += 1;
      continue;
    }
    seen.add(k);

    const id = byKey.get(k);

    if (id && addOnly) {
      stats.ignored += 1;
      continue;
    }

    if (!rec.pricing_type) stats.unpriced += 1;

    const values = {};
    for (const col of ITEM_COLUMNS) {
      if (col in rec) values[col] = rec[col];
    }
    // A blank cell in the sheet means "not applicable to this pricing type",
    // not "leave whatever was there before". Writing null is deliberate: an
    // item switched from list-less-disc to net must lose its discounts, or
    // the pricing engine could read a stale column.
    values.base_price = rec.base_price ?? 0;
    values.min_stock = rec.min_stock ?? 0;

    if (dryRun) {
      if (id) stats.updated += 1; else stats.created += 1;
      continue;
    }

    if (id) {
      const cols = Object.keys(values);
      await conn.query(
        `UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE masterid = ?`,
        [...cols.map((c) => values[c]), id],
      );
      stats.updated += 1;
      await openBalance(conn, id, rec, stats);
    } else {
      const cols = ['name', ...Object.keys(values)];
      const [res] = await conn.query(
        `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        [rec.name, ...Object.keys(values).map((c) => values[c])],
      );
      byKey.set(k, res.insertId);
      stats.created += 1;
      createdNames.push(rec.name);
      await openBalance(conn, res.insertId, rec, stats);
    }
  }

  stats.createdNames = createdNames;
  return stats;
}

/**
 * The sheet's Opening Balance column, as a stock movement.
 *
 * Written once per item ever. `items.qty` is a cache of `stock_movements`, so
 * an opening balance is a ledger row like any other; running the importer
 * again after a fresh rate card must not open the balance a second time and
 * double everyone's stock.
 */
async function openBalance(conn, itemId, rec, stats) {
  const opening = rec.opening_balance;
  if (opening === null || opening === undefined || opening === 0) return;

  const [[already]] = await conn.query(
    `SELECT COUNT(*) AS n FROM stock_movements WHERE item_id = ? AND reason = 'opening'`,
    [itemId],
  );
  if (already.n > 0) return;

  await conn.query(
    `INSERT INTO stock_movements (item_id, change_qty, reason, ref_type, ref_id, note)
     VALUES (?, ?, 'opening', 'import', NULL, ?)`,
    [itemId, qty(opening), `opening balance from rate sheet row ${rec._row}`],
  );
  await recomputeItemQty(conn, itemId);
  stats.opened += 1;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1] ?? true;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const all = process.argv.includes('--all');
  const one = arg('file');

  const root = path.resolve(__dirname, '..', '..');
  const targets = [];
  if (all || !one) {
    targets.push(
      { file: path.join(root, 'KL_APP_RATES_markups_3.xlsx'), layout: KL_LAYOUT },
      { file: path.join(root, 'LEMAC_Developer_Master_v7.xlsx'), layout: LEMAC_LAYOUT },
    );
  } else {
    const file = path.resolve(one);
    const base = path.basename(file).toLowerCase();
    const layout = base.includes('lemac') ? LEMAC_LAYOUT : KL_LAYOUT;
    targets.push({ file, layout });
  }

  for (const t of targets) {
    if (!fs.existsSync(t.file)) {
      console.error(`[IMPORT] not found: ${t.file}`);
      process.exitCode = 1;
      return;
    }
  }

  const conn = await pool.getConnection();
  try {
    for (const { file, layout } of targets) {
      const warnings = [];
      const warn = (m) => { if (warnings.length < 40) warnings.push(m); };

      console.log(`\n[IMPORT] ${path.basename(file)} → sheet "${layout.sheet}"`);
      const wb = XLSX.readFile(file, { cellDates: false });
      await conn.beginTransaction();
      let stats;
      try {
        stats = await importFile(conn, wb, layout, { dryRun, warn });
        if (dryRun) {
          await conn.rollback();
        } else {
          await conn.query(
            `INSERT INTO item_import_log
               (source_file, sheet_name, rows_read, rows_created, rows_updated, rows_skipped, note)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [path.basename(file), layout.sheet, stats.read, stats.created, stats.updated,
              stats.skipped, `${stats.unpriced} rows with no pricing type; ${stats.opened} opening balances`],
          );
          await conn.commit();
        }
      } catch (err) {
        await conn.rollback();
        throw err;
      }

      console.log(`  read      ${stats.read}`);
      console.log(`  created   ${stats.created}`);
      console.log(`  updated   ${stats.updated}`);
      console.log(`  skipped   ${stats.skipped}`);
      console.log(`  opening   ${stats.opened} balance rows written`);
      console.log(`  unpriced  ${stats.unpriced} rows carry no pricing type and cannot be sold`);
      if (warnings.length) {
        console.log(`  warnings  ${warnings.length}${warnings.length === 40 ? '+ (truncated)' : ''}`);
        warnings.forEach((w) => console.log(`    - ${w}`));
      }
      if (dryRun) console.log('  (dry run — rolled back)');
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

// Guarded so `require('./import-rates')` from routes/items.js — the in-app
// importer's layouts and parser — does not also re-run the CLI's own main().
if (require.main === module) {
  main().catch((err) => {
    console.error('[IMPORT] failed:', err.message);
    process.exit(1);
  });
}

module.exports = { KL_LAYOUT, LEMAC_LAYOUT, importFile };
