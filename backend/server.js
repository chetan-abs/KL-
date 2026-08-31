/**
 * HTTP entry point.
 *
 *   npm start    # run
 *   npm run dev  # run with restart-on-change (node --watch)
 *
 * This is the server skeleton only: process lifecycle, JSON handling, CORS,
 * health checks, and the error boundary that route modules will sit inside.
 * No business routes and no auth are mounted yet — mount them at the marker
 * below as they are written.
 */
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const pool = require('./config/db');
const { runAutoCheckout } = require('./utils/autoCheckout');
const { runAlerts } = require('./utils/alerts');
const { cycle: tallyCycle } = require('./utils/tallySync');

const PORT = parseInt(process.env.PORT, 10) || 5000;

// The Expo app runs from a different origin on every target — a LAN IP on
// device, localhost on web — so development accepts any origin. CORS_ORIGIN
// takes a comma-separated list; set it before anything is deployed.
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : '*';

const app = express();

app.disable('x-powered-by');

// Hand-rolled rather than pulled from helmet: these four headers are the ones
// that matter for a JSON API with no HTML surface, and they are cheaper than a
// dependency. An API response is never a document, never framed, and never
// something a browser should sniff a type for.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

// Liveness: the process is up. Does not touch the database, so a monitor
// cannot mistake a database outage for a dead process.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: the process is up AND can reach MySQL. This is the one to point a
// deployment check at. Express 5 forwards a rejected async handler to the error
// middleware on its own, but the failure is caught here to return 503 rather
// than a generic 500 — a database that is merely unreachable is not a bug.
app.get('/health/db', async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT 1 AS ok, @@session.time_zone AS tz');
    res.json({ status: 'ok', db: 'reachable', sessionTimeZone: row.tz });
  } catch (err) {
    // The reason is logged, not returned: this endpoint is unauthenticated,
    // and a raw MySQL error names the host, the port, the database and the
    // user it tried to connect as.
    console.error('[API] readiness check failed:', err.sqlMessage || err.message);
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

// ---------------------------------------------------------------------------
// Routes
//
// Protected routes take `authenticate` and then `requirePermission('area.action')`
// from middleware/auth.js, which resolves against users.permissions. Guards are
// applied per route rather than per router — an area grant satisfies an action
// check, never the reverse.
// ---------------------------------------------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/location', require('./routes/locations'));
app.use('/api/items', require('./routes/items'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/reports', require('./routes/reports'));

// The phone app's pipeline. Split by duty rather than by table: approval,
// picking and verification are three people's work and share a router only
// because they share an order, while billing, dispatch and cash are separate
// jobs held by separate people.
app.use('/api/workflow', require('./routes/workflow'));
app.use('/api/agents', require('./routes/agents'));
app.use('/api/invoices', require('./routes/invoices'));
app.use('/api/dispatch', require('./routes/dispatch'));
app.use('/api/purchases', require('./routes/purchases'));
app.use('/api/returns', require('./routes/returns'));
app.use('/api/field', require('./routes/field'));
app.use('/api/cash', require('./routes/cash'));
app.use('/api/stock-counts', require('./routes/stockcount'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/incentives', require('./routes/incentives'));
app.use('/api/git', require('./routes/git'));
app.use('/api/schemes', require('./routes/schemes'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/reportsuite', require('./routes/reportsuite'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/tally', require('./routes/tally'));

// Unmatched routes. Registered with app.use rather than app.get('*') because
// Express 5 uses path-to-regexp v8, where a bare '*' is no longer a valid path.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl });
});

// Error boundary. Four arguments is what marks this as error middleware — do
// not remove `next` even though it is unused.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[API] unhandled:', err.stack || err.message);
  const status = err.status || 500;
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
    // A stack trace is a disclosure risk, so it is attached only outside production.
    ...(process.env.NODE_ENV === 'production' ? {} : { detail: err.message }),
  });
});

// ---------------------------------------------------------------------------
// Scheduled work
// ---------------------------------------------------------------------------

// Shifts nobody checked out of are closed here rather than by an operator
// remembering to run a script. Hourly, because the sweep only ever touches days
// before today: running it more often changes nothing, and running it less often
// leaves yesterday's forgotten shift open on the map all morning.
//
// unref'd so it never holds the process open during shutdown. Set
// AUTO_CHECKOUT_ENABLED=false to leave it to scripts/auto-checkout.js instead.
const AUTO_CHECKOUT_ENABLED = process.env.AUTO_CHECKOUT_ENABLED !== 'false';
// Set ALERTS_ENABLED=false to run scripts/run-alerts.js on a schedule instead.
const ALERTS_ENABLED = process.env.ALERTS_ENABLED !== 'false';

