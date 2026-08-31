# KL Electricals

Field-sales and employee-tracking app. Employees check in once per day with a GPS fix, are tracked in the background while checked in, visit customers, and write orders against an item master.

- **Root** — Expo 51 / React Native 0.74 app (iOS, Android, web)
- **`backend/`** — Node ≥18 data layer (MySQL 8, `mysql2`, `bcryptjs`)

> **Status:** in progress. Sign-in, attendance (check-in, lunch, check-out, the
> daily and monthly sheets, holidays), live tracking, employees and permissions,
> and customers all work end to end. The item master and order-taking screens
> are placeholders — their APIs are written and tested, the screens are not. See [CLAUDE.md](CLAUDE.md) for the invariants that span files.

## Requirements

- Node.js ≥ 18
- MySQL 8 running on `localhost:3306`
- An Expo Go client, an emulator, or a browser for the web target

## Setup

### The short way

Start MySQL, then from the project root:

```bash
npm install
npm run dev
```

`npm install` installs both halves (a `postinstall` hook runs the backend's
install). `npm run dev` then runs `scripts/setup.js`, which is idempotent and
does whatever is still outstanding — writes `backend/.env` with a generated
`JWT_SECRET`, creates the database and its tables, seeds the staff accounts and
an admin, imports the rate card, seeds the incentive segments — and then runs
the API and Expo together in one terminal with `[api]` / `[app]` prefixes.
Ctrl+C stops both.

It stops with a named fix rather than a stack trace when something is missing;
"MySQL is not running" is the usual one. `npm run setup` does the preparation
without starting anything.

The seeded accounts get one shared development password, printed on completion,
and are deliberately *not* flagged `must_change_password` — see the note in
`scripts/setup.js` and **Before deploying** below.

### The long way, one step at a time

Worth reading to know what the above is doing, and needed if you want a
different admin id or your own password.

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Notes |
|---|---|
| `DB_HOST` `DB_PORT` `DB_USER` `DB_PASSWORD` `DB_NAME` | MySQL connection |
| `JWT_SECRET` | generate a fresh one, see below |
| `PORT` | API port (5000) |
| `CORS_ORIGIN` | comma-separated allowed origins. Unset means every origin — development only |
| `LOCATION_RETENTION_DAYS` | how long GPS pings are kept (default 90) |
| `BUSINESS_TIMEZONE` | IANA name; decides which calendar day a check-in belongs to (default `Asia/Kolkata`) |
| `AUTO_CHECKOUT_TIME` | `HH:MM` in `BUSINESS_TIMEZONE` that a forgotten shift is closed at (default `19:00`) |
| `AUTO_CHECKOUT_ENABLED` | `false` to leave the sweep to `npm run auto-checkout` |

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Create the database and tables, either way round:

```bash
npm run init-db                  # through Node, using your .env
mysql -u root -p < init.sql      # plain SQL, no Node involved
```

Both produce the same database: nine tables plus `schema_migrations`, with the
existing migrations recorded as already applied so `npm run migrate` afterwards
reports "up to date". Both are safe to re-run and **insert no rows** — there is
no default user and no seed data.

`init.sql` is the one to hand to somebody who just wants to run SQL — open it in
MySQL Workbench, or pipe it in from PowerShell with `Get-Content init.sql | mysql -u root -p`.
It carries its own `CREATE DATABASE`, so it needs nothing else. It is
**generated from `schema.sql`** by `npm run build-init-sql` (and by `init-db` as
it runs), so the two cannot describe different databases — change `schema.sql`,
not `init.sql`.

Create the first admin:

```bash
npm run create-admin -- --id ADMIN001 --name "Your Name" \
  --email you@example.com --password "choose-a-strong-one"
```

The password is bcrypt-hashed and is not recoverable — store it somewhere safe. `--phone` is optional.

Run the API:

```bash
npm run dev      # restarts on file change
npm start        # no watcher
```

It listens on `PORT` (5000). Check it:

```bash
curl localhost:5000/health       # process is alive
curl localhost:5000/health/db    # can reach MySQL; 503 if not
```

