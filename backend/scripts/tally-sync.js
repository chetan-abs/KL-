#!/usr/bin/env node
/**
 * The Tally worker.
 *
 *   npm run tally              one push cycle
 *   npm run tally -- --pull    push, then pull the masters and reconcile
 *   npm run tally -- --watch   run continuously (this is "real-time")
 *   npm run tally -- --ping    is Tally reachable, and is it configured?
 *   npm run tally -- --doctor  the full preflight — run this FIRST on the
 *                              office machine, before enabling the sync
 *
 * server.js runs the push cycle on a short timer when TALLY_ENABLED=true, which
 * is what section 14's "real-time" means in practice: a document is in Tally
 * within seconds of the business fact, without the salesman's request waiting
 * on an accounting package that may be closed.
 *
 * This script exists for the same reasons scripts/auto-checkout.js does — to
 * run from Task Scheduler when the API is started with the timer off, and to
 * see what one cycle does without waiting for it.
 */
const pool = require('../config/db');
const { config, ping, doctor } = require('../utils/tally');
const { cycle } = require('../utils/tallySync');

const INTERVAL_MS = Number(process.env.TALLY_INTERVAL_MS || 30000);

function report(out) {
  if (out.note) { console.log(`[TALLY] ${out.note}`); return; }
  if (out.push) {
    const p = out.push;
    if (p.skipped) console.log('[TALLY] push skipped — not configured.');
    else if (p.reachable === false) console.log(`[TALLY] Tally unreachable: ${p.note}`);
    else console.log(`[TALLY] pushed ${p.sent}, failed ${p.failed}`);
  }
  if (out.pull) {
    for (const [scope, r] of Object.entries(out.pull)) {
      if (!r || r.reachable === false) { console.log(`[TALLY] pull ${scope}: unreachable`); continue; }
      console.log(`[TALLY] pull ${scope}: ${JSON.stringify(r)}`);
    }
  }
}

(async () => {
  const cfg = config();

  if (process.argv.includes('--ping')) {
    console.log(JSON.stringify(await ping(), null, 2));
    await pool.end();
    return;
  }

  // The preflight. Run this FIRST on the office machine — it answers every
  // question the first push would otherwise fail on, and each failure says what
  // to do about it rather than merely that it failed.
  if (process.argv.includes('--doctor')) {
    const report = await doctor();
    console.log(`
  Tally at ${report.config.host}, company "${report.config.company || '(unset)'}"
`);
    for (const c of report.checks) {
      console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name}`);
      if (c.detail) console.log(`          ${c.detail}`);
      if (!c.ok && c.fix) console.log(`          → ${c.fix}`);
    }
    console.log(report.ok
      ? '\n  All checks passed. Set TALLY_ENABLED=true and run: npm run tally -- --watch'
      : '\n  Fix the failures above, then run this again.');
    await pool.end();
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  console.log(`[TALLY] ${cfg.host}:${cfg.port} company=${cfg.company || '(unset)'} `
    + `enabled=${cfg.enabled}`);

  const pullMasters = process.argv.includes('--pull');

  if (!process.argv.includes('--watch')) {
    report(await cycle(pool, { pullMasters }));
    await pool.end();
    return;
  }

  // Watch mode never exits and never throws: cycle() swallows its own errors so
  // a closed Tally cannot take the worker down overnight.
  console.log(`[TALLY] watching, every ${INTERVAL_MS}ms. Ctrl+C to stop.`);
  let pulls = 0;
  for (;;) {
    // Masters are pulled every 60th cycle — half an hour at the default
    // interval. 7,000 parties and 7,300 items is a large export and nothing
    // about a party master changes minute to minute.
    const doPull = pullMasters && pulls % 60 === 0;
    report(await cycle(pool, { pullMasters: doPull }));
    pulls += 1;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})().catch(async (err) => {
  console.error('[TALLY] failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