// Tally is OFF unless switched on deliberately. A half-configured sync that
// pushes documents into the wrong company is worse than no sync, so this
// requires TALLY_ENABLED=true and a correct TALLY_COMPANY. Run
// `npm run tally -- --ping` to check both before enabling.
const TALLY_ENABLED = process.env.TALLY_ENABLED === 'true';
const TALLY_INTERVAL_MS = Number(process.env.TALLY_INTERVAL_MS || 30000);

async function sweepOpenShifts() {
  try {
    const { closed } = await runAutoCheckout();
    if (closed) console.log(`[SHIFT] auto-closed ${closed} shift(s) left open.`);
  } catch (err) {
    // A failed sweep is not a reason to take the API down with it.
    console.error('[SHIFT] auto-checkout sweep failed:', err.sqlMessage || err.message);
  }
}

if (AUTO_CHECKOUT_ENABLED && require.main === module) {
  const sweep = setInterval(sweepOpenShifts, 60 * 60 * 1000);
  sweep.unref();
  sweepOpenShifts();
}

/**
 * The notifications nothing triggers.
 *
 * Section 13 of the requirements lists a dozen alerts that fire because
 * something did NOT happen by a deadline — the EOD that was not submitted by
 * 7:15, the van that had not left by 10:30, the GST bill that has not arrived
 * in seven days. No request causes them, so the server has to look.
 *
 * Hourly, like the shift sweep, and each rule checks the business-timezone
 * clock itself rather than trusting the tick. utils/alerts.js writes an
 * alert_log row per (rule, subject, day), so a restart mid-morning cannot
 * re-send the morning's alerts.
 */
async function sweepAlerts() {
  try {
    const { results } = await runAlerts(pool);
    const sent = results.reduce((a, r) => a + (r.sent || 0), 0);
    if (sent) console.log(`[ALERTS] raised ${sent} notification(s): ${results.map((r) => r.rule).join(', ')}`);
  } catch (err) {
    console.error('[ALERTS] sweep failed:', err.sqlMessage || err.message);
  }
}

if (ALERTS_ENABLED && require.main === module) {
  const alerts = setInterval(sweepAlerts, 60 * 60 * 1000);
  alerts.unref();
  sweepAlerts();
}

/**
 * The Tally outbox.
 *
 * Section 14 asks for "real-time bidirectional synchronisation". In practice
 * that means: a document is in Tally within seconds of the business fact, and a
 * salesman's request never waits on an accounting package that may be closed.
 *
 * So the push is a short timer over a durable queue rather than an inline HTTP
 * call. utils/tallySync.js swallows its own errors — a closed Tally must not
 * take the API down overnight — and backs off, so an office machine switched
 * off at 8 p.m. is retried on a widening interval rather than 3,600 times
 * before morning.
 *
 * The masters (7,000 parties, 7,300 items) are NOT on this timer. They are
 * pulled by `npm run tally -- --pull --watch` or on demand from
 * POST /api/tally/pull, because nothing about a party master changes minute to
 * minute and the export is large.
 */
async function sweepTally() {
  try {
    const out = await tallyCycle(pool, { pullMasters: false });
    const p = out.push;
    if (p && (p.sent || p.failed)) {
      console.log(`[TALLY] pushed ${p.sent}, failed ${p.failed}`);
    }
  } catch (err) {
    console.error('[TALLY] push sweep failed:', err.sqlMessage || err.message);
  }
}

if (TALLY_ENABLED && require.main === module) {
  const tally = setInterval(sweepTally, TALLY_INTERVAL_MS);
  tally.unref();
  sweepTally();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Verified before listening rather than at first login, so a missing secret is
// a startup failure instead of a 500 in front of a user weeks later.
if (!process.env.JWT_SECRET) {
  console.warn('[API] JWT_SECRET is not set — auth routes will not work. See .env.example.');
}

// Said once, at startup, rather than discovered during an incident. Neither is
// fatal in development; both are wrong in production.
if (CORS_ORIGIN === '*') {
  console.warn('[API] CORS_ORIGIN is not set — every origin is accepted. Set it before deploying.');
}
if ((process.env.DB_USER || 'root') === 'root') {
  console.warn('[API] connecting to MySQL as root. Create a least-privilege user before deploying (see README).');
}

// Only when run as a program. `require('./server')` — from a test, a script or
// a REPL — used to bind port 5000 as a side effect of the import.
const server = require.main === module
  ? app.listen(PORT, () => {
      console.log(`[API] listening on http://localhost:${PORT}`);
      console.log(`[API] health: /health  |  readiness: /health/db`);
    })
  : null;

// Drain in-flight requests, then release the MySQL pool. Without this, nodemon
// or node --watch restarts leak pooled connections until MySQL refuses new ones.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[API] ${signal} received — shutting down.`);

  const force = setTimeout(() => {
    console.error('[API] did not close in 10s, forcing exit.');
    process.exit(1);
  }, 10_000);
  force.unref();

  if (!server) {
    await pool.end().catch(() => {});
    return;
  }

  server.close(async () => {
    await pool.end().catch(() => {});
    console.log('[API] closed.');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
