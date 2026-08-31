# Requirements → implementation map

**Sources, all received 30 August 2026:**

| File | What it is |
|---|---|
| `KL_App_Requirements_FINAL.pdf` | 22 pages. Sections 1–15 plus the Salary/Attendance/GPS addendum. Rules R-01 … R-30. |
| `KL_APP_RATES_markups_3.xlsx` | The KL rate card. 8,519 items across 141 brands, six customer-type rate columns, per-item agent commission and scheme weighting. |
| `LEMAC_Developer_Master_v7.xlsx` | The Lemac range. 451 items, 9 categories, its own scheme regime and an Area Salesperson comp model. |

Written 31 August 2026. This document says what was built, what was built
partially, and what was not built at all — and for the last group, why.

---

## 1. Summary

The backend now implements the pricing engine, the party classification that
drives it, the full order-capture flow, geotagged attendance with shift
judgement, salary and advances, the 20-segment incentive, KL Utsav membership,
FIFO payment matching with the dealer cash discount, the five purchase forms
with Goods-in-Transit and the GST-bill countdown, estimate follow-ups, and the
time-based alert sweep.

A second pass then closed the remaining non-negotiable rules (R-05, R-06,
R-14), added §4.4 and §4.6's sign-offs and reverse-loading, all twelve reports
of §12 with CSV export, the salary slip, the quote share, and the dashboard
review stamp.

A third pass swept R-01 … R-30 for rules nothing in the code referenced. Two
were implemented but unlabelled (R-03, R-20). **R-11 was genuinely missing.**

A fourth pass closed the last of it: **Tally Prime synchronisation (§14)**, **PDF
export** everywhere §12, §7 and A.2 ask for it, the **invoice in three copies**
(§4.5), the **collections handover** to Sibu (§8), the **godown close** (§4.8),
and server-side **reverse geocoding** for the order location (D.2).

A fifth pass closed the last three items: the two **optional photographs**
(§4.1, §4.3), the **Lemac growth schemes**, and a **proving harness for the
Tally sync**.

A sixth pass took the four things listed as "not built" and closed three of
them: **rename-aware Tally masters**, a **`--doctor` preflight** for the first
run, the **Lemac return penalty** as a capability that is off until configured,
and the **nine client screens** with the API binding layer under them. What is
left needs a machine, not a decision — see §5.

**The backend is feature-complete against `KL_App_Requirements_FINAL.pdf`, and
the one thing the Lemac sheet adds beyond it is built too.**

**Verified:** 314 assertions across seven suites, all passing; every suite is
idempotent (`test:all` is run twice in a row as part of checking it); and all
thirty non-negotiable rules are referenced by name in code or tests.

```
npm run test:api           3   every server endpoint bound by the client, or excused
npm run test:pricing      54   the rate card, incl. a sweep of all 3,569 priced items
npm run test:invariants   20   caches against their ledgers, privacy, least privilege
npm run test:schema       12   schema.sql and init.sql vs the migrated database
npm run test:tally        31   the sync, against a stand-in that speaks Tally's protocol
npm run test:business    161   R-01 … R-30 driven over HTTP against a live server
npm run test:growth       33   the growth schemes, through the whole pipeline
npm run test:all               all seven
```

The client compiles too: 45 files through the project's own Babel config, zero
failures, and every endpoint call in every screen resolves to a real binding.

**The datasets were not modified.** `KL_APP_RATES_markups_3.xlsx` and
`LEMAC_Developer_Master_v7.xlsx` are byte-identical to the files received on 30
August, and no code path writes to either — `scripts/import-rates.js` opens them
read-only. The hashes are recorded here so the claim stays checkable rather than
merely asserted:

```
63e90383f8cb125d97d3b0e17a22c240a5ff973152e28d446c8abb85ab376ad1  KL_APP_RATES_markups_3.xlsx
bb768cb485f241be3fce718ac581040e86e346f3803f23f8e61177053a9ab7ff  LEMAC_Developer_Master_v7.xlsx
650dfc7961974f7d8ed62d8f2b504a68e68dffd60bfce4e2d384eb4acc7c4e49  KL_App_Requirements_FINAL.pdf
```

```bash
sha256sum KL_APP_RATES_markups_3.xlsx LEMAC_Developer_Master_v7.xlsx KL_App_Requirements_FINAL.pdf
```

Re-verified 31 August 2026, after the sixth pass.

**Two data gaps still block go-live.** They are not code problems, and one of
them Tally may now be able to fill. See §6.

---

## 2. What the spreadsheets actually say

Worth stating plainly, because two things in them contradict the PDF and the
code follows the spreadsheets.

**An item does not have a rate. It has six**, derived two different ways:

| `pricing_type` | `base_price` is | Rate for a type | Count |
|---|---|---|---|
| `list_less_disc` | the LIST price | `base × (1 − discount)` | 2,138 KL + 439 Lemac |
| `net` | the NET DEALER rate | `base × (1 + markup)`; dealer pays `base` | 1,142 KL + 12 Lemac |
| `NULL` | — | **refused** — no rate card yet | 5,233 KL |

`utils/pricing.js` is the only place this arithmetic lives. It throws
`NOT_RATE_CARDED` rather than returning zero, because 5,233 of 8,885 items are
in that state: a zero rate would let every one of them be sold for nothing and
the order would look perfectly ordinary.

**Agent commission is per item, and the PDF's summary is wrong.** Section 3.1
says "Wire 1%, Fan 3%, all else 10%" for both agent types. The sheet carries the
number per item and gives the **builder agent 5%** where the electrician agent
gets 10%. Hard-coding the summary would have overpaid every builder agent on
every line, forever. The code reads the column.

**Scheme weighting has a third band the PDF does not mention.** Section 3.2 says
wire counts 50% toward KL Utsav and everything else 100%. The sheet also holds
**0.1** — the entire Anchor range, 688 items. The code reads the column.

**Eleven items price the dealer above another customer type.** Ten Panasonic
rows give the builder 60% off where the dealer gets 55.9%; one Legrand MCCB box
does the same. Verified against the spreadsheet: the inversion is in the source,
not the import. `tests/pricing-test.js` prints them as a data note and asserts
only that fewer than 1% of the range inverts — which is what would catch a
mis-mapped discount column. **Ask Gaurav to confirm before the next issue.**

---

## 3. Built and verified

### Pricing and party classification (§3, §4.1)

- `utils/pricing.js` — the six-rate engine, per-item commission, per-item scheme
  weighting, below-cost detection, R-22 exclusivity, and which window a customer
  type opens.
- `items` gained the rate card: `pricing_type`, `base_price`, six discounts, five
  net ratios, two commission columns, `scheme_weightage`, the Lemac scheme flags,
  `cost_price`, `min_stock`, `godown`, `rack`.
- `customers.customer_type` — the six types. **Nullable, never defaulted.** A
  party with no type is refused at order time (`NO_CUSTOMER_TYPE`) rather than
  silently billed as a dealer at list less 52%.
- `customers.salesman_id` — tagged permanently on the party's first order.
- `GET /api/items/:id/rates` — all six rates for one item, with nulls where a
  type has no rate and a sentence saying why.
- `item_rate_history` — the "previous rate" of §4.1. Written on **invoice**, not
  on order: the order rate is a proposal Gaurav may still edit.

