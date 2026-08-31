# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A field-sales and employee-tracking app for KL Electricals, in two halves that live in one repo:

- **Root** — Expo 51 / React Native 0.74 app, targeting iOS, Android and web.
- **`backend/`** — Node ≥18 data layer: `mysql2`, `bcryptjs`, `dotenv`.

Employees check in once per day with a GPS fix, are pinged in the background while checked in, visit customers, and write orders against an item master.

## Current state

Working end to end, and verified against a running server:

- **Auth** — login, `/me`, change-password, per-action permission guards.
- **Attendance** — check-in, lunch out/in, check-out, the daily sheet, the
  monthly summary, the per-employee grid, holidays, and an hourly sweep that
  closes shifts nobody checked out of.
- **Tracking** — background pings while on shift, the live map, the day trail,
  the GPS audit report, and the retention sweep.
- **Employees** — directory, create, edit, activate/deactivate, delete, and the
  permission grid.
- **Customers** — directory and onboarding.
- **Items and orders** — the full API, including a server-side price snapshot,
  the stock ledger, and stock returned on cancellation.
- **Dashboard** — today's orders, items sold, no-order visits and month-to-date sales.

**The business rules (August 2026).** Three documents arrived on 30 August
2026 — `KL_App_Requirements_FINAL.pdf` (sections 1-15, rules R-01..R-30),
`KL_APP_RATES_markups_3.xlsx` (8,519 KL items) and
`LEMAC_Developer_Master_v7.xlsx` (451 Lemac items). The backend was built
against them: the six-rate pricing engine, party classification, full order
capture, geotagged attendance with shifts, salary and advances, the 20-segment
incentive, KL Utsav, FIFO payment matching with the dealer cash discount, the
five purchase forms with Goods-in-Transit, estimate follow-ups, and the
time-based alert sweep. A second pass closed R-05, R-06 and R-14, the §4.4 and
§4.6 sign-offs, reverse-loading, all twelve reports of §12 with CSV export, the
salary slip, the quote share and the dashboard review stamp. A third pass swept
R-01..R-30 for rules nothing referenced and found R-11 missing entirely. A fourth
closed the rest: **Tally Prime sync (section 14)**, PDF export everywhere 12/7/A.2
require it, the invoice in three copies (4.5), the collections handover (8), the
godown close (4.8) and reverse geocoding (D.2).

A fifth pass added the two optional photographs (4.1, 4.3), the **Lemac growth
schemes** (seeded INACTIVE — see below), and a proving harness for the Tally sync.

A sixth pass closed three of the four things the fifth had listed as open:
**rename-aware Tally masters**, the **Lemac return penalty** as a capability
that is off until configured, and the **nine client screens** with the API
binding layer beneath them. It also added `npm run tally -- --doctor`, a
six-step preflight for the one item that remains.

**The backend is feature-complete against `KL_App_Requirements_FINAL.pdf`, and
the one regime the Lemac sheet adds beyond it is built too.**
Migrations 005-014; `docs/requirements-implementation-2026-08-31.md` is the
requirement-by-requirement map. What is still open: the **Tally first run**
against a real instance — it needs the office machine, nothing is listening on
port 9000 here — and two data gaps: zero GST and no HSN on 8,885 of 8,909
items, which `POST /api/tally/pull?scope=items` may fill.

**The app (July 2026 screens).** The client is a desktop-first, responsive,
role-based app — `navigation/MobileNavigator.js`, `screens/mobile/`, `components/mobile/` —
covering all 27 screens across nine roles (Manas approves, Ashish picks, Ajit
verifies and dispatches, Gaurav bills, Kamal delivers, Sonu buys, Monu sells,
Sibu closes cash, Yash owns). `App.js` renders it instead of `RootNavigator`.

**August 2026 added nine screens** (`screens/mobile/` now holds 41 files) for
the subsystems the requirements document brought with it: salary, advances and
leave, the incentive, the GIT register, internal transfers, the cash handover,
the R-11 rate queue, the twelve reports and the Tally console. None of them is a
tab — see the tab-budget invariant below.

Every screen reads the live API through `services/endpoints.js` and
`hooks/useApi.js`; there are no fixtures. `constants/options.js` holds the fixed
choice lists (agent types, delivery-failure reasons, units) — vocabulary, not
data.

The API behind it: `routes/workflow.js`, `agents.js`, `invoices.js`,
`dispatch.js`, `purchases.js`, `returns.js`, `field.js`, `cash.js`,
`stockcount.js`, `notifications.js`, `payments.js`, `attachments.js`, over 29
new tables (migrations `003_order_workflow.sql`, `004_payments_attachments.sql`),
since extended by `005`-`014` to 72 tables.

`npm run seed-roles` in `backend/` creates the nine staff accounts with
per-role grants. The old web-panel screens (`screens/*.js`) are intact but
unreachable — restoring them is a one-line revert in `App.js`.

`routes/attendance.js` is the reference for a route module (per-action guards,
transactional writes, business-day handling); `screens/AttendanceScreen.js` for a
screen; `screens/LoginScreen.js` for a form.

## Commands

Frontend (repo root):

```bash
npm install          # installs BOTH halves — postinstall runs backend's install
npm run dev          # setup check, then API + Expo together in one terminal
npm run setup        # the setup check on its own, starting nothing
npm run app          # Expo alone (what `npm run dev` used to be)
npm run web          # web target
npm run android      # requires expo prebuild; android/ and ios/ are gitignored
npm run ios
```

Backend (`cd backend`):

```bash
npm run dev              # API on PORT (5000) with node --watch restart-on-change
npm start                # API without the watcher
npm run init-db          # create database + apply schema.sql; idempotent, inserts nothing
npm run build-init-sql   # regenerate init.sql (the standalone one-file setup script)
npm run create-admin -- --id ADMIN001 --name "Name" --email a@b.com --password "min-8-chars"
npm run purge-locations -- --dry-run          # report what the retention sweep would delete
npm run purge-locations -- --days 180         # override LOCATION_RETENTION_DAYS
npm run auto-checkout -- --dry-run            # list shifts the sweep would close
npm run migrate                               # apply outstanding migrations
npm run migrate -- --status                   # what is applied, what is pending
npm run seed-roles                            # create the nine staff accounts
npm run seed-roles -- --reset                 # bring existing accounts back to their grants
npm run recompute -- --dry-run                # report cache drift, write nothing
npm run recompute                             # rebuild items.qty and closing_balance
npm run import-rates -- --all                 # load both rate spreadsheets into items
npm run import-rates -- --all --dry-run       # report what it would change
npm run seed-segments                         # the 20 incentive segments, and map items
npm run seed-segments -- --report             # show the item->segment mapping only
npm run seed-business                         # 21 staff, shifts, workplaces, KL Utsav
npm run seed-business -- --reset              # reapply shifts and grants, never passwords
npm run alerts                                # run the notification sweep once
npm run secure-accounts -- --dry-run          # who is still on a handed-over password
npm run secure-accounts                       # mark them; they must change it to continue
npm run rebuild-schema                        # regenerate schema.sql from the database
npm run rebuild-schema -- --check             # report drift, write nothing
npm run tally                                 # one Tally push cycle
npm run tally -- --pull                       # push, then pull masters + reconcile
npm run tally -- --watch                      # run continuously ("real-time")
npm run tally -- --ping                       # is Tally reachable and configured?
npm run tally -- --doctor                     # the six-step preflight, each failure with its fix
```

There **is** a test runner now — seven suites, no framework, plain Node:

```bash
npm run test:api          # 3 — every server endpoint bound by the client, or excused
npm run test:pricing      # 54 — the rate card; sweeps all 3,569 priced items
npm run test:invariants   # 20 — caches vs their ledgers, privacy, least privilege
npm run test:schema       # 12 — schema.sql and init.sql vs the migrated database
npm run test:tally        # 31 — the sync, against a Tally-protocol stand-in
npm run test:business     # 175 — R-01..R-30 over HTTP; needs the server running
npm run test:growth       # 33 — the growth schemes, through the whole pipeline
npm run test:all          # all seven, 328 assertions
```

