/**
 * Rebuilds the two cached columns from the ledgers behind them.
 *
 *   npm run recompute -- --dry-run    report what disagrees, change nothing
 *   npm run recompute                 rebuild both caches
 *   npm run recompute -- --stock      only items.qty
 *   npm run recompute -- --balance    only customers.closing_balance
 *
 * `items.qty` and `customers.closing_balance` are caches, not truth:
 *
 *   items.qty               = SUM(stock_movements.change_qty)
 *   customers.closing_balance = issued invoices - receipts - issued credit notes
 *
 * Both are maintained inside the transaction that changes one of their inputs,
 * so in normal running this script finds nothing. It exists for the two cases
 * where that is not enough: a schema change that adds a new input (payments did
 * exactly this — invoices raised before the payments table existed never had a
 * balance computed), and any direct SQL somebody runs against the tables.
 *
 * Safe to run at any time. It only ever writes the value the ledger already
 * implies, so running it twice is the same as running it once.
 */
const pool = require('../config/db');

const dryRun = process.argv.includes('--dry-run');
const only = process.argv.includes('--stock')
  ? 'stock'
  : process.argv.includes('--balance')
    ? 'balance'
    : 'both';

const money = (n) => Number(n).toFixed(2);

async function checkStock(conn) {
  const [rows] = await conn.query(`
    SELECT masterid, name, cached, ledger FROM (
      SELECT i.masterid, i.name, i.qty AS cached,
             COALESCE((SELECT SUM(m.change_qty) FROM stock_movements m
                        WHERE m.item_id = i.masterid), 0) AS ledger
        FROM items i
    ) x WHERE ABS(cached - ledger) > 0.0001
  `);
  return rows;
}

async function checkBalances(conn) {
  const [rows] = await conn.query(`
    SELECT masterid, name, cached, derived FROM (
      SELECT c.masterid, c.name, c.closing_balance AS cached,
             COALESCE((SELECT SUM(i.grand_total) FROM invoices i
                        WHERE i.customer_id = c.masterid AND i.status = 'issued'), 0)
           - COALESCE((SELECT SUM(p.amount) FROM payments p
                        WHERE p.customer_id = c.masterid AND p.status = 'received'), 0)
           - COALESCE((SELECT SUM(n.amount) FROM credit_notes n
                        WHERE n.customer_id = c.masterid AND n.status = 'issued'), 0) AS derived
        FROM customers c
    ) x WHERE ABS(cached - derived) > 0.005
  `);
  return rows;
}

async function main() {
  const conn = await pool.getConnection();
  let fixed = 0;

  try {
    if (only !== 'balance') {
      const drift = await checkStock(conn);
      console.log(`[STOCK]   ${drift.length} item(s) disagree with the movement ledger.`);
      for (const row of drift.slice(0, 20)) {
        console.log(`          ${row.name}: cached ${row.cached}, ledger ${row.ledger}`);
      }
      if (drift.length > 20) console.log(`          … and ${drift.length - 20} more.`);

      if (drift.length && !dryRun) {
        // Rebuilt for every item rather than only the drifted ones: the whole
        // point is that the ledger is the truth, and a targeted update would
        // trust the very column being repaired to say which rows need it.
        await conn.query(`
          UPDATE items i SET i.qty = COALESCE(
            (SELECT SUM(m.change_qty) FROM stock_movements m WHERE m.item_id = i.masterid), 0)
        `);
        fixed += drift.length;
        console.log(`[STOCK]   rebuilt.`);
      }
    }

    if (only !== 'stock') {
      const drift = await checkBalances(conn);
      console.log(`[BALANCE] ${drift.length} party balance(s) disagree with their documents.`);
      for (const row of drift.slice(0, 20)) {
        console.log(`          ${row.name}: cached ${money(row.cached)}, derived ${money(row.derived)}`);
      }
      if (drift.length > 20) console.log(`          … and ${drift.length - 20} more.`);

      if (drift.length && !dryRun) {
        await conn.query(`
          UPDATE customers c SET c.closing_balance = (
              COALESCE((SELECT SUM(i.grand_total) FROM invoices i
                         WHERE i.customer_id = c.masterid AND i.status = 'issued'), 0)
            - COALESCE((SELECT SUM(p.amount) FROM payments p
                         WHERE p.customer_id = c.masterid AND p.status = 'received'), 0)
            - COALESCE((SELECT SUM(n.amount) FROM credit_notes n
                         WHERE n.customer_id = c.masterid AND n.status = 'issued'), 0)
          )
        `);
        fixed += drift.length;
        console.log(`[BALANCE] rebuilt.`);
      }
    }

    if (dryRun) console.log('\n[DRY RUN] nothing was written.');
    else if (fixed) console.log(`\n[DONE] ${fixed} row(s) brought back in line.`);
    else console.log('\n[DONE] every cache already matched its ledger.');
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('[RECOMPUTE] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
