# Code Review — 11 August 2026

Full-codebase audit of KL Electricals: security, bugs, conflicts, cleanup, and gaps worth filling. Covers the Expo app at the repo root and the Node backend in `backend/`.

> **Status: open. Nothing in this document has been implemented.**
> This is a report, not a changelog. No finding below was fixed as part of producing it, and none should be fixed without the user asking. See *Regular review* in `CLAUDE.md`.

**Scope note.** The API has a skeleton (`server.js`) but no business routes and no auth. Most security findings below are therefore *latent* — they describe what will be exploitable once routes exist, not what is exploitable today. That is the cheapest possible moment to fix them, which is why they are here.

Every claim marked **verified** was tested against the running system, not inferred from reading. Two hypotheses were tested and **rejected**; they are recorded at the end so nobody re-raises them.

---

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| S1 | High | Security | App connects to MySQL as `root` |
| S2 | High | Security | `--password` is persisted to shell history |
| B1 | High | Bug | Importing `server.js` binds port 5000 |
| S3 | Medium | Security | Production error guard never engages |
| S4 | Medium | Security | `/health/db` leaks raw MySQL errors to anonymous callers |
| S5 | Medium | Security | CORS defaults to `*` |
| S6 | Medium | Security | No rate limiting on the auth path to come |
| S11 | Medium | Compliance | Background location without prominent disclosure |
| B2 | Medium | Bug | `arg()` accepts the next flag as a value |
| B3 | Medium | Conflict | `server.js` reads two env vars absent from `.env.example` |
| B4 | Medium | Bug | Nothing enforces or reconciles the `items.qty` invariant |
| B5 | Medium | Conflict | `schema.sql` and `migrations/` can drift undetected |
| S7–S13 | Low | Security | Headers, identifier interpolation, bcrypt cost, TLS, password policy |
| B6–B11 | Low | Bug | Pool destroy path, exit paths, validation, dialog queue |
| C1–C8 | — | Cleanup | Dead tokens, dead deps, empty dirs, duplication |
| F1–F12 | — | Feature | Version control, migration runner, validation, tests, tooling |

---

## Security

### S1 — Application connects to MySQL as `root` — **High**

`backend/.env` sets `DB_USER=root`. Every connection from the pool, and therefore every future route, runs with full administrative rights over the entire server: `DROP DATABASE`, `GRANT`, reads of the `mysql` system schema, `FILE` privileges.

This converts *any* future SQL flaw from a scoped problem into total server compromise. It also means a bug in a `DELETE` has no backstop.

**Fix.** Create a least-privilege user and use it everywhere except `init-db`:

```sql
CREATE USER 'kl_app'@'localhost' IDENTIFIED BY '<strong-random>';
GRANT SELECT, INSERT, UPDATE, DELETE ON kl_electricals.* TO 'kl_app'@'localhost';
-- deliberately NOT granted: DROP, ALTER, CREATE, GRANT, FILE
FLUSH PRIVILEGES;
```

Keep a separate `root`-ish credential for schema work only, supplied out of band when running `init-db` or a migration.

---

### S2 — `--password` is persisted to shell history — **High**

`scripts/create-admin.js` takes the admin password as a command-line argument. Verified on this machine: **both** history files exist and are written to.

```
C:\Users\Admin\AppData\Roaming\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt   (4961 bytes)
C:\Users\Admin\.bash_history
```

The very first admin credential of the system is therefore sitting in a plaintext file that no backup excludes and no rotation touches. Command-line arguments are also generally visible to other processes in a process listing.

**Fix.** Read the password from a TTY prompt when stdin is interactive, keep the flag only for scripted use, and say so:

```js
// fall back to a prompt when --password is absent
const password = arg('password') || process.env.ADMIN_PASSWORD || await promptHidden('Password: ');
```

Whoever already ran it with `--password` should rotate that credential and scrub both history files.

---

### S3 — The production error guard never engages — **Medium** — *verified*

`server.js` withholds error detail only outside production:

```js
...(process.env.NODE_ENV === 'production' ? {} : { detail: err.message }),
```

`NODE_ENV` is **never set anywhere** — not in `.env`, not in `.env.example`, not in any npm script. Verified by grep across all four. The ternary therefore always takes the leaking branch, in every environment including a future deployment. The guard reads as protection while providing none.

**Fix.** Set `NODE_ENV` explicitly in the start script and document it in `.env.example`. Better, invert the default so the *safe* branch is what an unconfigured environment gets:

```js
...(process.env.NODE_ENV === 'development' ? { detail: err.message } : {}),
```

---

### S4 — `/health/db` discloses raw MySQL errors to anonymous callers — **Medium**

```js
res.status(503).json({ status:'error', db:'unreachable', message: err.sqlMessage || err.message });
```

