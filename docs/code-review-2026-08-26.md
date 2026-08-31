# Code Review — 26 August 2026

Full-codebase audit of KL Electricals, requested as: *"check all the flow and process of each and every tab, that they all work properly; attendance and tracking work properly against the users; deep analysis of the whole code and functionality of the tabs on both the user and admin panel."*

> **Status: implemented, 26 August 2026.** The report below is left exactly as it
> was written — the sequence of reviews is the record of what was found and when,
> so nothing here has been edited to match the fixes.
>
> Everything in Security, Conflicting code, Bugs and Cleanup was resolved at the
> user's explicit instruction, along with the features inseparable from those
> fixes (F4 auto-checkout, F5 permission model, F6 timezone contract, F7 removing
> the mock, F9 stock reversal, F10 change-password, F12 the migration runner),
> and F1 — the project is now a git repository, with a baseline commit taken
> before any change.
>
> **Deliberately not done**, by the user's decision: F2, building the Orders and
> New Order screens, and F3's item-master screen. Those tabs are now honest
> placeholders rather than shells that look finished. Three items from the
> 11 August review are deployment actions rather than code — the MySQL `root`
> user, TLS, and setting `CORS_ORIGIN` — and are written up under *Before
> deploying* in README; the server warns about two of them at startup.
>
> Verified after the fact against a running server and a throwaway database:
> every permission gap closed (a zero-grant account now gets 403 from all of
> them), order lines priced from the item master rather than the request body,
> stock returned on cancellation and taken again on reinstatement, MTD sales no
> longer multiplied by line count, GPS pings refused outside an open shift, the
> two shifts that had been open since 13 August closed and flagged
> `is_auto_checkout`.

**Scope change since the last review.** The 11 August review was written against a repo where only auth existed. That is no longer true: there are now 8 route modules and 14 screens. The security findings that were *latent* then are **live now**, and several were verified against the running system during this audit.

**How claims were verified.** The API was running on `localhost:5000` with MySQL reachable (`/health/db` → `sessionTimeZone: "+00:00"`). Findings marked **verified** were tested against it — live rows read read-only through the project's own pool, and HTTP calls made with a locally minted employee token. Nothing was written to the database. Three hypotheses were tested and **rejected**; they are recorded at the end so nobody re-raises them.

**`CLAUDE.md` is materially out of date** and should not be used as a map of the system (see K1). The per-tab table below is the current picture.

---

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| **S1** | **Critical** | Security | Mock-API fallback in `services/api.js` = complete authentication bypass |
| **S2** | **High** | Security | `/api/reports/*`, `/api/orders`, `/api/customers`, `/api/items` enforce no permissions — *verified* |
| **S3** | **High** | Security | `DELETE /api/users/employees/all` wipes every employee and cascades attendance + GPS history |
| **S4** | **High** | Security | New employees silently get the password `password123` |
| **B1** | **High** | Bug | Every displayed timestamp is wrong by the local UTC offset — *verified* |
| **B2** | **High** | Bug | Background GPS tracking logs nothing — *verified* |
| **B3** | **High** | Bug | No auto-checkout: shifts stay open forever — *verified* |
| **B4** | **High** | Bug | After checking out, the app is unusable until the UTC date rolls over |
| S5 | Medium | Security | Order prices, names and GST come from the client, not the item master |
| S6 | Medium | Security | `employees.edit` can change `role`, which the UI treats as authority |
| S7 | Medium | Security | Rate limiting exists only on login; `/location/log` is unbounded |
| S8 | Medium | Privacy | Employee GPS is sent to `nominatim.openstreetmap.org` on every check-in |
| S9 | Medium | Security | `seed-data.js` hardcodes `admin123` / `123456` for a live-looking admin |
| S10 | Low | Security | Employee names are injected unescaped into the Leaflet WebView |
| B5 | High | Bug | GPS failure silently records the employee in **Mumbai** |
| B6 | Medium | Bug | Dashboard MTD sales is multiplied by the number of order lines |
| B7 | Medium | Bug | Cancelling an order never returns stock — breaks the ledger invariant |
| B8 | Medium | Bug | "No order" visits are stored as `cancelled`, indistinguishable from real cancellations |
| B9 | Medium | Bug | Monthly attendance counts Sunday/holiday check-ins as present days |
| B10 | Medium | Bug | `/attendance/daily` counts admins as absent; `/location/live` shows deactivated staff |
| B11 | Medium | Bug | Editing any employee resets their `role` to `employee` |
| B12 | Medium | Bug | `Alert.alert` is a no-op on web — delete confirmations never appear — *verified* |
| B13 | Medium | Bug | `PUT /items/:id` and `PUT /customers/:id` null out any omitted field |
| B14 | Low | Bug | `AppText size="2xl"` / `"3xl"` silently render at 18px |
| B15 | Low | Bug | Check-in writes two rows without a transaction |
| B16 | Low | Perf | `/reports/location-audit` defeats the index on the only unbounded table |
| K1–K12 | — | Conflict | Stale `CLAUDE.md`, Tally placeholders, revived beats, wrong-city defaults, schema/migration drift |
| C1–C10 | — | Cleanup | ~450 lines of mock API, 5 unreachable screens, 7.7 MB of build leftovers |
| F1–F12 | — | Feature | Version control, the entire order flow, auto-checkout, timezone contract |