**R-04 and R-07 are two different rules and were nearly collapsed into one.**
R-07 says only Sonu may not *see* a rate; R-04 says only Gaurav may *change*
one. Gating both on a single grant left every salesman with an item list
carrying no rates — an order screen that cannot price an order. Caught by
`tests/business-test.js`. Now `items.rates` (see) and `items.rates.edit`
(change) are separate, and Sonu's rate columns are **absent from the payload**,
not hidden by CSS.

### Order capture (§4.1, R-17, R-22, R-23, R-26)

`POST /api/orders` was rewritten. Every rate is computed server-side from the
master; the request cannot supply one. It enforces:

| Rule | Behaviour | Code |
|---|---|---|
| §4.1 | "Delivered To" is mandatory and is not the party name | `DELIVERED_TO_REQUIRED` |
| §3.1 | A commission type must name its agent | `AGENT_REQUIRED` |
| §3.2 | Electrician Direct must be tied to a scheme member | `SCHEME_MEMBER_REQUIRED` |
| R-22 | Never both an agent and a scheme member | `SCHEME_COMMISSION_CONFLICT` |
| §4.1 | A similar order within 24h must be acknowledged | `POSSIBLE_DUPLICATE` |
| R-23 | Split payments must total the invoice exactly | `SPLIT_MISMATCH` |
| R-26 | GPS lat/lng/place stamped on submission, no route updates them | — |
| R-16 | Below cost notifies Yash; the order proceeds | — |
| R-17 | 60-day overdue is returned with the order; never a block | — |

`order_items` snapshots the pricing basis — `pricing_type`, `base_price`,
`price_factor`, `previous_rate`, `commission_pct`, `scheme_weightage` — so a
line billed today can still be explained after the sheet is reissued twice.

### Attendance, shifts and geotagged photos (§6, C.1–C.5, R-24, R-25)

- `shifts` as rows, not an enum: the grace period and half-day cut-off are
  numbers management adjusts, and an enum puts them where changing 6:00 p.m.
  needs a deployment.
- R-24 enforced in the transaction: no photograph, no check-in
  (`PHOTO_REQUIRED`). An invented id is refused (`PHOTO_NOT_FOUND`), and
  **one employee cannot punch in on another's photograph** (`PHOTO_NOT_YOURS`) —
  which is the exact substitution the rule exists to prevent.
- Late judged against the shift's grace in `BUSINESS_TIMEZONE`, not UTC.
  Comparing 04:40 UTC against 10:10 IST marks the whole company late every
  morning; `businessTime()` was added for this.
- R-25 half day on early check-out, decided at the punch.
- `is_late` / `is_half_day` are **stored, not recomputed** — a deliberate
  exception to "attendance is derived". They are judgements against the shift
  timings *as they stood that day*; recomputing March against September's grace
  would rewrite deductions already paid.
- Workplace proximity flags, never blocks. Field salesmen are not geofenced.

### Salary, advances, leave (addendum A, B, C.6; R-27 … R-30)

- Draft months recompute from attendance on every read; finalising freezes the
  figures and writes the deduction lines so each can be waived individually.
- A waiver is a flag, never a delete — the deduction was earned and then
  forgiven, and both are facts. The line stays on the slip.
- Daily rate is salary ÷ 26, snapshotted per month.
- Advances split into equal instalments with the last absorbing the rounding;
  `advance_recoveries` is unique on (advance, month) so a month finalised twice
  cannot recover the same instalment twice.
- Nobody approves their own advance or their own leave (`SELF_APPROVAL`).
- An employee reads their own ledger without any grant and cannot read anybody
  else's — "visible to Yash, Manoj, and the employee themselves".