The frontend still has no test runner. To check the client tree compiles, run it
through the project's own Babel config:

```bash
node -e "const b=require('@babel/core'),fs=require('fs');
  const f=fs.readdirSync('screens/mobile').map(x=>'screens/mobile/'+x).concat(['App.js','navigation/MobileNavigator.js']);
  let bad=0; for(const p of f){try{b.transformFileSync(p,{presets:['babel-preset-expo'],plugins:['react-native-reanimated/plugin']})}catch(e){bad++;console.log('FAIL',p,e.message.split('
')[0])}}
  console.log(f.length+' files, '+bad+' failed')"
```

**Every one of R-01..R-30 is referenced by rule number** in a route, a util, a
migration or a test. That is checkable in one line and worth re-running after any
change to this area, because it is how R-11 was found missing:

```bash
cd backend && for r in $(seq -w 1 30); do   grep -rq "R-$r" routes utils migrations tests || echo "R-$r unreferenced"; done
```

`test:business` is **idempotent** and must stay so: it creates its own party,
agent and scheme member each run and branches on state that persists (a
finalised salary month, for one). A suite that only passes the first time is one
nobody trusts the second time.

`test:business` needs a live server and the seeded accounts; the other three
need only the database. `test:schema` creates and drops `kl_schema_check` and
`kl_init_check`, so it needs a user that may create databases.

Apply a migration to a database created before a schema change:

```bash
npm run migrate
```

`scripts/migrate.js` records what it has applied in `schema_migrations`, so a
migration runs once and the command is a no-op afterwards. A database created
fresh from `schema.sql` already has everything the migrations do — mark those
applied rather than running them:

```bash
npm run migrate -- --mark 001_constraints_datetime_stock.sql
```

`init-db` is for fresh databases; migrations are for existing ones. Both must
leave the same result. **The direction is: write the migration first, then
regenerate `schema.sql` from it** — the reverse of what this file used to say.
`schema.sql` is no longer hand-written, so changing it directly would be
overwritten by the next `rebuild-schema`. `npm run test:schema` is what proves
the two paths agree.

**`init.sql` is generated, never hand-edited.** It is `schema.sql` plus a `CREATE DATABASE`, a `USE`, and the migrations pre-recorded in `schema_migrations` — one standalone file for anyone who wants to run SQL rather than Node. `scripts/build-init-sql.js` writes it, and `init-db` regenerates it on every successful run, so a hand-maintained second copy of sixty `CREATE TABLE` statements can never drift from the first. `schema.sql` is itself generated now — see **`schema.sql` is GENERATED** below — so the sequence after a migration is `npm run migrate && npm run rebuild-schema && npm run build-init-sql`, and `npm run test:schema` proves the result.

Check the server is alive and can reach MySQL:

```bash
curl localhost:5000/health       # liveness — does not touch the database
curl localhost:5000/health/db    # readiness — pings MySQL, 503 if unreachable
```

**There is no linter, and no test framework.** The backend suites listed above
are plain Node scripts with a two-line `ok()` helper — there is no jest, no
mocha, and `npm test` is deliberately not defined; use `npm run test:all`. The
**frontend** has no tests at all. To check that frontend sources still compile,
run them through the project's own Babel config:

```bash
node -e "require('@babel/core').transformFileSync('App.js',{presets:['babel-preset-expo'],plugins:['react-native-reanimated/plugin']})"
```

## Invariants that span multiple files

These are the things you cannot see from any single file, and breaking them fails silently.

**An item does not have a rate. It has six, and `utils/pricing.js` is the only
place that knows how.** `pricing_type` decides how `base_price` is read and the
two readings share no columns: `list_less_disc` means base is the LIST price and
each customer type takes a discount off it; `net` means base is the NET DEALER
rate and each other type adds a markup, the dealer paying base itself. Six
generated columns would have put the derivation in the importer, where the next
person needing to quote a price outside an order would re-implement it
differently. `rateFor()` **throws** `NOT_RATE_CARDED` rather than returning zero:
5,233 of the 8,885 items in the master have no pricing type at all — they exist
in Tally with a stock balance and have never been rate-carded — and a zero rate
would let every one of them be sold for nothing while the order looked ordinary.

**The spreadsheets are the master, and they contradict the PDF in two places
that cost money.** Section 3.1 summarises agent commission as "Wire 1%, Fan 3%,
all else 10%" for both agent types; the sheet carries it per item and gives the
**builder agent 5%** where the electrician agent gets 10%. Section 3.2 says wire
counts 50% toward KL Utsav and everything else 100%; the sheet also holds a
**0.1** band covering the entire Anchor range. Read the column, never the
summary — hard-coding either would have been wrong on thousands of lines.

**`customers.customer_type` is nullable and must never be defaulted.** The type
decides which of six rates the party is billed at, so a party silently defaulted
to `dealer` is sold to at list less 52%. `POST /orders` refuses an unclassified
party with `NO_CUSTOMER_TYPE` rather than guessing, and `POST /customers`
validates the string against the six.

**`order_items` snapshots the pricing BASIS, not only the rate.** The existing
snapshot (name, hsn, rate, gst) stops a later edit to the master rewriting
history. With six rate columns behind one number that is no longer enough:
`pricing_type`, `base_price` and `price_factor` are what let anyone reconstruct
— a year later, after the sheet has been revised twice — why this line was
billed at this figure.

**R-04, R-07 and R-11 are three rules about rates and each needs its own
mechanism.** R-07: only Sonu may not *see* a rate — `items.rates`, and
`stripRates()` deletes the columns from the payload, because a rate delivered to
the device and then not drawn is still a rate delivered. R-04: only Gaurav may
*change* one — `items.pricing`. R-11: what Gaurav submits is a **request**, not a
change — `item_rate_changes`, and only an owner may approve it.

**The two rate grants are `items.rates` and `items.pricing` — siblings, never
parent and child.** Named `items.rates` and `items.rates.edit` they were parent
and child, and a grant covers everything beneath it: `items.rates` is held by
every salesman so they can quote, so it satisfied `items.rates.edit` and handed
the whole field force the rate card. In a dotted hierarchy, two capabilities that
must be independent cannot be named as parent and child. This generalises to any
grant pair added later.

**`PUT /api/items/:id` is not guarded as a whole, on purpose.** Two disjoint
groups write to an item and neither is a subset of the other: Sonu maintains the
master (`items.edit`), Gaurav the rate card (`items.pricing`). Guarding the route
on `items.edit` locked Gaurav out entirely, which made R-11 unreachable rather
than merely unimplemented. Each field group is checked against its own grant
inside the handler.

**An approved rate change applies from what the column holds NOW, not from the
value the proposer saw.** A request can sit for days. Applying `old_value` would
silently revert anything that moved in between; `applied_from` records what it
actually replaced, which is what an audit asks about. And a second pending
request for the same field supersedes the first rather than queueing behind it,
because two approvals in whichever order somebody tapped would have the second
undo the first.

**`checkins.is_late` and `is_half_day` are stored, and that is a deliberate
exception to "attendance is derived".** They are judgements against the shift
timings *as they stood that day*. Management adjusts the grace period;
recomputing last March against September's grace would silently rewrite
deductions already paid out. Everything else about a month is still derived —
no table records "present" or "absent", and an absence is still a working date
with no `checkins` row.

**Shift times are wall-clock in `BUSINESS_TIMEZONE`; check-ins are UTC
instants.** `businessTime()` converts before comparing. Reading the hour off the
stored string compares 04:40 UTC against a 10:10 IST grace and marks the entire
company late every morning. `parseServerDate()` is the same fix the client's
`utils/datetime.js` applies, on the server side.

**Three functions ask "who?", and picking the wrong one fails silently.**

  `usersWhoCan(conn, 'orders.approve')`   everyone the route would let act —
                                          'all', the exact action, OR the area.
                                          **Use this for a notification.**
  `usersWithGrant(conn, 'dispatch')`      the wildcard or that exact string.
                                          Correct for an AREA name only.
  `usersHoldingExactly(conn, 'x.y')`      that string, wildcard excluded.
                                          For assigning WORK.