---

## Part 1 — Tab-by-tab flow analysis

There is no separate user panel and admin panel. `MainAppContainer` renders one shell for everyone; the only difference is that the **User ▾** dropdown filters its entries through `userCan()`. Dashboard, Order and Master ▾ are shown to every signed-in account regardless of grants. A second, unused user panel (`navigation/UserNavigator.js` + `screens/UserHomeScreen.js`) exists in the tree but nothing imports it.

| Tab / flow | Screen | Talks to API | Works? |
|---|---|---|---|
| Check-in gate | `CheckinGateScreen` | `POST /attendance/checkin` | **Partly** — records the day, but fabricates Mumbai coordinates on GPS failure (B5) and has no exit if check-in is impossible (B4) |
| Dashboard | `HomeScreen` | `GET /reports/dashboard`, `/attendance/today` | **Partly** — MTD figure inflated (B6); stat numbers render at body size (B14); dead check-in card logic left behind (C4) |
| Order | `OrdersScreen` | **none** | **No** — hardcoded "No pending orders"; the three tabs do nothing |
| New Order | `NewOrderScreen` | **none** | **No** — customer/item search inert, total hardcoded ₹0.00, SAVE and CREATE ORDER have no `onPress` |
| Master ▾ → Item Master | `ItemMasterScreen` | **none** | **No** — 25-line placeholder: *"Items will be synced from Tally later"* |
| Master ▾ → Customer Master | `CustomerMasterScreen` | **none** | **No** — same placeholder, while a complete 502-line `CustomersScreen` sits unreachable |
| User ▾ → Employees | `EmployeeListScreen` | `/users/*` | **Partly** — CRUD works on native; on web every confirm dialog is a no-op (B12); edit demotes admins (B11); blank password becomes `password123` (S4) |
| User ▾ → Attendance | `AttendanceScreen` | `/attendance/*` | **Partly** — all three sub-tabs load, but every time shown is wrong (B1), admins count as absent (B10), monthly maths is off (B9) |
| User ▾ → Live Tracking | `LiveTrackingScreen` | `/location/*` | **Partly** — map and trail render, but there is nothing to plot between check-in and check-out (B2); times wrong (B1) |
| User ▾ → Profile | `ProfileScreen` | none | **Read-only** — no change-password UI although `PATCH /auth/change-password` exists |
| Logout menu → Lunch / Resume / Check Out | `RootNavigator` | `/attendance/lunch-*`, `/checkout` | **Partly** — the calls succeed, but check-out bricks the session (B4) |
| *(unreachable)* Reports | `ReportsScreen` | 4 report endpoints | Not wired into the navigator |
| *(unreachable)* Customers | `CustomersScreen` | `/customers` | Not wired into the navigator |

**Backend routes with no caller:** `GET/POST/PUT /api/orders` (fully implemented), `POST/PUT /api/items`, `POST /api/items/:id/stock`, `PUT /api/customers/:id`, `PATCH /api/auth/change-password`, `GET /api/reports/*`. The order-taking pipeline — the reason the app exists — is complete on the server and entirely absent from the client.

### Attendance and tracking, end to end

This is what the request specifically asked about, so the whole chain was traced against live data.

**What is stored is correct.** `config/db.js` pins each connection to UTC, the schema uses `DATETIME`, and the live rows are consistent:

```
employee_id  checkin_date  checkin_time           checkout_time  lunch_out_time         lunch_in_time
admin        2026-08-26    2026-08-26 05:28:47    null           null                   null
ABS          2026-08-13    2026-08-13 06:22:05    null           2026-08-13 08:33:59    null
admin        2026-08-13    2026-08-13 06:18:06    null           2026-08-13 08:59:12    2026-08-13 08:59:17
```

**What is displayed is wrong.** `05:28:47` UTC is **10:58 AM IST**. The app shows `05:28 AM` (B1).

**What is missing is the tracking.** `location_logs` holds **5 rows for the entire history**, and each one matches a check-in, lunch or resume event exactly. Not one background ping has ever been recorded, against an expected ~50 per employee per working day (B2).

**What never ends is the shift.** Both 13 August shifts are still open thirteen days later, and `is_auto_checkout` has never been set by anything (B3). Live Tracking therefore still lists those employees as Active.

---

## Part 2 — Security

### S1 — The API client contains a mock backend that silently replaces the real one — **Critical**

`services/api.js` carries ~450 lines of seed data and a `handleMockRequest()` handler, wired into the axios response interceptor:

```js
if (!error.response || error.code === 'ECONNABORTED' ||
    error.response.status === 404 || error.response.status === 503) {
  const mockRes = await handleMockRequest(error.config || {});
  return mockRes;                       // resolves as if the server had answered
}
```

The login branch of that handler never checks the password:

```js
const matched = users.find(u => u.id.toLowerCase() === (body.id || '').toLowerCase()) || users[0];
return { data: { token: 'mock-jwt-token-' + Date.now(), user: matched } };
```

`users[0]` is `ADMIN001 — Shradha Admin, permissions: ['all']`.

**Failure scenario.** Turn off Wi-Fi, or stop the backend, or simply be on a slow connection — the axios timeout is 6 s. Type any employee ID and any password. `AuthContext.signIn` receives `{ token, user }`, stores it, and sets `status: 'signedIn'`. **You are now inside the app as a full administrator**, and every subsequent call falls through to the same mock, so the app is fully navigable on fabricated data.

Second failure mode, no attacker required: a field employee on 3G checks in, the request exceeds 6 s, the mock writes the check-in to `AsyncStorage` and returns "Checked in successfully". The employee believes they are on shift. The server has no row. The admin marks them absent. Their attendance is silently fiction.

This single mechanism defeats the login throttle, the `is_active` check, `userCan()`, and every permission gate in `middleware/auth.js`.

**Fix.** Delete the mock and the interceptor branch. If offline capability is wanted, it belongs behind an explicit build flag and must never satisfy `/auth/login`.

---

### S2 — Four route modules enforce no permissions at all — **High** — *verified*

`routes/orders.js`, `routes/customers.js` and `routes/reports.js` use `authenticate` and never `requirePermission`. `routes/items.js` guards writes but not reads.

**Verified.** A token was minted locally for the live user `ABS`, whose stored `permissions` is `[]` — an account granted nothing at all:

```
/api/reports/location-audit?date=2026-08-13   -> 200  {"logs":[{"user_id":"admin","latitude":"26.87765570",…
/api/reports/ledger                           -> 200
/api/reports/dashboard                        -> 200
/api/orders                                   -> 200
/api/customers                                -> 200
/api/items                                    -> 200
/api/location/live                            -> 403  {"required":"live_tracking.view"}
/api/attendance/daily                         -> 403  {"required":"attendance.view"}
/api/users/employees                          -> 403  {"required":"employees.view"}
```

The three gated routes behave correctly. The unguarded ones hand the same account **the administrator's complete GPS timeline** — precisely the data `live_tracking.view` exists to protect, reachable through the back door at `/reports/location-audit`. Also exposed: the whole customer list with credit limits, the item master, every order regardless of who raised it, and company-wide sales figures.

`PUT /api/orders/:id/status` is likewise open: any employee can mark any order completed or cancelled.

**Fix.** Guard each route the way `routes/users.js` does — per action, not per router. `constants/permissions.js` will also need `orders`, `customers`, `items` and `reports` pages before the admin UI can grant them.

---

### S3 — One request deletes every employee and their entire history — **High**

```js
router.delete('/employees/all', requirePermission('employees.delete'), async (req, res) => {
  await pool.query('DELETE FROM users WHERE role = "employee"');
  res.status(204).end();
});
```

`checkins` and `location_logs` are `ON DELETE CASCADE` from `users`. This one call therefore destroys every check-in record and every GPS ping ever collected, irreversibly. `CLAUDE.md` explicitly notes those rows "may matter for payroll disputes". There is no soft-delete, no export, no confirmation beyond a client-side dialog — and on web that dialog does not even appear (B12).

It is exposed in the UI as a "Delete All Employees" button.

**Fix.** Remove the endpoint. If bulk offboarding is genuinely needed, deactivate rather than delete (`is_active = FALSE` already exists and is honoured on every request).

---

### S4 — Employees created without a password get `password123` — **High**

`screens/EmployeeListScreen.js`:

```js
payload.id = newUserId;
if (!payload.password) {
  payload.password = 'password123';
}
```

The form only requires a password when it is not empty; the admin is never told a default was substituted, and the employee is never prompted to change it. `POST /api/users` accepts any non-empty string — there is no server-side length or complexity rule (unlike `create-admin.js`, which demands 8+, and `change-password`, which demands 6+).

**Failure scenario.** An admin adds five field staff quickly, leaving the password blank. All five accounts now share a password that appears in the source code. Any of them can sign in as the others; anyone who has seen the repo can sign in as all of them.

---

### S5 — Order line prices are taken from the client — **Medium**

`routes/orders.js` builds each `order_items` row from the request body: `item.rate`, `item.item_name`, `item.hsn`, `item.gst_percent`. Nothing is read from the `items` table, and nothing checks that `item_id` even exists at that price.

`CLAUDE.md` describes the snapshot as *"copied at write time"* from the item master. It is copied from whatever the phone sent. A crafted request books a ₹2,150 ceiling fan at ₹1 with 0% GST, and the order history will forever show that as the legitimate price.

