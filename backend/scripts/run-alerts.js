#!/usr/bin/env node
/**
 * The alert sweep, on demand.
 *
 *   npm run alerts            run every rule once and report what fired
 *
 * server.js runs the same sweep hourly. This exists for the same reason
 * scripts/auto-checkout.js does: to run it from Task Scheduler when the server
 * is started with ALERTS_ENABLED=false, and to see what it would do without
 * waiting an hour.
 */
const pool = require('../config/db');
const { runAlerts } = require('../utils/alerts');

(async () => {
  try {
    console.log('[ALERTS] sweeping…');
    const { day, results } = await runAlerts(pool, { verbose: true });
    const sent = results.reduce((a, r) => a + (r.sent || 0), 0);
    const failed = results.filter((r) => r.error);
    console.log(`\n[ALERTS] ${day}: ${sent} notification(s) raised.`);
    if (failed.length) {
      failed.forEach((f) => console.error(`  ! ${f.rule}: ${f.error}`));
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
})().catch((err) => { console.error('[ALERTS] failed:', err.message); process.exit(1); });