The middle one was being passed dotted actions across eleven call sites, and a
grant covers everything beneath it: Manas holds `orders`, which satisfies
`orders.approve` on every route guard in the app, so asking the narrow way found
only the wildcard holders. **R-01's notification never reached the one person
R-01 is about.** Gaurav (`billing`), Sonu (`purchases`) and Damodar (`cheques`)
had the same hole.

The third exists for the opposite reason: `stock_count.post` asked the usual way
handed Yash and Manoj a daily counting task each, because `all` satisfies
everything. A duty is held by whoever was *given* it, not by whoever could grant
it to themselves.

**`config/db.js` pins `STRICT_TRANS_TABLES`, and it is as load-bearing as the
UTC hook beside it.** XAMPP's MariaDB ships non-strict, which means an invalid
enum is silently stored as `''`, an over-long string is truncated, and an
out-of-range number is clamped. A cheque written with a status the column does
not hold became `''` and dropped out of every status filter in the app,
permanently, with no error anywhere. A bug that writes a row nobody can find
again is worse than one that throws. Set per connection because the application
cannot rely on how the server it is deployed to happens to be configured.

**Renaming an enum value is a data migration, not a `MODIFY`.** Dropping a value
the column still holds turns every row holding it into the empty string. Add the
new value, `UPDATE` the rows, then drop the old one — three statements, because
MariaDB gives no way to do it in one. Migration 010 does this for the cheque
status; it is the shape to copy.

**A bounced cheque reverses the allocations too, not just the payment.** The
standing invariant says a bounce reverses the receipt it paid for. That is not
enough on its own: `payment_allocations` recorded which invoices that receipt
settled, and leaving them made the party read as paid up while the bank said
otherwise — the same disagreement, one table deeper. `reverseAllocations()` and
cancelling any cash-discount note the receipt earned are both part of it.

**R-05, R-14 and the Tally journal are acknowledgements, not verifications, and
the code says so.** The app cannot read the paper godown register and cannot make
a Tally entry. What it enforces is that the step is unskippable and attributable:
`godown_register_acks` refuses any pick on an order until the picker has stated
the SO number is written down, and `internal_transfers.journal_done_at` records
Gaurav saying he made the entry. Do not describe either as verified.

**A complete internal transfer writes no stock movement, and that is correct.**
`items.qty` is a company-wide level, not a per-godown one, so goods arriving
intact at the other premises change nothing about how much stock the company
holds. Two cancelling ledger rows would be noise in a ledger whose whole value
is that every row explains a change. A **shortfall** does write one, with reason
`transfer`, because that is real loss.

**`routes/reports.js` is the dashboard; `routes/reportsuite.js` is section 12.**
The note below about not re-adding report endpoints was written when the Reports
page had been removed; section 12 puts twelve of them back by name. They live in
their own module so the dashboard stays what it is. Every one is
permission-gated, takes `from`/`to` defaulting to today, and supports
`?format=csv`. **PDF is not implemented** and `GET /api/reportsuite` says so in
its own response.

**CSV export is not `rows.join(',')`.** `send()` in `reportsuite.js` emits a
UTF-8 BOM, or Excel on Windows reads the file as the system code page and every
party name with a non-ASCII character opens as mojibake. It also prefixes a tab
to any value starting `=`, `+`, `-` or `@`, because Excel treats those as
formulas. And it takes the column list explicitly rather than deriving it from
the first row, so an empty result still exports its headings — a file with no
header row reads as a broken export rather than a quiet month.

**Two more caches, with the same rule as `items.qty`.**
`scheme_members.qualifying_total` is a cache of `scheme_ledger` and
`utils/scheme.js` is its only writer; `invoices.amount_paid` is a cache of
`payment_allocations` and `utils/cashDiscount.js` is its only writer. Both are
checked by `npm run test:invariants`.