Related: there is no stock check, so orders drive `items.qty` negative without complaint.

---

### S6 — `employees.edit` can rewrite `role`, and the UI treats `role` as authority — **Medium**

`PUT /api/users/:id` accepts `role` under the `employees.edit` grant, while permission changes correctly require the separate `employees.permissions` grant. `userCan()` ignores `role`, so this is not a direct server-side escalation — but `role` is not inert either: `routes/locations.js` filters the live map on `role = 'employee'`, and `create-admin.js`/seed data tie `role: 'admin'` to `['all']`.

Nothing prevents a holder of `employees.edit` from editing their **own** record (only `/status` and `DELETE` block self-targeting).

**Fix.** Move `role` behind `employees.permissions`, and block self-edit of role the way self-deactivation is blocked.

---

### S7 — Rate limiting covers only the login route — **Medium**

`routes/auth.js` has an in-process throttle (8 attempts / 15 min, keyed on employee ID). Nothing else is limited. `POST /api/location/log` takes an unbounded stream of writes into the one table with no natural ceiling, and it never checks whether the caller is actually checked in — a checked-out employee's device, or a stale token, can keep writing GPS rows indefinitely.

The login throttle is also per-ID, so an attacker spreading attempts across IDs is never slowed, and it resets on every `node --watch` restart.

---

### S8 — Employee GPS is sent to a third party on every web check-in — **Medium** *(privacy / compliance)*

`CheckinGateScreen` reverse-geocodes on web by calling `https://nominatim.openstreetmap.org/reverse?...&lat=…&lon=…`. That transmits an identified employee's precise location to an external service outside the company's control, with no consent step, no attribution, and no regard for Nominatim's usage policy (which forbids systematic use and requires a custom User-Agent).

This app already sits inside a regulated activity — background tracking of identified people. Adding a silent third-party disclosure to it is the kind of thing that turns a compliance question into a compliance problem. S11 from the 11 August review (prominent disclosure) also remains open.

---

### S9 — `scripts/seed-data.js` creates a live admin with a published password — **Medium**

```js
const hashedPassword = await bcrypt.hash('admin123', 10);   // ADMIN001 / Shradha Admin / ['all']
const empPassword    = await bcrypt.hash('123456', 10);     // SA0001
```

The script is not in `package.json`, so it is easy to forget it exists — and just as easy to run once "to get some data in". It grants `['all']` to an account whose password is in the repository. It also seeds the wrong company (see K4).

---

### S10 — Employee names are injected unescaped into the map WebView — **Low**

`components/LeafletMap.js` builds HTML by string interpolation, and `LiveTrackingScreen` supplies `tooltip: '<b>' + e.name + '</b><br/>…'`. A name is admin-controlled text stored in the database. `JSON.stringify` does not escape `</script>`, so a crafted name can close the script block and execute inside the WebView.

Blast radius is limited (the WebView holds no token), but it is a stored-XSS pattern and trivially avoided by passing data through `postMessage` or escaping on the way in.

**Still open from 11 August:** S1 (MySQL `root` user), S5 (`CORS: *`), S7 (no security headers), S10 (no TLS to MySQL), S11 (location disclosure).

---

## Part 3 — Conflicting code

**K1 — `CLAUDE.md` describes a repo that no longer exists.** It states *"auth works end to end, nothing else does… No routes for items, customers, orders, check-in or location. No screens beyond sign-in and a home screen."* There are now 8 route modules and 14 screens. Every invariant in that file was checked during this audit and the *invariants* still hold where implemented — it is the state description, the file inventory and the review link that are stale. Anyone onboarding from it will be misled about what exists.

**K2 — Tally placeholders contradict the documented exclusions.** `ItemMasterScreen` and `CustomerMasterScreen` both say *"will be synced from Tally later"*, while `CLAUDE.md` lists Tally sync under **Deliberate exclusions** — *"These are decisions, not oversights. Do not reintroduce them incidentally."* Meanwhile `/api/items` and `/api/customers` are fully implemented, so the placeholder is not even blocked on anything.

**K3 — Beats are back.** `schema.sql` dropped `beat_id` deliberately; `routes/orders.js` and `routes/reports.js` now alias `c.group_name AS beat_name`, `/reports/beats` is a beat report, and `CustomersScreen` defaults new customers to `group_name: 'Commercial Market Beat'`.

**K4 — The app identifies as a different company in a different state.** Seed users are "Shradha Admin"/`admin@shradha.com`; seed customers, `CustomersScreen` form defaults (`city: 'Mumbai'`, `state: 'Maharashtra'`) and the GPS failure fallback (`19.0760, 72.8777`) are all Mumbai. The client is KL Electricals, Lakhtokia, **Guwahati** — and the live GPS data sits at `26.87, 75.76`.