**One reading was ambiguous and is flagged in code.** The late ladder ("4
instances → ₹500, 5 or more → ₹1,000") is implemented as a **monthly step**, not
a per-occurrence charge. Charging per occurrence would make a seventh late cost
more than three days' pay on an 18,000 salary. `LATE_LADDER` in
`utils/payroll.js` is the one line to change if the business means otherwise.

**A second gap the document leaves open:** "Absent with prior information →
Deduction as per leave policy" never states the policy.
`ABSENT_INFORMED_FACTOR = 1` (one day's pay) is the conservative reading, named
so there is one place to put the answer. It is deliberately not zero — guessing
approved leave is paid would quietly overpay every month.

### The 20-segment incentive (§9, R-18, R-19)

- All 20 segments seeded with their targets and base incentives, including
  Precision Casing measured in **pieces** rather than rupees — a single money
  column would have measured 4,000 pieces in rupees and paid nobody.
- Slabs: <90% pays 0, 90–99% pays 80%, 100% pays the base, 101%+ pays 110% and
  that is the ceiling.
- R-19 is visible on every line: `achieved_gross`, then `removed_unpaid`, then
  `achieved_net`. One net figure hides which of the two happened, and the second
  is what the salesman most needs to see.
- Showroom pool computed across the pair and halved. Membership is the
  `showroom` grant, not a list of names, so replacing Pulen is an admin action.
- Achievement is measured on **invoices**, not orders, and attributed to
  `orders.salesman_id` — which is why the party carries a permanent tag.

**The item→segment mapping is a business judgement, not a fact in the file.**
The document lists 20 segments and never says which items belong to which. The
matchers in `scripts/seed-segments.js` were built from the 141 brand names in
the sheet; 6,587 of 8,909 items fall to the "Others" catch-all, and **"KEI Wire
90 meter" matched only 1 item** while "KEI Wire 300 meter" matched 9. Run
`npm run seed-segments -- --report` and check the counts against what each
segment is meant to cover **before the first incentive month is approved.**

### KL Utsav (§3.2)

- `scheme_members` has its own identity keyed on phone, with optional links to
  both a customer and an agent — because the same electrician buys for his own
  stock one week and refers a customer the next, and R-22 is precisely the rule
  that they must not both fire on one transaction.
- Six slabs seeded. Highest reached only; gifts are not cumulative.
- Early Bird decided from the scheme's launch date and never editable — a
  settable one-slab upgrade would be worth money to anyone who could set it.
- Referral bonus written as two ledger rows so it reads as a bonus.
- Qualifying value accrues on **billing**, weighted per item.
- `qualifying_total` is a cache of `scheme_ledger`, checked by
  `tests/invariants-test.js` exactly like `items.qty`.

### Cash discount and FIFO matching (§3.3)

- `payment_allocations` — without it a payment is a number against a party and
  nobody can say which invoice it cleared, which makes both the cash discount
  and the 60-day incentive rule uncomputable.
- FIFO applies **even when the request names an invoice**: the rule is the
  business's, not the operator's, and pointing a receipt at a chosen invoice is
  how a party's oldest debt stays oldest while the discount is earned on a
  fresh one.
- Bands are rows (`cash_discount_bands`) because Lemac's own ladder differs
  (30/45/60 → 3/2/1%).
- Dealers only, checked against the party's stored classification.
- The discount is a **credit note**, never a reduction of the invoice.
- A reversal undoes the allocations **and cancels the discount note** — a
  discount earned on a cheque that bounced was not earned.
- Overpayment stays unallocated rather than being forced onto a future invoice.

### Purchases, GIT and the GST countdown (§5, R-08, R-12, R-13, R-15)

- The five forms as an enum, each deciding three otherwise unrelated things:
  challan mandatory, GST countdown, transit tracking.
- **R-08 is real:** `bill_qty` and `qty` (counted) are two separate mandatory
  fields. The actual quantity is **not** defaulted to the bill quantity —
  defaulting is exactly the merge the rule forbids, and it would record a count
  nobody made. Shortage/excess is derived from the pair, never accepted from the
  request: a shortage the receiver could label "ok" is one nobody chases.
- Stock moves on what was **counted**, not what was billed.
- R-12: no document photograph, no entry. R-13: challan number mandatory.
- §5.1: goods taken in by Sujay or Dishal wait in `awaiting_verification` and do
  not touch stock until Sonu verifies. The receiver cannot self-verify.
- `git_entries` exists **before** the purchase — a bilty is recorded days
  earlier and there is no purchase to hang it on. `purchases` ↔ `git_entries` is
  therefore a deliberate FK cycle, handled by a trailing `ALTER` in `schema.sql`
  rather than by disabling foreign-key checks.
- Freight tracked per LR and per transporter; the 2-day and 5-day escalations
  each fire once.
- The 7-day GST tracker, and `POST /api/git/gst-bill/:id` to convert.

### Estimates (§7)

Validity 15 days, first follow-up at 3 days, both computed server-side because
both drive alerts. Three attempts maximum, then the quote must be converted or
marked lost with one of six listed reasons — free text would collapse "price too
high" and "purchased elsewhere" into a column nobody can read.

### The alert sweep (§13)

`utils/alerts.js` — eleven rules that fire because something did **not** happen.
`alert_log` is unique on (rule, subject, day), so the hourly sweep and a restart
cannot re-send the morning's alerts. Each rule checks the business-timezone
clock itself rather than trusting the tick.

EOD not submitted by 7:15 · departure not logged by 10:30 · cheque due today ·
GIT overdue 2 / 5+ days · GST bill overdue · credit note past its 2-hour SLA ·
order waiting 3+ days · stock below minimum (one digest, not 8,900
notifications) · dealers not visited · GPS silent 15 min · the daily 5-item
stock count.

**The stock count exposed a real bug in how duties are assigned.**
`usersWithGrant` matches the `all` wildcard, so asking for `stock_count.post`
the usual way handed Yash and Manoj a counting task each. `usersHoldingExactly`
was added: telling someone about something and giving someone a job are
different questions. A duty is held by whoever was *given* it, not by whoever
could grant it to themselves.

### Second pass — the rules and reports that were still open

**R-05, the godown register.** `POST /api/workflow/orders/:id/godown-register`,
and no pick on that order is accepted until it has been called for every
registered godown the order draws from (`GODOWN_REGISTER_REQUIRED`). Only Berlia
and Fan are gated, which is what the document names — gating every godown puts a
modal in front of every pick in the building, which is how an acknowledgement
becomes a reflex nobody reads.

The app cannot read a paper register, so what it enforces is the
*acknowledgement*: the picker states the SO number is written down, and that
statement is timestamped against their account. That is the honest reading of
"App enforces acknowledgement" — unskippable and attributable, not verified.

**R-06, the last mandatory photograph.** The cheque deposit slip was the one
missing. Cheque handling now follows §11 as three separate acts by three
separate people, because the gap between them is where a physical cheque goes
missing:

| Route | Who | Rule |
|---|---|---|
| `POST /cash/cheques/:id/hand-over` | Sibu (`cheques.manage`) | names the KL account and the carrier |
| `POST /cash/cheques/:id/deposit` | Damodar (`cheques.deposit`) | **refuses without the slip photograph** |
| `POST /cash/cheques/:id/status` | Sibu | clears or bounces; refuses `deposited` outright |

The photograph must have been uploaded by the caller — the same ownership check
as attendance, so one person cannot deposit on another's slip.

**R-14, internal transfers.** `routes/transfers.js`. Stock does not move when a
transfer is *sent* — goods in a van are not goods on a shelf — and when it is
received, nothing moves either *if the totals match*: `items.qty` is a
company-wide level, so a complete transfer changes nothing about how much stock
the company holds, and two cancelling ledger rows would be noise in a ledger
whose whole value is that every row explains a change. A **shortfall** is
different and does write a movement, with reason `transfer` so the register can
tell goods lost in transit from a counting correction.

The received quantity is its own field and is never defaulted from what was
sent — the same discipline R-08 imposes on a purchase. The sender cannot receive
their own transfer. `POST /transfers/:id/journal` records Gaurav's stock-journal
entry, and `utils/alerts.js` escalates to Yash the next day if it is missing.

**§4.4 and §4.6, the staff sign-offs.** Ajit's verification now stamps
`verified_by` / `verified_at` (with an optional drawn image);
`POST /dispatch/sheets/:id/sign` is the driver's, scoped so a driver signs only
their own run; `POST /dispatch/sheets/:id/depart` logs the departure and is what
silences the 10:30 alert — callable by the driver, because an alert only Ajit can
silence fires every day he is away from his desk at 10:30.

**Reverse loading is now computed server-side.** §4.6 says "the *application*
indicates the recommended loading order", and it previously said in a comment
that the screen reversed the list. Each stop carries `delivery_seq` and
`load_seq`, and the sheet carries a `loading_order` array. Two clients reversing
a list independently is two chances to get it backwards, which on a loaded van
means unloading everything at the first stop.

**§12, all twelve reports** — `routes/reportsuite.js`, kept separate from
`routes/reports.js`, which is the home dashboard and stays that way. Every
report takes `from`/`to` (both defaulting to today, as §12 specifies), is
permission-gated, and supports `?format=csv`.

| # | Report | Endpoint |
|---|---|---|
| 1 | Daily Sales | `/api/reportsuite/daily-sales` |
| 2 | Outstanding (0-30 / 31-60 / 60+) | `/api/reportsuite/outstanding` |
| 3 | Salesman Performance | `/api/reportsuite/salesman-performance` |
| 4 | Incentive Progress | `/api/reportsuite/incentive-progress/:period` |
| 5 | Purchase (bill vs actual, freight) | `/api/reportsuite/purchases` |
| 6 | Stock (+ below minimum) | `/api/reportsuite/stock` |
| 7 | Cheque | `/api/reportsuite/cheques` |
| 8 | Cash Discount | `/api/reportsuite/cash-discount` |
| 9 | Estimate Conversion | `/api/reportsuite/estimate-conversion` |
| 10 | Party Transaction History | `/api/reportsuite/party/:id` |
| 11 | GIT Register | `/api/git` — the register itself, not duplicated |
| 12 | Stock Count | `/api/reportsuite/stock-counts` |

R-07 holds inside the reports too: Sonu can read the purchase and stock reports
and no value column is present in his payload.

**Also closed:** the dashboard "Mark Reviewed" stamp (§12), the salary slip with
its itemised deductions and in-app share (A.2), and the quote share (§7) — which
returns the formatted text and a `wa.me` link for the salesman to send from
their own phone. The server never contacts WhatsApp, so nothing there can leak a
party's number, and a quote can only be sent to a number already on the party
record.

### Third pass — R-11, which was missing entirely

R-04 and R-11 read as one rule and are two:

  R-04  Gaurav is the only person who may touch a rate at all.
  R-11  "Gaurav can initiate a rate adjustment but cannot approve it. Only
        Yash or Manoj can approve."

Only R-04 had been built. Gaurav could change a rate outright, so a rate could
move without an owner ever seeing it — R-04 satisfied, R-11 ignored.

`item_rate_changes` (migration 011) now holds one row per field per request.
`PUT /api/items/:id` from the rate keeper produces a **202 with
`RATE_CHANGE_PENDING`** and changes nothing; an owner's edit applies at once,
because an owner *is* the approver and anything else would mean Yash raising a
request for himself to approve. `GET /api/items/rate-changes` is the queue, and
`POST /api/items/rate-changes/:batch/decide` is the decision.

Two details that matter:

- **The value is applied from what the column holds at approval time**, and what
  that was is recorded in `applied_from`. A request can sit for days; approving
  it against the value the proposer saw would silently revert anything that moved
  in between, and that difference is exactly what an audit asks about.
- **An earlier pending request for the same field is superseded, not queued.**
  Two requests for one number would be approved in whatever order somebody
  happened to tap, and the second would silently undo the first.

#### And a permission-hierarchy bug it exposed

The first attempt named the grants `items.rates` (see) and `items.rates.edit`
(change). A grant covers everything beneath it, so **`items.rates` — held by
every salesman so they can quote — satisfied `items.rates.edit`** and handed the
whole field force the rate card. The test caught it: a salesman's edit came back
202 instead of 403.

They are now `items.rates` and **`items.pricing`** — siblings under `items`,
neither implying the other, with only the area grant implying both. The lesson
generalises: in a dotted permission hierarchy, two capabilities that must be
independent cannot be named as parent and child.

`PUT /api/items/:id` also had to stop being guarded as a whole. Two disjoint
groups write to an item — Sonu maintains the master (`items.edit`), Gaurav the
rate card (`items.pricing`) — and neither is a subset of the other. Guarding the
route on `items.edit` locked Gaurav out entirely, so R-11 was *unreachable*
rather than merely unimplemented. Each field group is now checked against its own
grant.

#### R-03 and R-20

Both were implemented and neither said so. R-03 ("dispatch sheet: Ajit only") is
the `dispatch.build` guard, and "only Ajit" is a fact about the grant table that
no route guard can enforce — so `tests/invariants-test.js` now asserts exactly
one account holds it. R-20 (EOD by 7:15 p.m.) is the `eodNotSubmitted` sweep
rule. Both are labelled with their rule number now, which is why the sweep in
§1 can be trusted next time.

### Three bugs the second pass found

**Manas was never told about a new order.** `usersWithGrant` matches the
wildcard or the exact string and nothing else. That is right for an area name —
`usersWithGrant(conn, 'dispatch')` finds everyone who does dispatch — and
quietly wrong for a dotted action, because a grant covers everything beneath it.
Manas holds `orders`, which satisfies `orders.approve` on every route guard in
the app; asking for the notification audience the narrow way found only wildcard
holders. **R-01's notification did not reach the one person R-01 is about.**
Gaurav (`billing`), Sonu (`purchases`) and Damodar (`cheques`) had the same hole
across eleven call sites. `usersWhoCan` was added and all eleven switched.

**MariaDB was not in strict mode.** XAMPP ships a non-strict `sql_mode`, which
means an invalid enum is silently stored as the empty string, an over-long
string is truncated, and an out-of-range number is clamped. `config/db.js` now
pins `STRICT_TRANS_TABLES` alongside the existing UTC hook, for the same reason:
the application cannot rely on how the server it is deployed to happens to be
configured. **This turns a class of silent data corruption into an error.**

The bug that exposed it was mine — migration 010 renamed the cheque enum's first
state and dropped the old value in one statement, which would have blanked the
status of every cheque holding it on a live database. Nothing was lost here
(all three existing rows were `bounced`), and the migration now adds the value,
moves the rows, and only then drops the old one.

**A bounced cheque did not undo its FIFO allocations.** `routes/cash.js`
reversed the payment with a raw `UPDATE`, so every invoice that receipt had
settled still read as paid — the same disagreement the bounce handling exists to
prevent, one table deeper. It now calls `reverseAllocations` and cancels any
cash-discount note the receipt earned.

### Fourth pass — Tally, PDF, and the last three flows

#### Tally Prime (§14)

Section 14 asks for "real-time bidirectional synchronisation" and leaves the
method to the developer. The method chosen is **Tally's own HTTP/XML gateway** —
port 9000, "Act as Server" enabled, a `<ENVELOPE>` of TDL over plain POST. No
ODBC driver, no shared folder, no third-party connector: one HTTP call and a
text format, both debuggable with curl.

Three decisions shape it, and each is load-bearing.

**1. An outbox, not a direct call.** Tally runs on an office desktop that is
closed at night, during backups and whenever somebody reboots. A push attempted
inside the invoice transaction would either *fail the invoice* — refusing to bill
because an accounting package is shut — or lose it silently, which is worse. So
every syncable event writes a `tally_queue` row **in the same transaction as the
business fact**, and a worker drains it. "Real-time" then means the worker runs
continuously, not that an HTTP call blocks a salesman at a shop counter.

**2. Nothing is bidirectional per record.** Section 14's nine App→Tally flows and
six Tally→App flows cover *different entities*: we author documents, Tally
authors masters. That removes the need for conflict resolution entirely — there
is no "last write wins" anywhere, because no record has two authors.

**3. Tally's stock and balance figures are reconciled, never applied.** This is
the one place the requirement had to be interpreted rather than followed
literally. §14 asks for "Current stock levels" and "Outstanding balances per
party" to flow Tally→App. Writing them into `items.qty` and
`customers.closing_balance` would destroy the standing invariant that both are
caches of *our own* ledgers — after one pull, `items.qty` would no longer equal
`SUM(stock_movements.change_qty)` and **nothing in the app could be trusted to
explain a number again.** So a pull lands in `tally_reconciliation` as a
comparison, and a variance is reported for a person to resolve. That is what
"sync" can honestly mean for a derived figure: the two systems are checked
against each other, and a disagreement is a finding rather than a silent
overwrite. `GET /api/tally/reconciliation` says so in its own response.

All nine App→Tally flows are wired at the moment §14 specifies:

| Flow | Enqueued at |
|---|---|
| Sales Order | order approval (R-01's moment) |
| Sales Invoice | invoice creation (§4.5) |
| Credit Note | note *issue* — the moment it becomes money |
| Cash Discount Note | same, distinguished by `kind` |
| Purchase Voucher | **after Sonu's verification**, as §14 states |
| Unregistered Purchase | same, when no GST bill was in hand |
| Purchase conversion | GST bill arrival (§5.3) |
| Stock Journal | R-14's journal acknowledgement, same transaction |
| Receipt | payment recorded |
| Ledger / Item master | party or item created |

Details that matter: every voucher carries a **`REMOTEID`** derived from our own
document id, so retrying a push that timed out *after* Tally committed amends
rather than creating a second invoice — the single most important property of an
accounting sync. Party names are XML-escaped (`Bora & Sons` breaks an unescaped
envelope). Tally returns **HTTP 200 for a rejected import**, so the outcome is
read from `<CREATED>`, `<ALTERED>`, `<ERRORS>` and `<LINEERROR>`; treating 200 as
success is how you build a sync that reports everything fine while importing
nothing. Backoff is exponential and capped at an hour, because Tally being closed
overnight is the normal case, not an incident. And **R-21 holds in Tally too**:
`salesInvoiceXml` reads no agent or commission column, asserted by the test suite
against the actual generated XML.

**Off by default.** `TALLY_ENABLED` must be set to `true` and `TALLY_COMPANY`
must match the open company exactly. A half-configured sync pushing documents
into the wrong company is worse than no sync. `npm run tally -- --ping` checks
both, and `GET /api/tally/status` says plainly when it is off.

#### PDF export

`utils/pdf.js`, on `pdfkit` — a streaming generator, no headless browser. The
alternative was rendering HTML through Chromium, which would put 200 MB and a
process pool into an app whose entire PDF requirement is four text documents.

- **All twelve reports** gained `?format=pdf`. The branch lives in one `send()`
  function, so a report cannot end up supporting one format and not the other,
  and the PDF's columns are derived from the CSV's — the two exports of one
  report can never list different columns. Landscape above seven columns.
- **§4.5, the invoice in three copies** — Original, Duplicate, Triplicate, as
  three pages of *one* PDF. Three separate downloads would let somebody print
  two, and the whole point of the Duplicate is that it comes back signed. The
  Duplicate carries the party signature block; the other two carry ours.
- **§7, the quotation** — items, quantities, rates, total, validity date and
  contact details, which is exactly the six things §7 lists.
- **A.2, the salary slip** — itemised by deduction kind. Only a **finalised**
  month has one: a draft recomputes on every read, and a payslip that changes
  after it is issued is worse than none. A waived deduction stays on the slip;
  hiding it would make the arithmetic look wrong.

Everything streams to the response rather than buffering — a stock report over
8,900 items held in memory to measure its length is how a report endpoint takes
the process down.

#### The last three flows

**§8, collections handed to Sibu.** Two people, two moments, two sets of
columns: the salesman *declares* what he is carrying, Sibu *counts* what
arrived. Collapsing them into one row Sibu fills in would lose the declaration,
and the declaration is the only record of a shortfall — without it, "he gave me
4,000" and "I gave him 5,000" are both unevidenced. A variance marks the handover
**disputed** rather than adopting either figure, and both the owners and the
salesman are told.

**§4.8, the godown close.** Ajit's 7 p.m. close, distinct from Sibu's 7:15 EOD
(which is money). The godown photograph is mandatory, and `open_orders` is
counted *by the server* rather than typed — "final order statuses" is a claim
that can be checked.

**D.2, the order location.** `gps_place_source` now records whether the place
name was geocoded server-side or supplied by the client, because "Yash can view
exactly where the salesman was" depends on knowing which — a salesman who can
type the place name can type the wrong one.

**Reverse geocoding is off by default, and that is deliberate.** It means sending
an identified employee's exact coordinates to a third party, in an app that
already tracks named people continuously. That is a decision for the business,
with a named provider and a stated retention position — not something a backend
switches on because a requirement contains the word "geocoded". Set
`GEOCODE_ENABLED=true` to use Nominatim, or point `GEOCODE_HOST` at a
self-hosted instance, which is the better answer for a business that would
rather nothing left the building.

#### Two more bugs found

**`sql_mode` was not strict** — already covered in the second pass, but it was
this pass's enum work that exposed how much it mattered.

**Sibu could not see the handovers he was meant to count.** The list checked
`cash` and `cash.view`; Sibu holds `cash.manage`. The person the rule is about
got an empty screen. Caught by the test suite, which is the second time a
"who can see this?" check has been wrong in the narrow direction rather than the
dangerous one — worth noting as a pattern.

### Fifth pass — the last three, and what proving Tally actually showed

#### The two optional photographs (§4.1, §4.3)

Both now accepted, and both still optional — the document says "Optional: The
user may photograph a handwritten order note" and "the application provides the
option to photograph the material", which is a different rule from the four R-06
makes mandatory. A missing photograph is not an error; an id that was sent and
does not resolve to an upload by that user *is*, because a silently-dropped bad
id looks like a photograph nobody can find.

The pick photograph uses `COALESCE(VALUES(photo_id), photo_id)` on re-submit: a
picker who resubmits a line without the photograph should not lose the one they
already took.

#### The Lemac growth schemes

All four seeded — Modular Monthly, Boxes Monthly, Quarterly (Puja Bonanza),
Yearly (Saalana Utsav) — with the sheet's own slabs, and **all inactive**.

They are a different shape from KL Utsav and `utils/growthScheme.js` is separate
for that reason:

| | KL Utsav | Growth |
|---|---|---|
| accrues to | a person | a **dealer** |
| window | one 90-day run | per window, **resets** |
| pays | a fixed gift at the highest rung | a **percentage** of the window's billing |

Two rules from the sheet do most of the work. *"STACK: Monthly credit (4%) +
Quarterly gift (5%) + Yearly credit (3%) are ADDITIVE (separate layers)"* — so
one award row per (scheme, dealer, window), and nothing nets them against each
other. And *"Released only after full payment of the goods"* — so **earned** and
**released** are two different states: the slab is reached on billing, the money
is payable only once the invoices behind it are settled, measured on
`invoices.settled_on`, which is the same notion of "paid" the cash discount and
the 60-day incentive rule use.

Only dealers accrue: the slabs are dealer billing figures sitting on the "List
less 52%" ladder, which is the dealer column. A `growth_credit` award becomes a
**pending** credit note (an owner still issues it — the standing invariant); a
`growth_gift` award is marked issued without a note, because a gift is handed
over rather than posted to a ledger.

**Seeded inactive on purpose.** Whether K.L. Electricals runs Lemac's dealer
schemes as a distributor or merely stocks the range is a business fact absent
from all three documents. Activating one starts accruing money against every
dealer invoice, so it is `POST /api/schemes/:id/activate` — a decision somebody
takes, not a side effect of a seed script.

#### Tally, proved against a stand-in

`tests/tally-test.js` starts an HTTP server that speaks Tally's XML gateway
protocol and behaves the way Tally Prime does in the ways that break
integrations. It runs against a **scratch database**, so a failing assertion can
never mark a real invoice as sent.

What it proves:

- a **200 carrying a `LINEERROR` is a failure** — the single most common way a
  Tally integration is built wrong;
- **`CREATED=0 ALTERED=0` with no error is a failure too**, and the message
  names the likely cause (a `TALLY_COMPANY` mismatch, which Tally answers by
  doing nothing at all);
- a second push of the same document is an **ALTER, not a second voucher**;
- Tally switched off **mid-run** loses nothing — every document stays queued,
  with a backoff, and "unreachable" is distinguishable from "rejected";
- the pull parser survives what real Tally emits: a raw `&` in a party name,
  `"18 %"` as a GST rate, `"42 pcs"` as a balance, `"125.50/pcs"` as a rate;
- a bank ledger is **not** imported as a customer;
- and the invariant the whole design turns on: Tally said the stock was 42, we
  said 0, **`items.qty` stayed 0** and the disagreement was written to
  `tally_reconciliation` as a variance of 42.

**Three things the proving run taught me, which is why it was worth building:**

1. **Tally keys masters on NAME, vouchers on `REMOTEID`.** Ledgers and stock
   items carry no `REMOTEID` and do not need one — `ACTION="Alter"` on the same
   NAME amends. The consequence worth knowing: **renaming a party in this app
   creates a second ledger in Tally rather than renaming the first.**
   `tally_links.tally_name` is what would detect that; handling it is a
   deliberate open item rather than an oversight.

2. **The frozen payload is load-bearing in a way I had not fully traced.** I
   first tried to simulate a wrong company by changing the environment variable,
   and the push succeeded — because `SVCURRENTCOMPANY` is inside the XML that
   was stored at enqueue time. That is the correct design (a document reaches
   Tally as it was when the event happened) and it means the company name cannot
   be corrected by editing `.env` for documents already queued. They must be
   re-enqueued.

3. **`GET /api/tally/queue/:id/payload` earns its place.** Every failure in this
   suite was diagnosed by reading the stored envelope, which is exactly what
   somebody will do on the office machine.

**Still not a real Tally.** Passing here does not mean the first push against
the office machine succeeds: the ledger names in `TALLY_*_LEDGER` have to match
that company's chart of accounts, and Tally's own validation is stricter than
anything reproducible in a stand-in. Budget half a day with Tally open.
`npm run tally -- --ping` is the first step.

#### Two gaps found while doing it

**Ajit could not see what he was counting.** §4.4 has him counting every picked
item, but the pick sheet is gated on `picking.view` — which he deliberately does
not hold, because he verifies rather than picks — and `/verifications` gave only
a per-order summary. The one screen the verification step needs had no endpoint
behind it: the count could be *submitted* but not *informed*. `GET
/api/workflow/orders/:id/verifysheet` is that endpoint, and it counts against
the **picked** figure rather than the ordered one — a short pick is meant to bill
short, so counting against the SO would flag every short pick as a mismatch and
bury the real ones.

**A scheme's cycle could not be rolled.** The Lemac sheet says it outright:
*"Note: App should allow validity dates to be updated each cycle."* A monthly
scheme whose end date passes silently stops accruing. `PUT /api/schemes/:id`
moves the window; `kind`, `period` and `item_flag` are deliberately not
editable, because changing what a scheme measures while awards exist against it
would leave those awards computed on one basis and displayed on another. Moving
a non-renewing scheme's start date is refused once dealers have accrued in it,
since the window key *is* that date and moving it would orphan every award.

### Sixth pass — the three that were answerable, and the nine screens

The fifth pass closed the requirements document. What was left was a list of
four things I had said I could not do. Three of them turned out to be doable
without an answer from anybody; the fourth still needs a machine.

#### The rename problem, solved by asking Tally the right question

Tally keys ledger masters on **NAME**, not on an id we choose. So renaming a
party here and pushing the master again does not rename anything — it creates a
second ledger, and the party's balance splits silently across two accounts that
both look correct.

I had left this open on the grounds that §14 lists party master as flowing
Tally→App, which argues for reporting the divergence rather than pushing a
rename. Building the proving harness changed my mind about which is the smaller
claim. Tally's own `<NAME.LIST>` on an `Action="Alter"` **is** the rename verb —
it is not us overriding Tally's ownership of the name, it is us telling Tally
that the ledger it already owns has been renamed, which is exactly what
happened. `ledgerMasterXml()` therefore takes an optional `previousName`, looks
the ledger up by what we last told Tally it was called, and sets the new name
through `NAME.LIST`:

```js
<LEDGER NAME="${xml(previousName || customer.name)}" ACTION="Alter">
  <NAME.LIST TYPE="String"><NAME>${xml(customer.name)}</NAME></NAME.LIST>
```

`tally_links.tally_name` is what supplies `previousName`, and it is updated only
after Tally accepts the alter — so a failed push leaves the link pointing at the
name Tally still holds, and the next attempt looks it up correctly rather than
chasing a name that never landed.

**How the mock taught me this.** The first version of the Tally stand-in matched
documents on `REMOTEID` alone, and the rename test passed against it while being
wrong. Masters have no REMOTEID: keyed on name, the same push arrives as a
*second* ledger. Teaching the mock to key masters on NAME the way Tally does
made the test fail, and the failure is the bug. A stand-in that is easier to
satisfy than the real thing is worse than no stand-in.

#### A preflight, because "it is not syncing" is not a diagnosis

The first run happens on a machine I cannot reach, performed by somebody who is
not going to read a stack trace. So the sync got a `doctor()`:

```
npm run tally -- --doctor      # or GET /api/tally/doctor
```

It checks, in the order they fail in practice: the sync is switched on, a
company name is set, Tally answers on the gateway, the company Tally has open is
the one configured, the posting ledgers named in `.env` exist in that company,
and an import is actually accepted. Each failure carries a `fix` — not a
description of what went wrong but the thing to do about it:

```
FAIL  Tally answers on the gateway
        ECONNREFUSED contacting Tally at 127.0.0.1:9000
        → In Tally: F1 → Advanced Configuration → "Act as Server" = Yes,
          port 9000. Check a firewall is not blocking it.
```

Two of those checks exist because of things the harness caught. A **200 carrying
a `LINEERROR`** is a failure — Tally answers 200 to a request it refused, and
treating the status code as the answer marks a rejected voucher as sent.
**`created=0 altered=0` with no error** is also a failure: it is what a push
into the wrong company looks like, and the wrong company is precisely the state
this check exists to find.

Trying to simulate the wrong-company case through the environment failed at
first, and the failure is informative: the XML payload is frozen at enqueue
time, so `SVCURRENTCOMPANY` is already inside the stored document. Changing the
env afterwards changes nothing — which is the correct behaviour, and is why a
queued document sent a week later still goes to the company it was raised for.

#### The Lemac return penalty, built as a capability that is off

> Return policy: 20% penalty on any product returned; 80% credit note if
> saleable.
> — `LEMAC_Developer_Master_v7.xlsx`, *Discount & Scheme Reference*

I had left this because it changes money a customer receives, and the
requirements PDF's own returns section says nothing about it. That reasoning was
right about the *decision* and wrong about the *code*: the reason not to write
it was never that the code was unclear, it was that nobody had chosen. So the
mechanism is built and the choice is left where it belongs.

`items.return_penalty_percent` is **NULL for every row** (migration 014). A NULL
credits in full, exactly as before. Nothing in the Lemac import sets it —
writing 20% onto 451 items would have started short-paying refunds without
anybody asking. Switching it on is one statement, and it is in the migration's
own comment.

Saleability is the condition the sheet names, so it is recorded per line rather
than assumed: `sales_return_items.is_saleable`. Unsaleable goods take no penalty
— the sheet's 80% is the *saleable* case, and the penalty is what makes it 80%.

The line keeps `amount` (what came back) and `credit_amount` (what the party
gets) as separate columns. A return of ₹1,000 crediting ₹800 is two facts, and
one column holding 800 cannot answer "what came back?".

#### The client screens

Nine screens, and the API binding layer under them.

`services/endpoints.js` went from 71 bindings to 191, and
`tests/api-coverage-test.js` now asserts that **every route the server mounts is
either bound or excused with a written reason**. It catches the opposite fault
too: a binding pointing at a route that no longer exists. Currently 194
endpoints, 191 bound, 3 excused.

| Screen | Covers | Reached from |
|---|---|---|
| `SalaryScreen` | Addendum A — the month, its deductions, R-28 waivers, the slip | Profile |
| `AdvancesScreen` | Addendum B and C.6 — advances and leave, both sides | Profile |
| `IncentiveScreen` | §9 — the 20 segments, with R-19 on its own line | Profile |
| `GitScreen` | §5.2 GIT register and freight, §5.3 GST countdown | Purchase |
| `TransfersScreen` | R-14 — internal transfers and the same-day journal | Purchase |
| `HandoverScreen` | §8 — collections declared, then counted | EOD, Salesman's day |
| `RateChangeScreen` | R-11 — the rate-change approval queue | Owner's dashboard |
| `ReportsScreen` | §12 — all twelve, with CSV and PDF | Owner's dashboard |
| `TallyScreen` | §14 — the outbox, the stuck list, the preflight | Owner's dashboard |

**None of them is a tab, and that is deliberate.** The bar holds five slots
including Alerts and Profile, which leaves three for duties. Every one of those
three is already spoken for by something a person does hourly. Pay is looked at
once a month; the Tally console is opened when something is wrong. So each new
screen hangs off the screen it belongs beside — which is the rule
`constants/roles.js` already stated for overflow, applied rather than
re-litigated.

Two consequences worth writing down, because both were caught rather than
designed:

**A pushed screen hides the phone's tab bar.** That is correct — a half-filled
form should not be abandoned by a stray tab tap — but it means a pushed screen
with no back link is a screen with no way out. All nine take `onBack` and pass
it to their header. `TransfersScreen` has two levels and its back link means
"the list" while a transfer is open and "the previous screen" otherwise.

**The role descriptor grew capability flags.** Nine screens each asking
`userCan()` for itself is eleven places for the client copy of the permission
rules to drift from the server's. `MobileNavigator` computes them once —
`managesSalary`, `approvesLeave`, `approvesIncentives`, `movesGoods`,
`journalsTransfers`, `countsCash` — each mirroring a predicate the server
already owns and named after it. None is a security boundary; every route below
is guarded. They decide whether a control is *drawn*, so that a picker is not
shown an Approve button that can only ever 403.

`constants/permissions.js` dropped `serverOnly` from the five grants whose
screens now exist. `showroom` keeps it, and now says why: it opens no screen by
design — it marks who the shared incentive pool pays, which
`routes/incentives.js` reads. There is nothing for it to navigate to.

#### Verified

```
npm run test:api            3   every server endpoint bound or excused
npm run test:pricing       54
npm run test:invariants    20
npm run test:schema        12
npm run test:tally         31
npm run test:business     161
npm run test:growth        33
                          ---
                          314   all passing, suite run twice for idempotency
```

The client tree compiles: 45 files through the project's own Babel config, zero
failures. Every endpoint call in every screen resolves to a real binding — 125
calls checked against the 28 exported API objects.

---

## 4. Schema and the fresh-install path

Migrations 005–014 were added. **`schema.sql` is now generated** by
`scripts/rebuild-schema.js` from a migrated database, with the hand-written
prose above each table carried across on every regeneration.

This was necessary, not cosmetic. `init-db.js` applies `schema.sql` and then
marks **every** migration as already applied. A migration adding a column
`schema.sql` lacks produces a new database missing that column *and* convinced
the migration has run. Nothing fails at install time; it surfaces weeks later as
"Unknown column" from a route nobody has touched.

`tests/schema-test.js` builds a scratch database from `schema.sql` and another
from `init.sql` and diffs both against the live one, column by column. Currently
727 columns, zero drift on either path.

Workflow after adding a migration:

```bash
npm run migrate && npm run rebuild-schema && npm run build-init-sql
```

`schema.sql` now also carries two sets of **reference rows** — the shift timings
and the cash-discount ladder. A fresh database without them marks nobody late
and pays no discount: broken, not empty.

---

## 5. Not built

Listed so nothing here is mistaken for an oversight.

Nothing in `KL_App_Requirements_FINAL.pdf` is unimplemented, and the Lemac
growth schemes are built too. **One** thing remains, and it needs a machine
rather than an answer.

### 1. The Tally first run — needs a real Tally

The sync is complete and proved against a stand-in that speaks Tally's
protocol; the dialect against a real Tally is unproven. Needs the office machine
with Tally open, its company name, and its chart of accounts.

Re-checked on 31 August: nothing is listening on `127.0.0.1:9000` here —
`ECONNREFUSED`, and Tally is not installed on this machine, so there is no way
to shorten this from here.

What has changed is how long it should take once someone is at that machine.
`npm run tally -- --doctor` walks the six things that go wrong, in the order
they go wrong, and each failure carries the fix rather than the symptom. See the
sixth pass above.

### Three that were open and are now closed

Kept here rather than deleted, because "not built" turning into "built" is the
part of a document worth reading twice.

| Was | Now |
|---|---|
| A rename creates a second Tally ledger | `ledgerMasterXml()` sends `NAME.LIST` on an alter, looked up by `tally_links.tally_name` |
| The Lemac return penalty — a pricing decision | Built as `items.return_penalty_percent`, **NULL everywhere**, so nothing changes until somebody sets it |
| No client screens for nine subsystems | All nine built; `serverOnly` dropped from five grants in `constants/permissions.js` |

The reasoning that had held the second one back was right about the decision and
wrong about the code. Whether K.L. Electricals passes Lemac's 20% on to its own
customers is still nobody's call but the business's — the difference is that the
mechanism now exists and is switched off, rather than not existing.

### Smaller gaps

Nothing from the requirements document is partial.

---

## 6. Data gaps that block go-live

None of these are code problems. The code is ready; the data is not in either
spreadsheet.

**Tally may now fill the first two.** `POST /api/tally/pull?scope=items` imports
HSN and GST rate from Tally's stock items, and it fills gaps without ever
blanking something already known (`COALESCE(NULLIF(...))`). If Tally holds them,
one pull closes both gaps.

### 1. GST is zero on 8,885 of 8,909 items — blocking

Neither sheet carries a GST rate. Every order and every invoice currently
computes **₹0 tax**. Nothing can be legally invoiced until this is filled.

The fix is a rate per item or per brand. `items.gst_percent` exists and
`PUT /api/items/:id` accepts it; a bulk update by brand would be quickest.

### 2. No HSN code on any item — blocking for a GST invoice

Same cause. `items.hsn` exists and is snapshotted onto every order line.

### 3. No cost price on any item — R-16 cannot fire

Both sheets are rate cards, not costings. `cost_price` is nullable and
`isBelowCost()` returns false when it is null, so the below-cost alert is
silent rather than wrong. It stays silent until costs are entered.

`routes/invoices.js` has a partial fallback: it compares against the highest
**posted purchase rate** for the item, so the invoice-time warning works for
anything that has been bought through the app.

### 4. No rack or godown on any item — the picker screen cannot show locations

§4.3 requires rack locations on the picking screen and R-05 requires the godown
register step. `items.godown` and `items.rack` exist and are editable; neither
spreadsheet carries the data.

### Also worth a decision

- **Salaries are seeded at 0** for everyone except Monu (18,000 — the only figure
  the documents give, in the worked example at A.1). A month cannot be finalised
  meaningfully until Yash enters the rest. Seeding plausible numbers would have
  put invented pay into a live payroll.
- **Workplace coordinates are locality centres with a 600 m radius**, not
  surveyed shopfronts. Generous on purpose: the proximity rule is a flag, not a
  block, so a wide radius flags nobody wrongly. Tighten once someone stands in
  each doorway with a phone.
- **The incentive segment mapping** — see §3.

---

## 7. API surface added

```
GET    /api/items/:id/rates                        the six rates for one item

POST   /api/payroll/advances                       request an advance
GET    /api/payroll/advances                       register, or one's own
POST   /api/payroll/advances/:id/decide            R-27
POST   /api/payroll/leave                          apply
GET    /api/payroll/leave                          mine, or everyone's
POST   /api/payroll/leave/:id/decide               Manas / Yash
GET    /api/payroll/salary/:employeeId/:period     the month's ledger
POST   /api/payroll/salary/:e/:p/finalise          freeze it
POST   /api/payroll/deductions/:id/waive           R-28
POST   /api/payroll/salary/:id/approve             R-30
POST   /api/payroll/salary/:id/pay
GET    /api/payroll/register/:period               everyone's month
GET    /api/payroll/attendance-summary/:e/:p       C.5

GET    /api/incentives/segments                    the twenty
GET    /api/incentives/:employeeId/:period         live progress
POST   /api/incentives/:e/:p/compute               freeze a draft
POST   /api/incentives/:id/approve                 R-18
POST   /api/incentives/:id/pay
GET    /api/incentives/register/:period

POST   /api/git                                    record a bilty
GET    /api/git                                    the GIT register + freight
POST   /api/git/:id/stage                          pending → arrived → received
GET    /api/git/gst-pending                        the 7-day tracker
POST   /api/git/gst-bill/:id                       convert on bill arrival
GET/POST /api/git/suppliers                        supplier master
GET/POST /api/git/transporters                     transporter master

GET    /api/schemes                                live schemes + slabs
GET    /api/schemes/members?phone=                 the registration check
POST   /api/schemes/members                        one-tap registration
GET    /api/schemes/members/:id                    standing + ledger
GET    /api/schemes/standings                      the leaderboard

GET    /api/purchases/types                        the five forms
POST   /api/purchases/:id/verify                   Sonu's review
POST   /api/purchases/:id/hold                     5.4

POST   /api/field/estimates/:id/follow-up          log an attempt
POST   /api/field/estimates/:id/lost               close with a reason
POST   /api/field/estimates/:id/share              text + wa.me link (7)
GET    /api/field/estimates/due                    what needs a call

POST   /api/workflow/orders/:id/godown-register    R-05
POST   /api/cash/cheques/:id/hand-over             11, names the KL account
POST   /api/cash/cheques/:id/deposit               R-06, slip mandatory
POST   /api/dispatch/sheets/:id/sign               4.6, the driver's own run
POST   /api/dispatch/sheets/:id/depart             4.6, silences the 10:30 alert

GET    /api/transfers                              the register (R-14)
GET    /api/transfers/:id
POST   /api/transfers                              send between godowns
POST   /api/transfers/:id/receive                  count what arrived
POST   /api/transfers/:id/journal                  R-14, Gaurav's Tally entry

GET    /api/payroll/slip/:employeeId/:period       A.2, itemised
POST   /api/payroll/slip/:id/share                 A.2, in-app

GET    /api/items/rate-changes                     R-11, the approval queue
POST   /api/items/rate-changes/:batch/decide       R-11, Yash or Manoj only

GET    /api/reportsuite                            what exists, and export formats
GET    /api/reportsuite/<twelve reports>           ?from= &to= &format=csv|pdf
POST   /api/reportsuite/reviewed                   12, "Mark Reviewed"
GET    /api/reportsuite/reviewed                   the acknowledgement history

GET    /api/documents/invoice/:id.pdf              4.5, three copies in one PDF
GET    /api/documents/estimate/:id.pdf             7
GET    /api/documents/salary-slip/:emp/:period.pdf A.2

GET    /api/tally/status                           14, is it working
GET    /api/tally/queue                            the outbox
GET    /api/tally/queue/:id/payload                the XML, for curl
POST   /api/tally/queue/:id/retry                  clear the backoff
POST   /api/tally/queue/retry-all                  after Tally comes back
POST   /api/tally/push                             drain now
POST   /api/tally/pull?scope=parties|items|reconciliation
GET    /api/tally/reconciliation                   where the two disagree
POST   /api/tally/reconciliation/:id/resolve

POST   /api/cash/handover                          8, the salesman declares
GET    /api/cash/handover                          8, today's declarations
POST   /api/cash/handover/:id/receive              8, Sibu counts it
POST   /api/cash/day-close                         4.8, godown photo to Yash
GET    /api/cash/day-close                         4.8, the history

GET    /api/workflow/orders/:id/verifysheet        4.4, what Ajit counts against

GET    /api/schemes/growth                         the four Lemac schemes
GET    /api/schemes/growth/standing/:customerId    one dealer, every scheme
GET    /api/schemes/growth/:id/standings           the leaderboard
POST   /api/schemes/growth/awards/:id/issue        pay a released award
PUT    /api/schemes/:id                            roll the cycle (the sheet asks)
POST   /api/schemes/:id/activate                   switch one on or off
```

## 8. Commands added

```bash
npm run import-rates -- --all        load both spreadsheets into items
npm run import-rates -- --all --dry-run
npm run seed-segments                the 20 segments, and map items to them
npm run seed-segments -- --report    show the mapping, change nothing
npm run seed-business                21 staff, shifts, workplaces, KL Utsav
npm run seed-business -- --reset     reapply shifts and grants, never passwords
npm run alerts                       run the sweep once, on demand
npm run rebuild-schema               regenerate schema.sql from the database
npm run rebuild-schema -- --check    report drift, write nothing
npm run tally                        one Tally push cycle
npm run tally -- --pull              push, then pull masters and reconcile
npm run tally -- --watch             run continuously (this is "real-time")
npm run tally -- --ping              is Tally reachable and configured?
npm run test:all                     all six suites
npm run test:tally                   the sync, against a Tally-protocol stand-in
npm run test:growth                  the growth schemes, whole pipeline
```

## 9. Configuration added

```
TALLY_ENABLED=false          # must be true; off by default on purpose
TALLY_HOST=127.0.0.1
TALLY_PORT=9000              # Tally Prime's HTTP gateway
TALLY_COMPANY=               # must match the open company EXACTLY
TALLY_INTERVAL_MS=30000      # push cadence
TALLY_SALES_LEDGER=Sales     # the ledger names vouchers post against
TALLY_PURCHASE_LEDGER=Purchase
TALLY_GST_LEDGER=Output GST
TALLY_INPUT_GST_LEDGER=Input GST
TALLY_CASH_LEDGER=Cash
TALLY_BANK_LEDGER=Bank
TALLY_DEBTOR_GROUP=Sundry Debtors

GEOCODE_ENABLED=false        # off by default; see §5 on why
GEOCODE_HOST=nominatim.openstreetmap.org
GEOCODE_USER_AGENT=          # Nominatim's policy requires a real contact
```