**FIFO applies even when the request names an invoice.** "The oldest unpaid
invoice is settled first" is the business's rule, not the operator's. Letting a
receipt be pointed at a chosen invoice is exactly how a party's oldest debt
stays oldest while the cash discount is earned on a fresh one. Without
`payment_allocations` nobody can say which invoice a payment cleared, which makes
both the cash discount (a function of the invoice's age) and the 60-day
incentive rule (a function of when a specific invoice was paid) uncomputable.

**A reversal undoes the allocations and cancels the discount note.** A cash
discount earned on a cheque that bounced was not earned. The note is cancelled,
never deleted — it was issued, and the party may already have seen it.

**R-08: `purchase_items.bill_qty` and `qty` are two fields and the second is
never defaulted from the first.** Defaulting is precisely the merge the rule
forbids: it records a count nobody made. Stock moves on what was **counted**,
and the shortage/excess flag is derived from the pair rather than accepted from
the request — a shortage the receiver could label "ok" is one nobody chases.

**`git_entries` exists before the purchase it becomes.** A bilty is recorded
days or weeks before the goods arrive, so there is no purchase to hang it on and
`purchase_id` is nullable. `purchases` and `git_entries` therefore reference each
other, which is a real FK cycle: `schema.sql` creates both and adds the closing
constraint in a trailing `ALTER TABLE`. Not `SET FOREIGN_KEY_CHECKS = 0`, which
would also have silently accepted a genuinely malformed constraint.

**`schema.sql` is GENERATED. Do not hand-edit a CREATE TABLE in it.**
`scripts/rebuild-schema.js` writes it from a migrated database; the prose above
each table is hand-written and carried across on every regeneration, so that is
where to explain a table. This exists because `init-db.js` applies `schema.sql`
and then marks **every** migration as applied — so a migration adding a column
`schema.sql` lacks produces a new database missing that column *and* convinced
the migration has run. Nothing fails at install; it surfaces weeks later as
"Unknown column" from a route nobody touched. After any migration:
`npm run migrate && npm run rebuild-schema && npm run build-init-sql`, and
`npm run test:schema` proves both fresh-install paths match.

**`schema.sql` carries two sets of reference rows, and only two.** The shift
timings and the cash-discount ladder. A database without them marks nobody late
and pays no discount — broken, not empty. They are rows rather than constants
because management adjusts them. Anything else belongs in a seed script.

**`alert_log` is what stops the sweep repeating itself.** Eleven rules in
section 13 fire because something did *not* happen by a deadline, the sweep runs
hourly, and a restart re-runs it. One row per (rule, subject, day) with the
uniqueness doing the work — one table instead of a dozen `*_alerted_at` columns,
and it cannot be forgotten on the next rule added.

**The two spreadsheets are read-only inputs and nothing writes to them.**
`KL_APP_RATES_markups_3.xlsx` and `LEMAC_Developer_Master_v7.xlsx` are the
business's own documents; `scripts/import-rates.js` opens them and never writes.
If a new rate card arrives, it replaces the file and the importer is re-run — the
app is not the master of that data and must not become it.

**Tally documents go through an OUTBOX, never a direct call.** Tally runs on an
office desktop that is closed at night. A push inside the invoice transaction
would either fail the invoice — refusing to bill because an accounting package is
shut — or lose it silently. So every syncable event writes a `tally_queue` row in
the same transaction as the business fact, and a worker drains it. "Real-time"
means the worker runs continuously, not that an HTTP call blocks a salesman.

**Every Tally voucher carries a REMOTEID derived from our own document id.** That
is what makes a retry an amendment rather than a duplicate. Without it, retrying
a push that timed out *after* Tally had committed produces two invoices for one
sale and the month never balances again. It is the single most important property
of the sync.

**Tally answers HTTP 200 for a rejected import.** The outcome is inside the XML,
in CREATED, ALTERED, ERRORS and LINEERROR. `interpret()` in `utils/tally.js`
reads those. Treating 200 as success is how you build a sync that reports
everything fine while importing nothing — and "created and altered nothing, with
no error" almost always means `TALLY_COMPANY` does not match the open company,
which Tally answers by doing precisely nothing.

**Tally's stock and balance figures are RECONCILED, never applied.** Section 14
asks for both to flow Tally to app. Writing them into `items.qty` or
`customers.closing_balance` would break the invariant that both are caches of
*our own* ledgers, and after one pull no figure in the app could be explained
from its own movements again. A pull lands in `tally_reconciliation` as a
comparison; a variance is a finding for a person. This is the one place section
14 is interpreted rather than followed literally, and the reasoning is in
`utils/tally.js` and in the endpoint's own response.

**Nothing about Tally is bidirectional per record.** We author documents; Tally
authors masters. That is what removes the need for conflict resolution — there is
no "last write wins" anywhere, because no record has two authors. Do not add a
flow that makes one.

**`TALLY_ENABLED` and `GEOCODE_ENABLED` are both off by default, for different
reasons.** A half-configured Tally sync pushing documents into the wrong company
is worse than no sync. Reverse geocoding means sending an identified employee's
coordinates to a third party in an app that already tracks named people
continuously — that is a decision for the business, with a named provider, not a
default a backend chooses because a requirement contains the word "geocoded".

**PDF export lives in one `send()` branch, and the columns come from the CSV
definition.** A report cannot end up supporting one format and not the other, and
the two exports of one report can never list different columns. Streamed, never
buffered: a stock report over 8,900 items held in memory to measure its length is
how a report endpoint takes the process down.

**The invoice prints as three copies in ONE PDF.** Section 4.5 wants Original,
Duplicate and Triplicate. Three separate downloads would let somebody print two,
and the whole point of the Duplicate is that it comes back signed. R-21 holds in
the PDF and in the Tally voucher the same way it holds in the billing route:
neither reads an agent or commission column, asserted by the test suite against
the generated output.

**A salary slip exists only for a FINALISED month.** A draft recomputes on every
read, so a slip taken from one would be a different document tomorrow — and a
payslip that changes after it is issued is worse than none. A waived deduction
stays on the slip; hiding it would make the arithmetic look wrong.

**A declaration and a count are two rows, not one.** Section 8's handover and
R-08's purchase quantities are the same shape of rule: the person bringing
something in declares, the person receiving it counts, and the received figure is
never defaulted from the declared one. Defaulting records a count nobody made,
and the declaration is the only evidence a shortfall existed.

**The Lemac growth schemes are SEEDED INACTIVE and must stay that way until
somebody activates one.** They are the only thing in the spreadsheets that
`KL_App_Requirements_FINAL.pdf` never mentions, and activating one starts
accruing money against every dealer invoice. `POST /api/schemes/:id/activate` is
a decision somebody takes; a seed script must never flip it.

**A growth scheme and KL Utsav are different shapes and share no code.** KL
Utsav accrues to a PERSON, cumulatively, over one window, and pays a fixed gift.
A growth scheme accrues to a DEALER, per window, RESETS each window, and pays a
PERCENTAGE of that window's billing. `utils/scheme.js` and
`utils/growthScheme.js` are separate for that reason; merging them would mean
one set of branches deciding which kind it is on every call.

**EARNED and RELEASED are two states, and the Lemac sheet is why.** "Released
only after full payment of the goods." The slab is reached on billing; the money
is payable only once the invoices behind it are settled, measured on
`invoices.settled_on` — the same notion of "paid" the cash discount and the
60-day incentive rule use. An award already released is never dragged back to
earned by a later invoice in the same window.

**Only dealers accrue on a growth scheme.** The slabs are dealer billing figures
sitting on the "List less 52%" ladder, which is the dealer column. A retail or
builder sale is not dealer billing, and `creditInvoice` returns early on it.

**Tally keys MASTERS on NAME and VOUCHERS on `REMOTEID`.** Ledgers and stock
items carry no REMOTEID and do not need one — `ACTION="Alter"` on the same NAME
amends. The consequence, which is a known open item rather than an oversight:
**renaming a party in this app creates a SECOND ledger in Tally**, because the
new name matches nothing. `tally_links.tally_name` records what we last told
Tally, which is what would detect it.

**A queued payload is frozen, and `.env` cannot correct it.** `SVCURRENTCOMPANY`
is inside the XML stored at enqueue time — deliberately, so a document reaches
Tally as it was when the event happened. So fixing `TALLY_COMPANY` does NOT fix
documents already queued; they have to be re-enqueued. This was found by a test
that tried to simulate a wrong company by changing the environment and watched
the push succeed.

**`GET /api/workflow/orders/:id/verifysheet` exists because Ajit could not see
what he was counting.** Section 4.4 has him counting every picked item, and the
pick sheet is gated on `picking.view`, which he deliberately does not hold. It
counts against the PICKED quantity, not the ordered one: a short pick is meant
to bill short, so counting against the SO would flag every short pick as a
mismatch and bury the real ones.

**A scheme's cycle is editable; what it MEASURES is not.** `PUT
/api/schemes/:id` moves the window, because the Lemac sheet asks for it —
"App should allow validity dates to be updated each cycle" — and a monthly
scheme whose end date passes silently stops accruing. `kind`, `period` and
`item_flag` are refused: changing them while awards exist would leave those
awards computed on one basis and displayed on another. Moving a non-renewing
scheme's start date is refused once dealers have accrued, because the window key
IS that date.

**The two optional photographs are optional, and the four mandatory ones are
not.** Sections 4.1 and 4.3 say "Optional" and "provides the option"; R-06 names
delivery, purchase receiving, attendance and the cheque deposit slip, and all
four are enforced. Do not "tidy" the optional pair into required — and do not
relax the mandatory four.

**Timestamps are UTC by contract.** `config/db.js` sets `dateStrings: true` and issues `SET time_zone = '+00:00'` on every pooled connection; the schema uses `DATETIME` everywhere and **never `TIMESTAMP`**. The two halves depend on each other — `TIMESTAMP` is silently converted against the session time zone, so a single `TIMESTAMP` column reintroduces exactly the drift the pool hook exists to prevent (and caps out in 2038). If you add a point-in-time column, it is `DATETIME`.

**`items.qty` is a cache, not the truth.** The source of truth is `stock_movements`, an append-only ledger of signed `change_qty` rows. `items.qty` must equal `SUM(change_qty)` for the item and is maintained in the same transaction as the movement row. Never `UPDATE items SET qty` on its own. Corrections are new `adjustment` rows, never edits or deletes — `ref_type`/`ref_id` are deliberately not foreign keys so cancelling an order does not erase the movement history it produced. The recompute query is in the `items` comment in `schema.sql`.

**Attendance is derived, never stored.** A `checkins` row is one employee-day, uniquely keyed on `(employee_id, checkin_date)`. A *missing* row is the absence. Any attendance calculation is `checkins` against the working calendar minus `holidays`. There is no attendance table and there should not be one.

**Present days are counted against the same calendar absences are.** `/monthly-summary` builds one list of working dates and counts a check-in as present only if its date is in that list; a Sunday or holiday shift is reported separately as `extra_days`. Counting every check-in as a present day let a Sunday cancel out a missed Monday, so 26 check-ins against 26 working days reported zero absences for someone absent four times.

**The service day is the business day, not the UTC day.** Instants are UTC; the *calendar day* a check-in belongs to comes from `utils/businessDay.js`, which formats in `BUSINESS_TIMEZONE` (default `Asia/Kolkata`). `new Date().toISOString().slice(0, 10)` is a day in London: it filed an 05:15 IST check-in under yesterday, collided with the row already there, and freed the unique key at 05:30 IST rather than midnight. Any route that decides "today" uses `businessDay()`, and any route reading a date from a query string uses `requestedDay()`.

**Shifts are closed by the server, not by hope.** `utils/autoCheckout.js` closes any shift from a previous service day at `AUTO_CHECKOUT_TIME` and sets `is_auto_checkout`. `server.js` runs it hourly; `scripts/auto-checkout.js` is the same logic on demand. Without it a forgotten check-out left the employee permanently "Active" on the live map and the day with no computable length.

**The client reads timestamps through `utils/datetime.js`.** The API returns MySQL DATETIME strings verbatim (`2026-08-26 05:28:47`), which JavaScript parses as *local* time — so every displayed time was 5½ hours early. `parseServerDate` appends the `Z`. Nothing calls `new Date(value)` on an API string directly, and `addDays`/`dayOfWeek` do calendar arithmetic on the string rather than via UTC midnight.

**`order_items` snapshots the item — from the item master, not from the request.** `item_name`, `hsn`, `rate` and `gst_percent` are read inside the order transaction with `SELECT … FOR UPDATE` and copied at write time, so later edits to the item master never rewrite order history *and* a crafted request cannot book stock at a price it chose. Quantity, discount and scheme are the salesman's to set; the rate is not. When displaying a historical order, read these columns — do not join back to `items`.

**`scheme` is recorded, not applied.** It is stored on the line for reporting on what was promised in the field and is deliberately excluded from the total: scheme here means free goods agreed separately, not a second discount percentage. If that is ever wrong, it is a pricing decision, not a bug to quietly fix.

**Cancelling an order returns its stock.** `PUT /orders/:id/status` writes opposing `adjustment` movements for every line and recomputes `items.qty`, in the same transaction as the status change; reinstating takes the stock again. The ledger is append-only, so this is a new row, never an edit to the original movement.

**A no-order visit is `is_no_order`, not a cancelled order.** Both live in `orders`, but the flag is what the dashboard counts as an unproductive visit. Reusing status `'cancelled'` made a genuinely cancelled order indistinguishable from a visit that produced nothing, so every cancellation was reported as an unproductive visit and dropped out of sales.

**`customers.closing_balance` is a cache, exactly like `items.qty`.** It equals issued invoices − receipts − *issued* credit notes, and is only ever written by `recomputeBalance()` in `utils/workflow.js`, inside the transaction that moved one of those. Before payments existed the column was read all over the app and written by nothing, so every outstanding figure was whatever had been seeded. A *pending* credit note deliberately does not move it — until issued, the credit is not yet money the party may set against their account. **`npm run recompute`** rebuilds both caches from their ledgers; `--dry-run` reports drift without writing. Needed after any change that adds a new input to a cache — adding the payments table left older invoices with a balance nobody had computed.

**A bounced cheque reverses the receipt it paid for.** `routes/cash.js` reverses any payment carrying that `cheque_id` and recomputes the balance in the same transaction. Without it the ledger says paid while the bank says otherwise, which is the one disagreement a cash book must never have. A reversal is a status change, never a delete: the money arrived and was then returned, and both are facts.

**Pipeline duties can read every order; that is not the `orders` area grant.** `worksThePipeline()` in `routes/orders.js` lets anyone holding `picking`, `verification`, `billing` or `dispatch` read orders somebody else raised — without it Ajit could not open the order he was asked to count, and the pipeline simply stopped. It is deliberately separate from the `orders` area grant, which also widens the dashboard to company-wide figures: needing to read a line item is not a reason to show a picker the branch's sales.

**Delivery photos are served through an authenticated route, never a static mount.** `routes/attachments.js` writes to `backend/uploads/` (gitignored) under a random 32-hex name and serves by exact name match. These are photographs of identified people's premises; a public `/uploads` directory would make the whole delivery history readable to anyone who guessed a filename. Uploads arrive as base64 in JSON because that is what `expo-image-picker` already produces, and the mime type is allow-listed so a request cannot have its upload served back as markup.

**The app is desktop-first and responsive; `components/mobile/Screen.js` is the only place that knows which.** Three shells off one breakpoint set (`hooks/useBreakpoint.js`): phone under 768 gets the navy header and a bottom tab bar, tablet gets the same at a 720pt measure, desktop from 1024 gets a navy sidebar beside a content column capped at 1440. Screens never branch on width — they take a `nav` *descriptor* and pass it through, which is why the whole app was turned from phone-first to desktop-first without editing any of the thirty-two of them. Anything that needs to know asks `useBreakpoint()`.

**`nav` is a descriptor, and every screen must both destructure it and forward it.** A screen that forwards `nav={nav}` without taking `nav` in its props throws *"nav is not defined"* at render — caught on `SalesmanDashboardScreen`, whose multi-line signature a single-line rename had missed. `onTab` rides inside the descriptor rather than being decided by the navigator: the phone hides its bar on a pushed screen so a half-filled form is not abandoned by a stray tab tap, while the desktop keeps the rail, because a full window with no navigation reads as having lost its way.

**Header, content and footer share one left edge on desktop by padding *inside* their own max width, never outside it.** Padding the header outside its cap put the page title 22px left of every card it labelled. Desktop footer actions are additionally capped at 420 and right-aligned — a confirm button stretched across 900px is a cursor journey and reads as a banner rather than a control.

**Tabs come from grants, not from a role name.** `constants/roles.js` builds each account's four tabs from what it can actually do, so revoking a grant removes the tab. Keyed carefully: the salesman dashboard hangs off `estimates.create`, not `orders.create`, because the `orders` area grant satisfies the latter and handed Manas a salesman's dashboard for being able to approve. A driver holds almost nothing — every route they use is scoped to `req.user.id` — so `looksLikeDriver()` identifies them by the *absence* of duty grants.

**`npm run dev` at the root is a bootstrap, not just Expo.** `scripts/dev.js` runs `scripts/setup.js` first, then spawns the API and Expo as labelled children. Two consequences. **Every step in `setup.js` must stay idempotent and quiet when there is nothing to do**, because it runs on every single `npm run dev` — a step that re-seeds, re-imports, or prints a wall of output on the hundredth run is how people stop using the command. And **it must never exit with a stack trace**: it is the first thing somebody sees after unzipping, so each failure names the fix instead, which is what `stop(problem, ...fixes)` is for. `npm run app` is Expo alone, which is what `npm run dev` used to mean.

**Spawning npm from Node needs a shell on Windows, and a shell means one command string, not an args array.** npm is a `.cmd`, and Node has refused to exec one directly since CVE-2024-27980 — `execFileSync('npm.cmd', [...])` fails with `EINVAL`. But passing an args array *together with* `shell: true` is deprecated (DEP0190), because the args are concatenated unescaped. So both root scripts build a single quoted string. Ctrl+C additionally has to kill the whole tree: `node --watch` spawns a child of its own, and killing only the shell leaves an orphan holding port 5000, so the next `npm run dev` dies on `EADDRINUSE` with nothing explaining why. `taskkill /T` on win32 is what actually clears it.

**`setup.js` seeds with a shared development password on purpose, and that is the one place it is right to.** It passes `--password` explicitly, which is the documented opt-out from migration 015's generate-and-force-change behaviour. The reason is specific: the whole point of this codebase's permission model is that nine accounts see nine different apps, so a developer signs in as nine people to check it — and being made to invent nine passwords first is where somebody gives up before seeing it work. It prints the password every run, never hides it, and refuses to run at all under `NODE_ENV=production`.

**The tab bar is a budget of five, and a screen that does not win a slot is linked, never dropped.** `MAX_TABS` is 5 and two go to Alerts and Profile, so an account gets three duty tabs. The nine screens added in August 2026 take none of them: pay is looked at once a month and the Tally console when something is wrong, while every one of the three slots is already held by something done hourly. Salary, advances and the incentive hang off Profile; GIT and transfers off Purchase; the handover off both EOD and the salesman's day, because both ends of it need the screen; reports, the R-11 queue and Tally off the owner's dashboard. Adding one to `ALL_TABS` does not add a slot — it evicts whatever was third.

**A pushed screen hides the phone's tab bar, so it must carry its own back link.** `TAB_SCREENS` in `MobileNavigator.js` lists the routes that are a tab's own; anything else sets `onTab: false`, and the phone shell then draws no bar — correct, because a half-filled form should not be abandoned by a stray tab tap, and fatal if the screen has no `onBack`. Every pushed screen takes `onBack` from `shared` and passes it to its `ScreenHeader`. A screen with two levels passes its own handler at the inner level and `onBack` at the outer — `TransfersScreen` is the worked example.

**The role descriptor carries the capability flags, and each one mirrors a named server predicate.** `MobileNavigator` computes `managesSalary`, `approvesLeave`, `approvesIncentives`, `approvesRates`, `movesGoods`, `journalsTransfers`, `countsCash`, `seesReports` and `runsTally` once, from `userCan`, and hands them down on `role`. Nine screens each spelling out their own grant check is nine places for the client copy of the permission rules to drift from `backend/utils/permissions.js`. **None of them is a security boundary** — every route is guarded server-side — they decide whether a control is *drawn*, so a picker is not shown an Approve button that can only ever 403. Add a flag here rather than a `userCan` call in a screen, and name it after the server function it mirrors.

**A `serverOnly` page in `constants/permissions.js` is a grant with no screen, and `showroom` is the only one left.** The flag exists so nobody hands out a grant expecting a tab to appear. Five were dropped in August 2026 as their screens landed, and each page key now names a real route in `MobileNavigator`. `showroom` keeps the flag permanently: it opens no screen by design — it marks who the shared incentive pool pays, which `routes/incentives.js` reads when it splits a showroom segment. Do not add a page here whose grant the server never checks; the R-11 rate queue deliberately has none, because reading it is `items.rates` and deciding is the wildcard.

**Tally keys ledger masters on NAME, so a rename is an `Action="Alter"` carrying `NAME.LIST`.** Pushing a renamed party as an ordinary master creates a *second* ledger and splits the balance across two accounts that both look correct. `ledgerMasterXml()` in `utils/tally.js` looks the ledger up by `tally_links.tally_name` — what we last told Tally it was called — and sets the new name through `NAME.LIST`. The link is updated only after Tally accepts, so a failed push leaves it pointing at the name Tally still holds. Vouchers are different: they carry `REMOTEID` and are idempotent on it. A stand-in that matches masters on REMOTEID will pass this test while being wrong, which is how the bug was found.

**The return penalty is a capability that is off, not a rate that is zero.** `items.return_penalty_percent` is `NULL` on every row and nothing in the import sets it, so every return credits in full exactly as it did before migration 014. NULL and `0.0000` are deliberately different: the first says nobody has decided, the second says somebody decided none. The source is the Lemac sheet, not the requirements PDF — §5.5 describes returns in detail and mentions no penalty — so switching it on is a business decision, and the statement that does it is in the migration's own comment. `sales_return_items` keeps `amount` (what came back) apart from `credit_amount` (what the party gets), because one column holding 800 cannot answer "what came back?".

**`tests/api-coverage-test.js` is what keeps `services/endpoints.js` honest.** It walks every route the server mounts and asserts each is either bound by the client or excused with a written reason, and it catches the opposite fault too — a binding pointing at a route that no longer exists. Currently 194 endpoints, 191 bindings. Add a route and the suite fails until you bind it or say in the excuse list why not; that is the point, because an endpoint nothing calls is either dead code or a screen somebody forgot.

**The order pipeline is a state machine, and `order_events` is why `orders.status` can be trusted.** `utils/workflow.js` owns the transition map; a stage change goes through `transition()`, which writes the new status *and* an append-only event row in the same transaction. An order can therefore never be found in a stage no event explains. An illegal jump — `picking` straight to `delivered`, skipping the count R02 makes mandatory — is refused by default rather than by remembering to guard it, and `expectedFrom` makes two people approving the same order fail the second time with `409 STALE`.

**`confirmed` is a synonym for `pending`, not a terminal stage.** `POST /orders` sets `confirmed` when the creator holds `orders.confirm` — which every admin does — so an admin-raised order arrives already confirmed. Treating that as terminal stranded those orders outside the pipeline entirely: never pickable, billable or deliverable, with nothing saying why. Both spellings transition to `approved`; approval still has to happen.

**The invoice bills what was counted, not what was ordered.** `routes/invoices.js` reads `COALESCE(v.counted_qty, oi.qty)` from `order_verifications`, so a short pick bills short. That is the entire reason the count happens before billing. Verification is enforced at the route (`409 NOT_VERIFIED`), not only in the UI.

**Nothing in the billing path reads `agents` or `agent_commissions`.** Agent identity and commission stay off the printed document (R21) — the party must not see what their agent is paid. The guarantee is structural: `routes/invoices.js` has no reason to join those tables, so it does not. Do not add a join "for reporting".

**A delivery needs a name and a photo, checked server-side.** `routes/dispatch.js` refuses both omissions (`400 PHOTO_REQUIRED`). There is deliberately no signature column: a signature scrawled on a phone proves nothing about who held it, and chasing one at a shop counter is what made drivers skip proof entirely. Delivery routes are scoped to `req.user.id` as the driver, so a driver closes their own stops and nobody else's.

**`middleware/params.js` guards every numeric path parameter.** `Number('abc')` is `NaN`, and mysql2 renders a bound `NaN` as the bare token `NaN` — so `WHERE id = NaN` reached MySQL and came back *"Unknown column 'NaN' in 'where clause'"*: a 500 quoting our schema, in answer to a bad request. `numericId(router)` runs once per router via `router.param`, so it cannot be forgotten on the next route added.

**`lines` is a reserved word in MariaDB.** This project runs against MariaDB (XAMPP locally), not MySQL proper. `COUNT(...) AS lines` is a syntax error there; the alias is `line_count`. Check aliases against MariaDB's reserved list, not MySQL's.

**Permission pages carry their own action sets.** The pipeline duties are not view/create/edit/delete — `picking.record`, `dispatch.build`, `eod.close`, `stock_count.post` — so `constants/permissions.js` gives each page an optional `actions` array and `actionsFor(page)` is what the grid must read. A fixed four-column grid could not offer those grants at all, and a grant the UI cannot offer is one nobody ever gets.

**`users.permissions` is a JSON array** matched by `userCan()` in `utils/permissions.js`: `["all"]`, `["items"]`, or `["items.create"]`. A grant covers everything beneath it, so `"items"` satisfies `"items.create"` but not the reverse. **`role` is deliberately not consulted** — permissions are the only source of authority, so revoking a grant actually revokes the ability.

**Every route is guarded, including the ones that only read.** `orders`, `customers`, `items` and the reports module took `authenticate` alone until 2026-08-26, which meant an account granted nothing at all could read every order, the whole customer list, and — through the since-removed `/reports/location-audit` — the complete GPS trail of any colleague, straight past `live_tracking.view`. Two things are deliberately ungated beyond `authenticate`: the caller's own shift actions, and `/reports/dashboard`, which scopes itself to the caller unless they hold the `orders` **area** grant.

**`routes/reports.js` is the dashboard and nothing else.** The Reports page was removed on the user's instruction, and its four other endpoints — customer groups, onboarding log, ledger, GPS audit trail — went with it. The GPS trail is still readable on the Live Tracking page under the same `live_tracking.view` grant.

That rule still holds for *this* module. Section 12 of the August 2026 document then specified twelve reports by name, and those live in `routes/reportsuite.js` — a separate module, so the dashboard is not gradually turned back into a reports page. The screens for them are not built yet, which is why the grants are flagged `serverOnly` in `constants/permissions.js`; do not add a thirteenth endpoint there without a requirement naming it.

**An area grant means "everyone's", an action grant means "your own".** `userCan(user, 'orders')` is true only for the area grant or the wildcard, because a one-segment check cannot be satisfied by `orders.view`. That is the whole mechanism behind a salesman seeing their own order book while a supervisor sees the branch — and the dashboard reads the same grant, so one account gets one consistent scope rather than two.

**`role` is writable only with `employees.permissions`.** `userCan()` still ignores role, but the client does not — the live map filters on `role = 'employee'` — so leaving it under `employees.edit` let anyone who could fix a typo promote an account. Nobody can change their own role.

**There is no bulk-delete route.** `checkins` and `location_logs` cascade from `users`; a `DELETE FROM users WHERE role = 'employee'` destroys every attendance record and GPS ping the company holds. Offboarding is `is_active = false`, which is honoured on every request and can be undone.

**A password a script or an administrator chose is temporary, and `authenticate` is what makes that true.** `users.must_change_password` (migration 015) is set by the two seed scripts, by `POST /api/users` and by an admin password reset in `PUT /api/users/:id` — every path where somebody other than the owner picks the value. While it is set, the middleware refuses every request except `GET /api/auth/me` and `PATCH /api/auth/change-password`, and only a real password change clears it. Enforced in the middleware rather than per route for the same reason `numericId(router)` is: a check that must be remembered on the next route added is one that will eventually be forgotten, and forgetting this one silently reopens the hole. **403, never 401** — the credentials were good, and a 401 sends the API client's interceptor into a sign-out loop that throws the user off the only screen that can fix it.

**No password literal belongs in the repository, including in a seed script.** `seed-roles` and `seed-business` shipped one shared value for every staff account; it was found live on 22 accounts, `yash` among them. They now mint a distinct random password per account through `generatePassword()` in `backend/utils/password.js` and print it once — nothing stores it, and re-running cannot recover it. `--password X` still forces one shared value because the test suites need something to put in `SEED_PASSWORD`, and that path deliberately does *not* set `must_change_password`: a password a person typed is a password a person chose. `scripts/secure-accounts.js` is what finds accounts still on a burnt value, and its list of known-burnt strings is meant to grow, never to shrink.

**The login screen carries no list of accounts, in any build.** It had tap-to-fill chips for the nine seeded roles; they held no password — they filled the username box — but a roster of valid usernames under the form undoes what `/auth/login` does deliberately: one identical body for an unknown id, a wrong password and a deactivated account, plus a bcrypt compare even when no user was found so the timing matches. All of that exists to avoid confirming which accounts are real, and the placeholder is a generic "Your username" for the same reason rather than naming a real one. Gating the chips behind `__DEV__` was the first attempt and was rejected on sight — the person setting this up is looking at a dev build, so that is exactly who still sees the roster. **Do not add it back in any form.** Test logins belong in `OPERATING-GUIDE.txt` §2.12, which is a file somebody chooses to open, not a screen shown to whoever loads the page. Removing them left `ROLE_ORDER` in `constants/roles.js` dead, so that went too; `ROLES` stays because `titleFor()` reads it after sign-in.

**One password policy, in two copies.** `backend/utils/password.js` decides; `utils/password.js` is the client duplicate that tells the form before the round trip. Minimum 8 characters, with a short list of common values refused outright, applied identically by `create-admin`, `POST /api/users`, `PUT /api/users/:id` and `change-password`. There is no default password anywhere — a blank field is an error, not `password123`.

**`utils/permissions.js` is a deliberate duplicate of `backend/utils/permissions.js`.** Metro's blockList keeps `backend/` out of the bundle, so the client cannot import the server copy. The client version exists only to hide controls the server would refuse anyway — it is not a security boundary. Change the matching rules in one and you must change the other, or the UI starts offering actions that 403.

**Route guards are per action, not per router.** `employees.view` and `employees` are not interchangeable: an area grant satisfies an action check, never the reverse. A router-level `requirePermission('employees')` therefore locks out every account holding only `employees.view`, which is why `routes/users.js` guards each route separately. The pages and actions the admin UI can grant are listed in `constants/permissions.js`; a page named there must exist as a route in whichever container renders it — `navigation/MobileNavigator.js` for the live app, `navigation/RootNavigator.js` for the old web panel — or the grant buys nothing. (`MainAppContainer` is the name this rule was first written against; it has since become `RootNavigator`.)

**Attendance self-service is not permission-gated.** `/attendance/today`, `/checkin`, `/checkout` and the lunch pair act on the caller's own employee-day and take `authenticate` alone. `RootNavigator` calls `/today` for everyone at launch, so gating them on `attendance.view` locks ordinary field staff out of starting a shift. The `attendance.*` grants cover only the routes that read or write *other* people's records.

**The check-in gate is for a day not yet started — not for a day already finished.** `RootNavigator` shows it only when `/today` returns no row. Re-showing it after check-out trapped the user behind an undismissable modal whose only button could return nothing but "already checked in for today". The gate also carries its own sign-out, because someone who cannot get a GPS fix must still be able to leave.

**`POST /location/log` only accepts a ping during an open shift**, and answers `409 NOT_ON_SHIFT` or `ON_BREAK` otherwise. The background task stops itself on the first of those — it has no other way to learn the shift ended. The API client turns the same codes into a `setShiftEndedHandler` callback so the navigator can refresh.

**Auth re-reads the user on every request.** The JWT carries `sub` and nothing else that is trusted; `authenticate` loads the row and checks `is_active` per request. This is why deactivating a user takes effect immediately instead of whenever their token happens to expire — verified. Do not "optimise" this into trusting token claims.

**The API client owns the token, not storage.** `services/api.js` holds it in a module variable that `AuthContext` pushes to, because an interceptor cannot await `AsyncStorage` without adding latency to every request. `setUnauthorizedHandler` is the same listener pattern as `services/confirm.js`, and exists for the same reason — an interceptor runs outside the React tree and needs a way back in.

## Frontend conventions

- **`AppText` is the only text primitive.** It resolves `weight` and `size` through `constants/typography.js`. The four font aliases (`AppFont-Light/Regular/Medium/Bold`) are registered in `App.js` via `useFonts` and mapped in `TYPOGRAPHY.fontFamily` — the alias names must match in both places or text falls back to the system font.
- **Colors come from `constants/colors.js`.** No literal hex in components.
- **`AppText` warns in development on an unknown `size` or `weight`** rather than silently falling back to 18px and the system font, which is how four dashboard headline figures ended up the same size as their own captions.
- **There is no offline fallback in `services/api.js`, and there must not be one behind an error handler.** It used to answer any network error, timeout, 404 or 503 from a mock backend built into the file — including `/auth/login`, which it answered without checking the password, returning a seeded administrator holding `["all"]`. An unreachable server signed anyone in as an admin, and a slow check-in "succeeded" into AsyncStorage while the sheet recorded an absence. If offline order-taking is wanted it belongs in an explicit queue with UI that says what is pending. The re-add path for `client_ref` is in the `orders` comment in `schema.sql`.
- **A failed GPS fix is an error.** `getCurrentLocation()` throws; it used to return Mumbai's coordinates, which the check-in screen then rendered as "GPS Fixed ✓, ±10 m" and wrote into the attendance record of a Guwahati business.
- **Background tracking does not exist on web.** `BACKGROUND_TRACKING_SUPPORTED` says so, `startLocationTracking()` returns `{ started, reason }`, and `describeTrackingState()` turns a reason into a sentence for the user. The failure used to be swallowed while the UI announced "Live GPS tracking activated" — which is why `location_logs` held five rows after two weeks, every one of them written by a check-in event rather than the task.
- **`components/LeafletMap.js` takes `title`/`subtitle`, not HTML.** Marker data carries names out of the database; they are escaped into the page and set on the popup as a DOM node. `JSON.stringify` is not an HTML escape — a name containing `</script>` ends the block.
- **Never call `Alert.alert` directly.** `react-native-web` implements it as `static alert() {}` — an empty function — so on the web admin panel a confirm dialog never appeared and the destructive action inside its button callback never ran. Use `confirmAction`/`showAlert`.
- **`services/confirm.js` holds a module-level listener** that `<AlertHost />` (mounted once at the app root) subscribes to. This is why `showAlert()` and `confirmAction()` are callable from axios interceptors and other code outside the React tree. On native it delegates to `Alert.alert`; on web it renders the styled modal, falling back to `window.confirm` only if no host is mounted.
- **`utils/search.js` normalizes every list-screen query.** It strips a defined noise set (whitespace, `-_./` and friends) rather than allow-listing ASCII, so non-Latin names and codes like `WIRE-2.5` still match. Use `isSearchActive()` for the minimum-length gate instead of comparing lengths inline.
- **`metro.config.js` blockList patterns must use `[\\/]`, not `/`.** Development happens on Windows, where these are tested against backslash-separated absolute paths. A forward-slash-only pattern silently matches nothing and lets Metro watch `backend/`, which causes a hot-reload loop.

## Server notes

- **Express 5**, not 4. Rejected async handlers forward to the error middleware automatically, and path-to-regexp v8 rejects a bare `'*'` path — the 404 handler is an `app.use` fallback for that reason.
- **Graceful shutdown is not optional here.** `node --watch` restarts on every save; without `server.close()` plus `pool.end()`, pooled MySQL connections leak on each restart until MySQL refuses new ones.
- **Windows has no POSIX signals.** `kill -TERM` from Git Bash calls `TerminateProcess`, so the shutdown handler never runs and a test of it looks like a silent failure. Ctrl+C works (Node emulates SIGINT); to exercise the handler programmatically, `process.emit('SIGTERM')` in-process.
- **CORS defaults to `*`** because the Expo client's origin differs per target — a LAN IP on device, localhost on web. Set `CORS_ORIGIN` to an explicit list before deploying.
- **HS256 is pinned on both sign and verify.** Without an explicit `algorithms` list, `jsonwebtoken` trusts the token's own header, which is how `alg: none` and RS256→HS256 confusion work. A forged `alg: none` token is rejected — verified.
- **Login failures are deliberately indistinguishable.** Unknown ID, wrong password and deactivated account all return the same 401 body, and a bcrypt compare runs even when no user was found so the timing matches. Do not add a helpful "no such user" message.
- **On device, `localhost` is the phone.** `services/api.js` derives the API host from `Constants.expoConfig.hostUri` — the machine that served the bundle — and swaps in port 5000. `EXPO_PUBLIC_API_URL` overrides it.

## Schema conventions

Applied uniformly; follow them when adding columns.

| Kind | Type |
|---|---|
| money | `DECIMAL(15,2)` |
| quantity | `DECIMAL(15,4)` |
| percent | `DECIMAL(5,2)` |
| latitude | `DECIMAL(10,8)` |
| longitude | `DECIMAL(11,8)` |
| point in time | `DATETIME` |

Prefer a database constraint over an application check. `create-admin.js` inserts and catches `ER_DUP_ENTRY` rather than running a `SELECT` first, because a check-then-insert cannot be made race-free.

## Deliberate exclusions

`schema.sql` is a port of an older project and documents what was dropped: Tally sync (`sync_status`, `tally_*`), beats (`beat_id`), the offline order queue (`client_ref`), and a `temp_password` column that stored recoverable plaintext beside the bcrypt hash. `items.masterid` and `customers.masterid` are now `AUTO_INCREMENT` rather than Tally-owned IDs with negative values assigned by a racy `MIN()` scan.

These are decisions, not oversights. Do not reintroduce them incidentally. The re-add path for `client_ref` is written into the `orders` comment.

**Tally sync is no longer an exclusion — it is built.** Section 14 of the August
2026 document asks for real-time bidirectional sync; `utils/tally.js`,
`utils/tallySync.js` and `routes/tally.js` are it, over Tally's own HTTP/XML
gateway. Read the Tally invariants above before changing any of it — particularly
the outbox, the REMOTEID, and the fact that Tally's derived figures are
reconciled rather than applied.

## Operational notes

- `location_logs` is the only table with no natural ceiling — roughly 50 rows per employee per working day. `scripts/purge-locations.js` is the retention sweep and is meant to run on a schedule (Task Scheduler here). Deleting is irreversible and these rows may matter for payroll disputes.
- App icons in `assets/` are generated from a source logo, not hand-made. `icon.png` needs a full-bleed square; `adaptive-icon.png` keeps the mark inside Android's ~66% safe zone. The current icons use the ABS logo because it is the only asset present — regenerate when a KL Electricals mark exists.
- `expo-updates` is a dependency but `updates.enabled` is `false` and no EAS project is configured. Run `eas update:configure` before enabling it.

## Regular review

The standing request, in the user's words:

> Find security vulnerabilities, conflicting codes, bugs in the code, good to have features, and code clean up. Prepare a thorough document in a markdown format with all the findings.

### Report only — do not implement

**A review produces a document and nothing else.** Do not fix what you find, not even the one-line changes, and not even findings you introduced yourself in an earlier session. Do not "just fix it while I'm here."

Write the findings up, summarise them, and stop. Implementation happens only when the user explicitly asks for it — either all of it, or named findings. "Resolve the findings" is an instruction they give; it is never implied by the review request, by a finding being severe, or by a fix being trivial.

If a finding looks urgent, say so plainly in the summary and let the user decide. Prioritising is advice; acting is theirs to authorise.

The one exception is a change the review itself requires: writing `docs/code-review-<date>.md`, and updating the link in this file. Nothing else in the tree gets touched.

### Scope and cadence

Run a full-codebase review periodically — at minimum before any release, after any batch of new routes, and whenever a session adds a new subsystem. It is not a diff review: audit the whole tree, because the findings that matter most are the ones spanning files that no single change touched.

Cover all five categories, and keep them separate in the output:

1. **Security vulnerabilities** — credentials and least privilege, secret handling, error and health-endpoint disclosure, CORS, rate limiting, headers, input trust boundaries, and platform/privacy compliance (this app does background location tracking of identified people, which is regulated).
2. **Conflicting code** — places where two parts of the repo disagree. A palette token for a feature the schema explicitly drops, an env var read but undocumented, `schema.sql` diverging from `migrations/`, a pattern applied in one file and not its sibling.
3. **Bugs** — with a concrete failure scenario: the inputs or state, and the wrong output. A finding without one is a guess.
4. **Good-to-have features** — gaps worth filling, ordered by what they unblock.
5. **Code cleanup** — dead tokens, dead dependencies, duplication.

Rules that make the output worth reading:

- **Verify before asserting.** Run the thing. Grep for it. Hit the endpoint. Mark verified findings as such, and state what was tested.
- **Record what you tested and rejected.** A plausible-sounding bug that turns out not to exist on the current runtime is valuable output — write it down so it is not raised again next time. The current document has a "Tested and rejected" section for this.
- **Do not prune dependencies by grep.** Several are required implicitly by the toolchain and import nowhere: `react-dom`, `react-native-web`, `@expo/metro-runtime`, `react-native-screens`, `react-native-reanimated`, `expo-asset`. A naive unused-import scan flags all of them.
- **Severity reflects this codebase**, not a generic scale. The API has no routes yet, so most security findings are latent — say so rather than inflating them.

Write each review to `docs/code-review-<YYYY-MM-DD>.md` and link it below. Do not overwrite the previous one; the sequence is the record of what was found and when.

Not a review, but the same kind of record —
[docs/requirements-implementation-2026-08-31.md](docs/requirements-implementation-2026-08-31.md):
the requirement-by-requirement map of the August 2026 build, what was left out
and why, and the four data gaps that block go-live. Six passes, each recorded
separately — including the three items that moved from "not built" to built, and
the reasoning that had held them back.

Latest: [docs/code-review-2026-08-26.md](docs/code-review-2026-08-26.md) — 1 Critical, 8 High, 13 Medium, plus a tab-by-tab flow analysis of both panels. **Implemented** the same day; see the status note at the top of that document for what was done and what was deliberately left.

Previous: [docs/code-review-2026-08-11.md](docs/code-review-2026-08-11.md) — 3 High, 8 Medium. Also implemented, apart from the three deployment actions listed under *Before deploying* in README.

**Status of the 2026-08-26 review: implemented on 26 August 2026** at the user's explicit instruction, except the Orders and Item Master screens, which were left as placeholders by their decision. The commits are `Baseline before code-review remediation` and the two that follow it. The 2026-08-11 findings that remained open are covered too, apart from three that are deployment actions rather than code: the MySQL `root` user, TLS, and setting `CORS_ORIGIN` — all three are in README under *Before deploying*, and the server warns about two of them at startup.

Do not assume a finding was fixed because it is old — check the code, and leave it alone unless told otherwise.

## Documentation

Write documentation as the task requires it, not by default:

- **`CLAUDE.md`** — cross-file invariants, non-obvious architecture, and commands. Update it when a change invalidates something written here.
- **`README.md`** — human setup and run instructions.
- **A task-specific `.md`** — create one when work produces something a future reader needs and the code cannot carry on its own: a migration plan, an API contract, an investigation write-up, a decision record. Put it in `docs/` and link it from here.
- **`docs/code-review-<date>.md`** — one per review, never overwritten. See **Regular review** above.

Do not create a doc that restates code, and do not leave a stale one behind — if a change makes a document wrong, fix it in the same change.