**K5 — `schema.sql` and `migrations/001` have drifted.** The migration modifies `checkins.checkin_time` and `checkout_time` but never adds `lunch_out_time`, `lunch_in_time` or `is_auto_checkout`, which `schema.sql` declares. A database created before those columns and brought forward with the migration will 500 on `/attendance/lunch-out` with `ER_BAD_FIELD_ERROR`. `CLAUDE.md`: *"when you change `schema.sql`, add a matching migration."* (The live database is fine — it was built from `schema.sql`.)

**K6 — `Alert.alert` is used where `services/confirm.js` is mandated.** `EmployeeListScreen` calls `Alert.alert` directly for validation, delete and delete-all. `CLAUDE.md` documents `confirm.js` as the reason those calls work outside the React tree and on web. See B12 for the consequence.

**K7 — Ping interval disagrees with the documentation.** `utils/location.js` sets `timeInterval: 15 * 60 * 1000`; `schema.sql` and `purge-locations.js` both say "10-minute interval… roughly 50 rows per employee per working day". At 15 minutes an 9-hour shift yields ~36.

**K8 — The documented UTC contract is not implemented anywhere.** `CLAUDE.md`: *"The client treats every stored string as UTC (it appends 'Z' before parsing)."* No file in the client appends `'Z'` or converts a DATETIME string. That missing line is B1.

**K9 — The permission grid covers three pages; the app has ten.** `constants/permissions.js` lists only `employees`, `attendance`, `live_tracking`. There is no way to grant or withhold Orders, Master or Reports — and no server-side check to honour it if there were.

**K10 — "You won't be able to check in again until 7:30 AM tomorrow."** That message appears twice (`RootNavigator`, `HomeScreen`). No 7:30 rule exists anywhere. The real constraint is the `UNIQUE (employee_id, checkin_date)` key, which frees up when the **UTC** date rolls over — 05:30 IST.

**K11 — Three different password policies.** `create-admin.js` requires 8+, `change-password` requires 6+, `POST /api/users` requires only non-empty, and the client substitutes `password123`.

**K12 — Two parallel implementations of the same screens.** `components/WorkforcePages.js` contains minified-style duplicates of the attendance, tracking and profile pages (including the only change-password UI in the codebase). Nothing imports it. Same for `CustomersScreen`, `ReportsScreen`, `UserHomeScreen` and `UserNavigator`.

---

## Part 4 — Bugs

### B1 — Every timestamp in the app is displayed wrong by the UTC offset — **High** — *verified*

The server returns raw MySQL DATETIME strings (`dateStrings: true`), confirmed live:

```json
{"recorded_at":"2026-08-13 06:18:06"}
```

Every consumer parses it with `new Date(value)`. A string with a space and no zone is treated as **local time** by every JS engine, so a UTC instant is read as if it were IST:

```
raw DATETIME from API : 2026-08-26 03:45:30
new Date(raw)         : Wed Aug 26 2026 03:45:30 GMT+0530
displayed by fmtTime  : 03:45 AM
correct (UTC-aware)   : 09:15 am
```

**Failure scenario, from live data.** `admin` checked in today at `2026-08-26 05:28:47` UTC — **10:58 AM** in Guwahati. The Attendance tab shows **05:28 AM**. Every check-in, check-out, lunch time, GPS trail timestamp and tooltip is shifted by 5 hours 30 minutes. Anyone reading the attendance sheet for lateness or hours worked is reading fiction.

Affects `AttendanceScreen.fmtTime`, `LiveTrackingScreen.fmtTime`, `WorkforcePages`, and the trail tooltips.

**Fix.** One shared helper — `new Date(value.replace(' ', 'T') + 'Z')` — used everywhere, which is exactly what `CLAUDE.md` already claims happens (K8).

---

### B2 — Background GPS tracking never logs anything — **High** — *verified*

**Verified.** `location_logs` contains 5 rows in total, spanning 13 August to 26 August. Each one has a `recorded_at` identical to a check-in, lunch-out, lunch-in or check-out time — i.e. every row was written by `routes/attendance.js`, none by `POST /location/log`. The 13 August session ran from 06:22 to at least 08:33 with zero pings in between.

Two causes, both live:

1. **On web, `Location.startLocationUpdatesAsync` is not implemented.** `startLocationTracking()` wraps it in `try/catch` and only `console.warn`s, so the UI still announces *"Live GPS tracking activated"* while nothing has started. The admin panel runs on web.
2. **On native, failures are equally silent.** The task posts through the same axios instance as everything else, so a failed ping hits the S1 mock fallback and resolves as `{ success: true }`.

Consequence: Live Tracking can only ever plot the two-to-four event fixes of a day. The "trail" is not a trail. `purge-locations.js`, the retention sweep, has nothing to sweep.

**Fix.** Report unsupported platforms to the user instead of swallowing the error; verify a ping lands after check-in; exclude `/location/log` from any fallback.

---

### B3 — Nothing ever closes a shift — **High** — *verified*

