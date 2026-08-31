/**
 * Closes shifts that were never checked out of.
 *
 *   node scripts/auto-checkout.js             # close them
 *   node scripts/auto-checkout.js --dry-run   # list what would be closed
 *
 * The server also runs this itself once an hour (see server.js), so scheduling
 * it is optional — this exists for a one-off sweep after a period when the
 * server was down, and for checking what the rule would do before trusting it.
 *
 * AUTO_CHECKOUT_TIME (HH:MM, business timezone, default 19:00) sets the time of
 * day a forgotten shift is closed at. Only days before today are touched.
 */
const pool = require('../config/db');
const { runAutoCheckout } = require('../utils/autoCheckout');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const { closed, rows } = await runAutoCheckout({ dryRun });

  if (rows.length === 0) {
    console.log('[SHIFT] no open shifts from earlier days — nothing to close.');
    await pool.end();
    return;
  }

  for (const row of rows) {
    console.log(
      `[SHIFT] ${row.checkin_date} ${row.employee_id} (${row.name}) — in ${row.checkin_time}, closing at ${row.closingAt} UTC`
    );
  }

  if (dryRun) {
    console.log(`[SHIFT] --dry-run: ${rows.length} shift(s) would be closed. Nothing was changed.`);
  } else {
    console.log(`[SHIFT] closed ${closed} shift(s).`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[SHIFT] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