### API

Every route below `/api` needs a Bearer token. Beyond that, each one names the
grant it requires — guards are per action, not per router.

| Route | Grant | Purpose |
|---|---|---|
| `GET /health` `GET /health/db` | — | liveness; MySQL readiness (503 if not) |
| `POST /api/auth/login` | — | `{ id, password }` → `{ token, user }` |
| `GET /api/auth/me` | — | current user; validates a stored token |
| `PATCH /api/auth/change-password` | — | own password |
| `GET /api/attendance/today`, `POST .../checkin`, `/checkout`, `/lunch-out`, `/lunch-in` | — | the caller's own shift |
| `GET /api/attendance/daily`, `/monthly-summary`, `/employee/:id/monthly`, `/holidays` | `attendance.view` | other people's records |
| `POST /api/attendance/holidays` | `attendance.create` | add a holiday |
| `DELETE /api/attendance/holidays/:id` | `attendance.delete` | retire a holiday |
| `GET /api/location/live`, `/user/:id/history`, `/user/:id/checkin` | `live_tracking.view` | the map and the trail |
| `POST /api/location/log` | — | a ping, accepted only during an open shift |
| `GET /api/users/employees` | `employees.view` | the directory |
| `POST /api/users` | `employees.create` | add an employee |
| `PUT /api/users/:id`, `PATCH /api/users/:id/status` | `employees.edit` | edit, activate/deactivate |
| `PATCH /api/users/:id/permissions` | `employees.permissions` | grants, and `role` |
| `DELETE /api/users/:id` | `employees.delete` | remove one account |
| `GET /api/items`, `/api/items/:id` | `items.view` | catalogue |
| `POST /api/items` | `items.create` | new item, with opening stock |
| `PUT /api/items/:id`, `POST /api/items/:id/stock` | `items.edit` | partial update; ledger movement |
| `GET /api/customers`, `/api/customers/:id` | `customers.view` | directory |
| `POST /api/customers` | `customers.create` | onboarding |
| `PUT /api/customers/:id` | `customers.edit` | partial update |
| `GET /api/orders`, `/api/orders/:id` | `orders.view` | own orders; the `orders` **area** grant widens it to everyone's |
| `POST /api/orders` | `orders.create` | order, or a no-order visit |
| `PUT /api/orders/:id/status` | `orders.edit` | status; cancelling returns the stock |
| `GET /api/reports/dashboard` | — | own figures; the `orders` **area** grant widens to company-wide |

There is deliberately **no bulk-delete route** for employees: `checkins` and
`location_logs` cascade from `users`, so one would destroy the attendance
history. Offboarding is `PATCH /:id/status`.

### 2. App

```bash
cd ..
npm install
npm run dev
```

Then press `w` for web, or scan the QR code with Expo Go.

Native builds need a prebuild first — `android/` and `ios/` are generated and gitignored:

```bash
npx expo prebuild
npm run android    # or: npm run ios
```

## Database

Nine tables. `users` and `customers` and `items` are the masters; `orders` and `order_items` record sales; `checkins` and `location_logs` and `holidays` cover attendance and tracking; `stock_movements` is the stock ledger.

Two things about the design are worth knowing before you query it:

- **Attendance is derived, not stored.** One `checkins` row per employee per day; a missing row *is* the absence. Attendance is `checkins` measured against the working calendar with `holidays` removed.
- **`items.qty` is a cached value.** The truth is `stock_movements`, an append-only ledger of signed quantity changes. Corrections are new rows, never edits.

`schema.sql` documents the reasoning per table. Column conventions and the rest of the invariants are in [CLAUDE.md](CLAUDE.md).

### Migrations

`init-db` is for fresh databases; migrations bring an existing one forward. Both
must leave the same result, so a change to `schema.sql` needs a matching
migration.

```bash
npm run migrate -- --status    # what is applied, what is pending
npm run migrate                # apply everything outstanding
```

