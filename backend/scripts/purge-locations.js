/**
 * Deletes location_logs rows older than the retention window.
 *
 * location_logs is the one table with no natural ceiling: background GPS pings
 * land every 10 minutes per checked-in employee, roughly 50 rows each per
 * working day. Nothing else in the schema ever removes them.
 *
 *   node scripts/purge-locations.js              # delete, using LOCATION_RETENTION_DAYS
 *   node scripts/purge-locations.js --days 180   # override the window
 *   node scripts/purge-locations.js --dry-run    # report what would go, delete nothing
 *
 * Set LOCATION_RETENTION_DAYS in .env and run this on a schedule (Task
 * Scheduler on Windows, cron elsewhere). Deleting is irreversible: these rows
 * are the only record of where an employee was, which may matter for payroll
 * or dispute resolution, so pick the window deliberately rather than accepting
 * the default.
 */
const pool = require('../config/db');

const DEFAULT_RETENTION_DAYS = 90;

// Rows are removed in batches so a first run against a large backlog does not
// hold one enormous transaction or lock the table against live inserts.
const BATCH_SIZE = 5000;

function arg(flag) {
  const i = process.argv.indexOf(`--${flag}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const days = parseInt(
    arg('days') || process.env.LOCATION_RETENTION_DAYS || DEFAULT_RETENTION_DAYS,
    10
  );

  if (!Number.isInteger(days) || days < 1) {
    console.error(`Retention must be a positive whole number of days, got: ${days}`);
    process.exit(1);
  }

  const [[{ cutoff }]] = await pool.query(
    'SELECT DATE_SUB(UTC_TIMESTAMP(), INTERVAL ? DAY) AS cutoff',
    [days]
  );

  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) AS total FROM location_logs WHERE recorded_at < ?',
    [cutoff]
  );

  console.log(`[PURGE] retention: ${days} day(s) — cutoff ${cutoff} UTC`);
  console.log(`[PURGE] rows older than cutoff: ${total}`);

  if (dryRun) {
    console.log('[PURGE] --dry-run: nothing was deleted.');
    await pool.end();
    return;
  }

  if (total === 0) {
    console.log('[PURGE] nothing to delete.');
    await pool.end();
    return;
  }

  let deleted = 0;
  for (;;) {
    const [res] = await pool.query(
      'DELETE FROM location_logs WHERE recorded_at < ? LIMIT ?',
      [cutoff, BATCH_SIZE]
    );
    deleted += res.affectedRows;
    if (res.affectedRows < BATCH_SIZE) break;
    console.log(`[PURGE] deleted ${deleted}/${total}…`);
  }

  console.log(`[PURGE] done — ${deleted} row(s) deleted.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('[PURGE] failed:', err.sqlMessage || err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