**Verified.** Both 13 August check-ins still have `checkout_time = NULL`, thirteen days on. `is_auto_checkout` exists in the schema, is rendered in the Attendance detail modal, and is written by **no code anywhere**. There is no scheduled job, no cron, no server-side sweep.

**Failure scenario.** An employee forgets to check out. Their shift stays open forever. `/location/live` orders by *"checked in and not checked out"*, so they appear permanently **Active** on the map at their last known position. Hours worked cannot be computed for that day, and the `is_auto_checkout` flag the UI displays will never be true.

---

### B4 — Checking out locks the user out of the app for the rest of the day — **High**

`handleCheckout` sets `checkedInState = 'gate'`, which re-opens the check-in modal. That modal has no dismiss, no `onRequestClose`, and no sign-out control (`styles.topBar` and `styles.logoutBtn` are defined but never rendered). Pressing Check-In again hits the `UNIQUE (employee_id, checkin_date)` key and returns `400 — "You are already checked in for today"`.

**Failure scenario.** A field employee checks out at 6 PM to end their shift, then needs to look up a customer at 6:05. The app is a modal they cannot dismiss, with a button that only ever errors. The only escape is to log out and back in — which lands on the same gate. Access returns at 05:30 IST, when the UTC date changes; the app tells them 7:30 AM (K10).

The same trap catches anyone who cannot get a GPS fix or denies location permission on first launch: the gate is the whole app.

---

### B5 — A failed GPS read is recorded as a Mumbai check-in — **High**

```js
} catch (e) {
  console.warn('[Location] Failed to get location, using default fallback:', e);
  return { latitude: 19.0760, longitude: 72.8777, accuracy: 10 };   // Mumbai
}
```

`getCurrentLocation()` never fails. `CheckinGateScreen` then renders **"GPS Fixed ✓"** with `accuracy: ±10 metres` over coordinates 2,600 km from Guwahati, and posts them as the attendance fix.

**Failure scenario.** Employee indoors, GPS unavailable. They check in. The database records a precise-looking position in Mumbai. The attendance record now contains fabricated location evidence — in a system whose stated purpose is proving where staff were. `CustomersScreen` has the same fallback for capturing shop coordinates.

**Fix.** Propagate the failure; let the check-in fail honestly or be recorded with a null fix.

---

### B6 — Dashboard monthly sales is multiplied by the line count — **Medium**

```sql
SELECT COALESCE(SUM(oi.qty),0) AS count, COALESCE(SUM(o.total_amount),0) AS val
  FROM order_items oi JOIN orders o ON oi.order_id = o.order_id
 WHERE DATE_FORMAT(o.order_date,'%Y-%m') = ?
```

`o.total_amount` is summed once per **line item**, not once per order.

**Failure scenario.** One ₹1,000 order with three lines. `MTD SALES` shows ₹3,000. With a typical 5-line order the dashboard overstates revenue five-fold.

---

### B7 — Cancelling an order never returns the stock — **Medium**

`PUT /api/orders/:id/status` writes the new status and nothing else. Creating an order inserts negative `stock_movements` rows and recomputes `items.qty`; cancelling it leaves both untouched.

**Failure scenario.** An order for 50 fans is raised (`qty` drops 500 → 450), then cancelled. `items.qty` stays 450. The 50 fans are invisible to every future order until someone notices and posts a manual adjustment. `CLAUDE.md` prescribes exactly the right shape here — *"Corrections are new `adjustment` rows"* — and the code does not do it.

---

### B8 — "No order" visits and cancelled orders are the same row — **Medium**

A no-order checkout is stored as `status = 'cancelled'` with a `[NO ORDER REASON]` note. `/reports/dashboard` then counts **every** cancelled order as a no-order visit, and excludes it from sales.

**Failure scenario.** A salesman raises a ₹40,000 order; the customer cancels it an hour later; an admin sets the status to `cancelled`. The dashboard now reports an extra "unproductive visit" that never happened, and the salesman's productive call disappears from the count.

Also in the same handler: `is_no_order` responses return `total_amount: grandTotal` while storing `0`, and `scheme` is captured on every line but never applied to any total.

---

### B9 — Monthly attendance counts non-working days as present — **Medium**

`/attendance/monthly-summary` computes `workingDays` by excluding Sundays and holidays, but `present_days` counts **all** check-in rows in the range, then `absent_days = workingDays − present_days`.

**Failure scenario.** August has 26 working days. An employee works 4 Sundays and misses 4 Mondays: 26 check-ins, 26 working days, **0 absences reported** — while they were in fact absent 4 times. The same expression can also silently clamp at zero (`Math.max(0, …)`) rather than reveal the inconsistency.

Secondary: `lastDay` mixes server-local `today.getDate()` with UTC month arithmetic.

---

### B10 — Admins are counted absent; deactivated staff are still tracked — **Medium**

`/attendance/daily` and `/monthly-summary` select `FROM users WHERE u.is_active = TRUE` with **no role filter**, so every admin account appears in the attendance sheet and accumulates absences. `/location/live` does the opposite — it filters `role = 'employee'` but ignores `is_active`, so deactivated employees remain on the live map.

