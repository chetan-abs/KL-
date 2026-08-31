#!/usr/bin/env node
/**
 * Every server endpoint is either bound by the client or explicitly excused.
 *
 *   node tests/api-coverage-test.js
 *
 * The gap this catches is one nobody notices until a screen is being built: a
 * route exists, is guarded, is tested — and `services/endpoints.js` has no way
 * to call it, so the screen author writes a second axios call by hand and the
 * one-place-per-route rule quietly dies.
 *
 * It ran at 71 bindings against 194 endpoints after four passes of backend
 * work, which is what prompted writing it down as a check rather than a
 * one-off count.
 *
 * Needs no server and no database — it reads both source trees.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ROUTES = path.join(__dirname, '..', 'routes');
const CLIENT = path.join(ROOT, 'services', 'endpoints.js');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return; }
  fail += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * Endpoints the client is not expected to call, each with a reason.
 *
 * A list of excuses is only useful if every entry says WHY, otherwise it
 * becomes the place unbound routes go to be forgotten.
 */
const EXCUSED = [
  // Served to the browser directly, not through the axios client.
  ['GET', '/attachments/:name', 'A photo URL, opened by an <Image> not fetched.'],
  ['GET', '/tally/queue/:id/payload', 'Raw XML for curl; bound as payloadUrl().'],
  ['GET', '/documents/invoice/:id.pdf', 'Bound as a URL — printing is the browser\'s job.'],
  ['GET', '/documents/estimate/:id.pdf', 'Bound as a URL.'],
  ['GET', '/documents/salary-slip/:employeeId/:period.pdf', 'Bound as a URL.'],

  // Auth is handled by AuthContext, not by the endpoints module.
  ['POST', '/auth/login', 'AuthContext owns the token, not endpoints.js.'],
  ['POST', '/auth/logout', 'AuthContext.'],
  ['GET', '/auth/me', 'AuthContext.'],
  ['PATCH', '/auth/change-password', 'AuthContext owns the session, including a password change.'],

  // Background tracking talks to the API directly from the task, which runs
  // outside the React tree and cannot import a module that touches state.
  ['POST', '/location/log', 'The background task posts this itself.'],

  // Reports.exportUrl is one builder over the whole family — the twelve reports
  // are each bound individually above it, and this is how a CSV or PDF download
  // is reached for any of them.
  ['GET', '/reportsuite/:key', 'Generic export builder over routes bound individually.'],
];

const isExcused = (method, route) => EXCUSED.some(
  ([m, r]) => m === method && r === route);

function serverEndpoints() {
  const out = [];
  for (const file of fs.readdirSync(ROUTES).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROUTES, file), 'utf8');
    const mount = `/${file.replace(/\.js$/, '')}`;
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g)) {
      out.push({
        method: m[1].toUpperCase(),
        // The mount path is the filename for most modules; the handful that
        // differ are normalised below.
        file,
        path: m[2],
        mount,
      });
    }
  }
  return out;
}

/** Route file to the path it is mounted at in server.js. */
function mountMap() {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const map = {};
  for (const m of server.matchAll(/app\.use\('([^']+)',\s*require\('\.\/routes\/([^']+)'\)\)/g)) {
    map[`${m[2]}.js`] = m[1].replace(/^\/api/, '');
  }
  return map;
}

function clientCalls() {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const calls = [];
  for (const m of src.matchAll(/api\.(get|post|put|patch|delete)\(\s*[`'"]([^`'"]*)/g)) {
    calls.push({ method: m[1].toUpperCase(), path: m[2] });
  }
  // URL builders are bindings too — they are how a PDF or an image is reached.
  // The path runs to the end of the template literal, and it contains ${...}
  // interpolations, so it cannot stop at the first non-path character the way a
  // simple character class would.
  for (const m of src.matchAll(/baseURL\}([^`]*)`/g)) {
    calls.push({ method: 'GET', path: m[1] });
  }
  return calls;
}

/** `/orders/${id}/x` and `/orders/:id/x` are the same route. */
const shape = (p) => p
  // A query string is not part of the route. `exportUrl` builds
  // `/reportsuite/${key}?${query}`, and the `?...` is arguments, not a path.
  .replace(/\?.*$/, '')
  .replace(/\$\{[^}]*\}/g, ':p')
  .replace(/:[A-Za-z0-9_.]+/g, ':p')
  .replace(/\/+$/, '') || '/';

function main() {
  const mounts = mountMap();
  const endpoints = serverEndpoints().map((e) => ({
    ...e,
    full: `${mounts[e.file] ?? e.mount}${e.path}`.replace(/\/+$/, '') || '/',
  }));

  const bound = new Set(clientCalls().map((c) => `${c.method} ${shape(c.path)}`));

  const missing = [];
  for (const e of endpoints) {
    const key = `${e.method} ${shape(e.full)}`;
    if (bound.has(key)) continue;
    if (isExcused(e.method, e.full)) continue;
    missing.push(`${e.method} ${e.full}  (${e.file})`);
  }

  console.log(`\n  ${endpoints.length} server endpoints, ${bound.size} distinct client bindings\n`);

  ok('every server endpoint is bound or excused', missing.length === 0,
    missing.length ? `${missing.length} unbound` : '');
  if (missing.length) {
    console.log('\n  unbound:');
    missing.forEach((m) => console.log(`    · ${m}`));
    console.log('\n  Add each to services/endpoints.js, or to EXCUSED here with a reason.');
  }

  // The reverse: a binding pointing at a route that no longer exists is a
  // screen that will 404 at runtime and nowhere else.
  const serverKeys = new Set(endpoints.map((e) => `${e.method} ${shape(e.full)}`));
  const dangling = [...bound].filter((b) => {
    if (serverKeys.has(b)) return false;
    const [method, p] = b.split(' ');
    return !isExcused(method, p) && !EXCUSED.some(([, r]) => shape(r) === p);
  });

  ok('no client binding points at a route that does not exist',
    dangling.length === 0, dangling.join(', '));

  ok('every excused endpoint gives a reason',
    EXCUSED.every((e) => typeof e[2] === 'string' && e[2].length > 10));
}

main();
console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log('\nfailures:');
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