Applied files are recorded in `schema_migrations`, so a migration runs once and
re-running the command is a no-op. Migrations are non-destructive — no table is
dropped and no row is deleted.

A database created **fresh** from `schema.sql` already contains everything the
migrations do, and running them would fail on columns that are already there.
Mark those as applied instead:

```bash
npm run migrate -- --mark 001_constraints_datetime_stock.sql
npm run migrate -- --mark 002_lunch_autocheckout_noorder.sql
```

### Forgotten check-outs

A shift nobody checks out of would otherwise stay open forever: the employee
shows as permanently Active on the map, and the day has no length. The server
sweeps hourly and closes any shift from a *previous* service day at
`AUTO_CHECKOUT_TIME`, flagging it `is_auto_checkout`. Today is never touched.

```bash
npm run auto-checkout -- --dry-run   # list what would be closed
npm run auto-checkout                # close them now
```

### Location retention

`location_logs` is the only table that grows without bound: roughly 50 rows per employee per working day. Nothing removes them automatically.

```bash
npm run purge-locations -- --dry-run     # report only
npm run purge-locations                  # delete beyond LOCATION_RETENTION_DAYS
npm run purge-locations -- --days 180    # override the window
```

Schedule this (Task Scheduler on Windows, cron elsewhere). Deletion is irreversible, and these rows are the only record of where an employee was — which may matter for payroll or a dispute. Choose the retention window deliberately.

## Assets

App icons in `assets/` are generated from a source logo rather than hand-made: a full-bleed square for `icon.png`, and `adaptive-icon.png` with the mark inside Android's ~66% safe zone. The current set uses the ABS logo, the only asset available — regenerate them once a KL Electricals mark exists.

## Before deploying

**Do this one first, and do not skip it.**

- **Retire the seeded passwords.** `seed-roles` and `seed-business` used to
  create every staff account with one shared password that was a literal in
  both scripts — so it is in the repository, and it is not a secret. The
  literal is gone, but any database seeded before 31 August 2026 still has
  accounts using it. Find them and mark them:

  ```bash
  cd backend
  npm run secure-accounts -- --dry-run   # who is still on a handed-over password
  npm run secure-accounts                # mark them
  ```

  A marked account can sign in, read `/auth/me`, and change its password.
  Every other request is refused with `403 PASSWORD_CHANGE_REQUIRED` until it
  does — enforced in `authenticate`, so no route can miss it. The app puts
  those users straight on the change-password screen.

  On the database as it stands this affects **22 active accounts**, including
  `yash`, who holds `all`. Expect every member of staff to be asked to choose a
  password the first time they open the app after deployment; tell them so
  beforehand, because otherwise it reads as the app being broken.

  New accounts need nothing: a generated password is issued per account and
  printed once, and both the seed scripts and `POST /api/users` mark it as
  needing replacement.

Three more things are correct for a development LAN and wrong anywhere else.
The server warns about the first two at startup.

- **MySQL runs as `root`.** Create a least-privilege user and use it for the
  app, keeping an admin credential for schema work only:

  ```sql
  CREATE USER 'kl_app'@'localhost' IDENTIFIED BY '<strong-random>';
  GRANT SELECT, INSERT, UPDATE, DELETE ON kl_electricals.* TO 'kl_app'@'localhost';
  -- deliberately NOT granted: DROP, ALTER, CREATE, GRANT, FILE
  ```

- **`CORS_ORIGIN` is unset**, so every origin is accepted. Set the explicit list.
- **The connection to MySQL is not encrypted**, and the API itself is HTTP. Put
  it behind TLS.

Also required before a Play Store release: the prominent-disclosure screen
Google's policy requires before requesting background location.

## Not yet built

- The item master and order-taking **screens**. Both APIs are written and
  verified — `POST /api/orders` prices lines from the item master, moves stock
  through the ledger, and returns it on cancellation — but the screens are
  placeholders.
- Payments and invoicing. `customers.closing_balance` and `credit_limit` exist
  and are reported on, but nothing writes to them yet.
- Attendance export for payroll.
- Any test suite or lint configuration.