The endpoint is unauthenticated. MySQL error strings routinely contain the database name, the connecting user and host (`Access denied for user 'root'@'localhost'`), and sometimes column or table names. An attacker learns the schema and the privilege level for free, which directly informs S1.

**Fix.** Log the detail server-side; return a fixed string to the caller. If a detailed readiness probe is wanted, gate it behind a shared secret or bind it to localhost.

---

### S5 — CORS defaults to `*` — **Medium**

`CORS_ORIGIN` defaults to `'*'`. This is a deliberate development convenience (the Expo client's origin varies per target) and is commented as such, but nothing forces it to be narrowed and the variable is undocumented (see B3).

Not exploitable while `credentials` is off and tokens live in `Authorization` headers, but it becomes a real hole the moment anyone adds cookie auth or `credentials: true`.

**Fix.** Document `CORS_ORIGIN`, and refuse to start with `*` when `NODE_ENV=production`.

---

### S6 — No rate limiting or brute-force protection — **Medium** *(latent)*

There is no `express-rate-limit`, no failed-login counter, and no lockout. `bcrypt` cost 10 slows an offline attack on a stolen hash but does nothing for online password guessing against `POST /api/auth/login`.

The employee ID space is small and guessable (`ADMIN001`), which makes credential stuffing cheap.

**Fix.** Add a global limiter plus a stricter per-account one on the login route, and count consecutive failures against `users`.

---

### S7 — No security headers — **Low**

`x-powered-by` is disabled, which is good. Nothing else is set: no `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, or HSTS. **Fix:** add `helmet`.

### S8 — Identifier interpolated into `CREATE DATABASE` — **Low**

`scripts/init-db.js` builds `` CREATE DATABASE IF NOT EXISTS `${dbName}` `` by string interpolation. Identifiers cannot be parameterized, so this is not trivially avoidable — but a `DB_NAME` containing a backtick would break out. The value comes from `.env` and is not attacker-controlled today. **Fix:** validate `DB_NAME` against `/^[A-Za-z0-9_]+$/` before use.

### S9 — bcrypt cost factor 10 — **Low**

`create-admin.js` hashes at cost 10. For a system whose admin account grants `["all"]`, 12 is the better default and costs a few hundred milliseconds once.

### S10 — No TLS to MySQL — **Low**

The pool has no `ssl` option. Irrelevant on `localhost`; a plaintext credential and every row on the wire the moment the database moves to another host. **Fix:** add `ssl` config before any non-local deployment.

### S11 — Background location without prominent disclosure — **Medium** *(compliance)*

`app.json` requests `ACCESS_BACKGROUND_LOCATION` and `UIBackgroundModes: ["location"]`, and the schema is built for 10-minute pings. Google Play requires a **prominent in-app disclosure** shown *before* the permission request, explaining that location is collected in the background and why — a store listing entry or an OS permission dialog is not sufficient. Apple requires equivalent justification.

There is no such screen; there is no UI at all yet. Play Store rejection is the likely outcome if this ships as-is.

**Fix.** Build the disclosure screen as part of the check-in flow, before the first permission prompt. Also decide and document the employee-facing privacy notice — this is tracking of identified individuals and is regulated as personal data.

### S12 — Password policy is length-only — **Low**

`password.length < 8` is the entire rule. No breach-list check, no complexity, no maximum. **Fix:** raise the floor to 12 and consider a k-anonymity check against Have I Been Pwned at admin-creation time.

### S13 — Credential handling — **Informational**

`backend/.env` holds a real MySQL password and a real `JWT_SECRET`. Both `.gitignore` files cover `.env`, and the root pattern (no slash) also matches `backend/.env`. This is correct. Note that the repo is not under version control at all (F1), so there is no history to leak from yet — which makes now the moment to initialise git *with* those ignores already in place.

---

## Bugs and conflicts

### B1 — Importing `server.js` starts the server — **High** — *verified*

```
require('./server.js')  ->  binds port 5000  (EADDRINUSE on a second bind)
```

`server.js` ends with `module.exports = app`, which advertises it as importable — but `app.listen()` runs unconditionally at module scope. Any test file, tooling, or script that imports the app to inspect routes will bind the port and hang, and a second import fails with an opaque `EADDRINUSE`.

This also **contradicts the pattern already established in this codebase**: `scripts/init-db.js` guards its side effect precisely so `splitStatements` can be imported safely.

**Fix.** Apply the same guard:

```js
if (require.main === module) {
  const server = app.listen(PORT, ...);
  // ...signal handlers...
}
module.exports = app;
```

### B2 — `arg()` accepts the following flag as a value — **Medium**

`scripts/create-admin.js`:

```js
const i = process.argv.indexOf(`--${flag}`);
return i !== -1 ? process.argv[i + 1] : undefined;
```

`--name --email a@b.com` silently yields `name === "--email"`, and the required-argument check passes because the value is truthy. An admin is created with a nonsense name and no error.

**Fix.** Reject a value that starts with `--`, and treat a missing value as missing.

### B3 — `server.js` reads env vars that `.env.example` never mentions — **Medium** — *verified*

Diffing what the backend reads against what it documents:

```
read by code but NOT in .env.example:  CORS_ORIGIN  NODE_ENV
                                       ADMIN_ID ADMIN_NAME ADMIN_EMAIL ADMIN_PHONE ADMIN_PASSWORD
in .env.example but never read:        (none)
```

`CORS_ORIGIN` and `NODE_ENV` are the ones that matter — they change security behaviour (S3, S5) and nobody copying `.env.example` will know they exist. The `ADMIN_*` set is a documented alternative to the CLI flags in `create-admin.js`'s header comment, so it is a lesser omission.

**Fix.** Add all seven, with comments.

### B4 — Nothing enforces or reconciles the `items.qty` invariant — **Medium**

The design is sound: `stock_movements` is the ledger, `items.qty` is a cache of `SUM(change_qty)`, and the recompute query is documented in `schema.sql`. But no trigger, constraint, or job enforces it, and no route writes either table yet.

The first handler that forgets to write a movement row, or writes one outside the transaction, silently desynchronises stock with no alarm. The recompute query exists but nothing runs it.

**Fix.** Ship a `scripts/verify-stock.js` that reports drift (and `--fix` to recompute), modelled on `purge-locations.js`. Run it in CI or on a schedule. When routes are written, put the movement insert and the `items.qty` update in the same transaction, always.

### B5 — `schema.sql` and `migrations/` can drift undetected — **Medium**

Two hand-maintained sources of truth: `init-db.js` applies `schema.sql` to fresh databases, migrations bring existing ones forward. Nothing checks that they converge. A change made to one and forgotten in the other produces two different production schemas, and the failure only appears on the next fresh install — long after the change.

**Fix.** See F2. Short term, add a CI step that runs `init-db` on an empty database, applies all migrations to a *pre-migration* database, and diffs `SHOW CREATE TABLE` output for every table.

### B6 — Destroying a connection on time-zone failure can surface opaquely — **Low**

`config/db.js` destroys a pooled connection when `SET time_zone` fails. This is the right trade — shifted timestamps are worse than an error — but the request that was waiting for that connection receives a low-level socket error rather than an explanation, and a permanently misconfigured server will churn connections silently apart from the log line.

**Fix.** Count consecutive failures and fail fast with a clear message once a small threshold is crossed.

### B7 — Early exits skip `pool.end()` — **Low**

`create-admin.js` calls `pool.end()` before exiting on `ER_DUP_ENTRY`, but the earlier validation exits (missing argument, short password) call `process.exit(1)` directly while the pool from `require('../config/db')` is already open. Harmless in practice because `process.exit` is immediate, but it is inconsistent with the path below it.

### B8 — No input validation before the insert — **Low**

`create-admin.js` does not check that `id` fits `VARCHAR(20)` or that `email` looks like an address. Over-long input surfaces as a raw `ER_DATA_TOO_LONG`, and a typo'd email is accepted permanently (and is now `UNIQUE`, so the mistake blocks the correct value).

### B9 — `AlertHost` has no dialog queue — **Low**

`services/confirm.js` holds a single listener and `AlertHost` a single `dialog` state. A second `showAlert()` while one is open replaces it — the first message is lost, and if it was a `confirmAction`, its callback never runs and never rejects. Realistic when an interceptor fires an error alert during an open confirmation.

### B10 — `AppText` falls back silently on an unknown prop — **Low**

`TYPOGRAPHY.fontFamily[weight]` yields `undefined` for a typo'd weight, and React Native silently uses the system font. The text renders in the wrong typeface with no warning. A `__DEV__` warning would catch it at the point of the mistake.

### B11 — Metro blockList pattern is broader than it reads — **Informational**

`/index-[a-f0-9]+\.js$/` is not anchored to a directory, so it blocks a file of that name anywhere in the tree, not just generated web output. Low risk given the naming, worth knowing.

---

## Cleanup

**C1 — Gradient tokens with no gradient library.** `constants/colors.js` exports `gradientRed` and `gradientYellow` as colour-stop arrays. Neither `expo-linear-gradient` nor `react-native-linear-gradient` is installed — verified. These cannot render. Either add the dependency or drop the tokens.

**C2 — Colour tokens for an explicitly dropped feature.** `colors.js` defines `pending` / `visited` / `skipped` under "Derived logic colors". Visited/skipped is the beat-visit workflow, which `schema.sql` explicitly puts out of scope ("No beat_id: beats are out of scope"). The palette and the schema disagree about what this product does. Remove them, or write down that beats are coming back.

**C3 — Duplicated base size.** `typography.js` defines `baseSize: 18` and `size.base: 18`. Two places to change one value. Derive one from the other.

**C4 — Genuinely unused dependencies.** `react-native-webview` and `@react-native-community/datetimepicker` are imported nowhere and are not required implicitly by the toolchain. Remove until needed.

> Distinguish these from the many dependencies that *look* unused but are not: `react-dom`, `react-native-web` and `@expo/metro-runtime` are pulled in by the web bundler, `react-native-screens` and `react-native-reanimated` by React Navigation, and `expo-asset` by the asset pipeline. Do not prune those by grep.

**C5 — Empty placeholder directories.** `context/`, `navigation/` and `screens/` contain no files. Harmless, but they will not survive a git checkout (git does not track empty directories), so they give a false impression of structure.

**C6 — Two `.gitignore` files.** The root one already covers `backend/.env` — a pattern without a slash matches at any depth. `backend/.gitignore` is redundant. Keeping it is defensible if the backend may be split out later; otherwise consolidate.

**C7 — `expo-updates` installed but disabled.** `updates.enabled: false` and no EAS project. Either configure it (`eas update:configure`) or drop the dependency.

**C8 — `ADMIN_*` fallbacks are undocumented.** See B3.

---

## Good to have

**F1 — Put the project under version control. Highest value item on this list.** There is no git repository. Every file — the schema, the migration, the server, both documents — exists in exactly one mutable copy with no history and no way to see what changed or revert it. Both `.gitignore` files are already correct, so initialising now starts clean with `.env` excluded from the first commit.

**F2 — A real migration runner.** Add a `schema_migrations` table recording applied filenames, and a `npm run migrate` that applies pending files in order inside a transaction. Removes the manual `mysql < file` step and makes B5 detectable.

**F3 — `scripts/verify-stock.js`.** Reports and optionally repairs `items.qty` drift. See B4.

**F4 — Request logging.** `pino-http` or `morgan`, with a request ID propagated into error logs. Currently a 500 leaves a stack trace with no way to tie it to the request that caused it.

**F5 — An input validation layer.** `zod` schemas at the route boundary, so handlers receive typed, validated input and rejections are consistent 400s rather than MySQL errors (B8).

**F6 — `helmet` and `express-rate-limit`.** See S6, S7.

**F7 — Tests and linting.** Neither exists. The parsing in `splitStatements`, the normalization in `utils/search.js`, and the stock invariant are all pure logic with clear inputs and outputs — cheap to test and the exact places a silent regression would hurt. Add ESLint and Prettier at the same time.

**F8 — API conventions, decided before the first route.** Version prefix (`/api/v1`), a pagination shape for list endpoints, and a single error envelope. Retrofitting these across a finished API is the expensive path.

**F9 — Docker Compose for MySQL.** Removes "install MySQL 8 and configure it" from setup and pins the version everyone develops against.

**F10 — An audit log table.** Orders and stock adjustments are financial records. Who changed what, when, is worth recording as data rather than inferring from `created_by`.

**F11 — Index on `checkins.checkin_date`.** The unique key `(employee_id, checkin_date)` cannot serve a query filtering on date alone — "everyone's attendance for today" is the most obvious admin screen there is.

**F12 — Secret management for deployment.** `.env` on disk is fine for local work. Anything deployed wants a secret manager, plus rotation for `JWT_SECRET` (which invalidates all sessions — design the token lifetime with that in mind).

---

## Tested and rejected

Recorded so they are not raised again.

**Keep-alive connections do not delay graceful shutdown.** The hypothesis was that `server.close()` ignores idle keep-alive sockets, making `shutdown()` wait for the 10-second force timer. Tested by holding an idle keep-alive socket open against the running server and triggering `SIGTERM`:

```
[API] SIGTERM received — shutting down.
[API] closed.
SHUTDOWN_TOOK_MS=3
```

Node 24 closes them. Worth noting that `engines` allows `node >=18`, where behaviour differed; an explicit `server.closeIdleConnections()` would make this version-independent, but there is no bug to fix on the current runtime.

**No SQL injection in data queries.** Every query in `config/db.js`, `create-admin.js` and `purge-locations.js` uses bound parameters, including the `LIMIT ?` in the purge batch loop. The single interpolation is the `CREATE DATABASE` identifier (S8), which cannot be parameterized.

---

## Suggested order

1. **F1** — initialise git before touching anything else, so the rest is reviewable.
2. **B1**, **B3**, **S3** — small, isolated, and each one makes later work safer.
3. **S1**, **S2** — credential hygiene, before more of the system depends on `root`.
4. **S4**, **S5**, **S6**, **S7** — do these *with* the first routes, not after.
5. **S11** — before any store submission; it may need design input.
6. **B4**, **B5**, **F2**, **F3** — data integrity, before real orders exist.
7. Cleanup and the rest.