The two endpoints disagree about who the workforce is.

---

### B11 — Editing an employee resets their role — **Medium**

`EmployeeListScreen.handleSaveUser` always sends `role: 'employee'`, and `PUT /api/users/:id` always writes the column.

**Failure scenario.** An admin opens the second administrator's record to correct a phone number and saves. That account is now `role = 'employee'`. They vanish from `/location/live` filtering, and any future role-based behaviour treats them as field staff.

---

### B12 — Confirmation dialogs are no-ops on the web admin panel — **Medium** — *verified*

**Verified** in `node_modules/react-native-web/dist/exports/Alert/index.js`:

```js
class Alert { static alert() {} }
```

`EmployeeListScreen` uses `Alert.alert` for validation errors, "Delete Employee" and "Delete All Employees" — and the destructive action lives *inside* the dialog's button callback.

**Failure scenario.** On web (where the admin panel is used): pressing Delete does nothing at all, with no feedback — the confirm never renders, so the callback never fires. Submitting the add-employee form with a blank name also does nothing and shows no error. The user concludes the buttons are broken. `services/confirm.js` + `<AlertHost />` exist precisely to solve this and are used correctly everywhere else.

---

### B13 — `PUT /items/:id` and `PUT /customers/:id` null out omitted fields — **Medium**

Both handlers write every column unconditionally from the request body. Any field the caller omits arrives as `undefined` and is written as `NULL`.

**Failure scenario.** A client sends `{ name: 'New name' }` to correct a typo. The item loses its code, brand, category, HSN, GST percentage, unit and rate — and `is_active` becomes `NULL`, which is falsey, so the item disappears from the default `activeOnly` listing. Neither route validates that required fields are present.

---

### B14 — `AppText` sizes that do not exist render at 18px — **Low**

`HomeScreen` uses `size="2xl"` for the four dashboard figures and `ProfileScreen` uses `size="3xl"` for the avatar initial. `TYPOGRAPHY.size` defines `xs, sm, md, base, lg, xl, xxl, huge` — no `2xl` or `3xl` — so `TYPOGRAPHY.size[size] || TYPOGRAPHY.baseSize` silently yields 18px. The headline stat is the same size as its own caption. (Predicted as B10 in the 11 August review; now happening in two screens.)

`ProfileScreen` also passes `type="primary"` to `Button`, which takes `variant`.

---

### B15 — Check-in is not transactional — **Low**

`POST /attendance/checkin` inserts the `checkins` row, then separately inserts the `location_logs` row, with no transaction. A failure between them leaves a check-in with no location fix. `routes/items.js` and `routes/orders.js` both get this right, so the pattern exists to copy.

---

### B16 — The location audit report cannot use its index — **Low** *(performance)*

```sql
WHERE DATE(l.recorded_at) = ?
```

Wrapping the column in `DATE()` prevents use of `idx_user_date` / `idx_recorded_at`, forcing a full scan of the one table designed to grow unboundedly. `routes/locations.js` already uses the correct range form (`>= ? AND < DATE_ADD(?, INTERVAL 1 DAY)`).

---

### Lower-priority observations

- **`console.log('GET /today returned row:', row)`** in `routes/attendance.js` writes a full check-in row to the server log on every app launch and every dashboard refresh.
- **6-second axios timeout** is aggressive for rural 3G and is the trigger for S1's silent fallback.
- **`adjustDay` / `handleCalendarDayPress`** mix `new Date('YYYY-MM-DD')` (parsed UTC) with local getters. Correct for IST; breaks west of UTC.
- **`CustomersScreen`** calls `alert()` and `navigator.geolocation` — both undefined on native. Harmless only because the screen is unreachable.
- **`LiveTrackingScreen`** auto-refreshes `/location/live` every 30 s with no visibility check, so a backgrounded web tab polls indefinitely.

---

## Part 5 — Cleanup

| | Item | Notes |
|---|---|---|
| C1 | `services/api.js` lines 44–~500 | `SEED_USERS`, `SEED_ITEMS`, `SEED_CUSTOMERS`, `SEED_ORDERS`, `SEED_HOLIDAYS`, `generateSeedCheckins`, `handleMockRequest` — the S1 mechanism, ~450 of the file's 699 lines |
| C2 | `screens/CustomersScreen.js`, `screens/ReportsScreen.js`, `screens/UserHomeScreen.js`, `navigation/UserNavigator.js`, `components/WorkforcePages.js` | 1,300+ lines unreachable from `MainAppContainer`. Decide: wire up or delete — `CustomersScreen` and `ReportsScreen` are nearly complete features (F3) |
| C3 | `backend/test-today.js`, `backend/test-update.js` | Ad-hoc scratch scripts at the backend root |
| C4 | `HomeScreen` | `checkedIn`, `checkinData`, `checkinLoading`, `handleToggleCheckin` and ~10 style blocks (`checkinCard`, `actionGrid`, `header`, `avatarMini`, …) survive a card that is no longer rendered; `Button`, `TouchableOpacity`, `confirmAction`, `requestLocationPermissions` are imported for it |
| C5 | `CheckinGateScreen` | `topBar`, `avatarMini`, `logoutBtn` styles for a header that is not rendered; `useAuth`/`signOut`/`confirmAction` imported unused |
| C6 | `dist/` (3.1 MB), `scratch/` (4.6 MB), `bundle_analysis.txt` | Build output and a dumped Metro bundle sitting in the source tree |
| C7 | `backend/scripts/seed-data.js` | Not referenced by `package.json`; see S9 |
| C8 | `constants/colors.js` | `gradientPrimary/Accent/Light`, `secondaryDark`, `cardHover`, `infoLight`, `pending/confirmed/completed/cancelled` unused; `TextField` references `COLORS.errorDark`, which does not exist — field error text falls back to the default colour |
| C9 | `routes/attendance.js` | Debug `console.log` on the hottest endpoint |
| C10 | `README.md` / `CLAUDE.md` | Both describe the pre-routes repo (K1) |

---

## Part 6 — Good to have, ordered by what they unblock

1. **F1 — Put the repo under version control.** Still not a git repository (`git rev-parse` fails). Every finding above is a change someone will have to make, and there is currently no way to review, revert or attribute any of them. This was the top item on 11 August and remains the highest-value action in the project.
2. **F2 — Build the order flow.** `OrdersScreen` and `NewOrderScreen` are shells over a complete, working API. This is the app's reason to exist and it is the shortest path from "demo" to "useful".
3. **F3 — Wire up Item Master and Customer Master.** `CustomersScreen` is already written; `/api/items` and `/api/customers` already work. Two placeholders currently claim a Tally integration that is out of scope.
4. **F4 — Server-side auto-checkout.** A nightly job closing open shifts at a configured time, setting `is_auto_checkout = TRUE` (the column and the UI already expect it), plus a stated shift policy to replace the fictional "7:30 AM".
5. **F5 — Finish the permission model.** Guard orders/customers/items/reports per action, and extend `constants/permissions.js` so the grants can actually be issued.
6. **F6 — One timezone contract, one formatter.** A `utils/datetime.js` that parses the server's DATETIME strings as UTC and formats in the business timezone, used by every screen. Add the business timezone to `.env.example` rather than assuming IST.
7. **F7 — Replace the mock with a real offline story.** If field staff need to work without signal, that is a queued-write feature with explicit UI state — not a silent interceptor. `schema.sql` already documents the re-add path for `client_ref`.
8. **F8 — Attendance export.** Payroll is the consumer of this data; there is currently no way to get a month out of the system except by reading it off a screen.
9. **F9 — Stock reversal on cancellation**, as an `adjustment` movement (B7).
10. **F10 — Password self-service.** `PATCH /auth/change-password` exists and works; the only UI for it is in a dead file. Pair with a first-login forced change to close S4.
11. **F11 — A test runner and a linter.** Every finding in Part 4 is the kind a single integration test would have caught. There is still no `npm test`.
12. **F12 — Schedule the retention sweep.** `purge-locations.js` is written and documented but nothing runs it; it will matter once B2 is fixed and pings actually accumulate.

---

## Tested and rejected

Recorded so they are not raised again.

1. **"Check-in is impossible on web because `requestBackgroundPermissionsAsync` is unavailable."** Rejected. `node_modules/expo-location/build/ExpoLocation.web.js` implements it as `getPermissionsAsync(true)` — the same browser geolocation prompt as the foreground request. Web check-in works; only the *background updates* API is missing (B2).
2. **"`DELETE /api/users/employees/all` is shadowed by `DELETE /api/users/:id`."** Rejected. `/:id` matches a single path segment, so `/employees/all` cannot reach it, and the specific route is registered first regardless. The endpoint is dangerous (S3) but not misrouted.
3. **"The permission matcher or `authenticate` is broken."** Rejected. Verified live: an account with `permissions: []` receives a correct `403 {"required":"live_tracking.view"}` from `/location/live`, `/attendance/daily` and `/users/employees`. `middleware/auth.js` and `utils/permissions.js` behave exactly as documented — the problem is the routes that never call them (S2).

---

## Suggested order

**Before anyone else uses this build:** S1 (auth bypass), S4 (`password123`), S3 (mass delete).

**Before attendance data is trusted for anything:** B1 (timestamps), B2 (tracking logs nothing), B3 (auto-checkout), B5 (Mumbai fallback), B4 (post-checkout lockout).

**Before the app leaves the LAN:** S2 (permission gaps), S5–S9, plus the still-open S1/S5/S7/S10 from 11 August (MySQL `root`, CORS, headers, TLS).

**Then:** the order flow (F2) and the master screens (F3), which is where the remaining business value is.

All of it after F1 — version control — so the work is reviewable.
