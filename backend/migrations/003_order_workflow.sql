-- Migration 003 — the order workflow, for the July 2026 phone app.
--
--   npm run migrate
--
-- A database created fresh by scripts/init-db.js already has all of this;
-- mark it applied rather than running it:
--
--   npm run migrate -- --mark 003_order_workflow.sql
--
-- Two kinds of change:
--
--   1. orders.status gains the pipeline stages. The four original values are
--      kept because live code still writes them — POST /orders sets 'confirmed'
--      for a salesman holding the confirm grant, and the dashboard reads
--      'completed' and 'cancelled'. Widening an ENUM does not rewrite rows, so
--      no existing order changes.
--
--   2. Twenty-six new tables. Every one is CREATE TABLE IF NOT EXISTS and every
--      statement below is safe to run twice.
--
-- Table order matters: a foreign key cannot be declared before its target
-- exists, so agents precedes agent_commissions, invoices precedes
-- sales_returns, and so on. This file is the same order as schema.sql.

SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- orders.status — widen to the pipeline
--
-- MODIFY rather than a guarded ADD: unlike a column, an ENUM's value list has
-- no IF NOT EXISTS form, and restating the full definition is idempotent.
-- ---------------------------------------------------------------------------
ALTER TABLE orders MODIFY COLUMN status ENUM(
  'pending','confirmed','completed','cancelled',
  'approved','rejected','picking','picked','verified',
  'invoiced','dispatched','delivered','undelivered'
) DEFAULT 'pending';

-- ===========================================================================
-- Order workflow
--
-- Added for the phone app (July 2026 screens). The pipeline is a state machine
-- on orders.status; everything below records how an order moved and what was
-- physically found at each stage.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- order_events -- append-only trail of status transitions.
--
-- Same principle as stock_movements: the current stage lives on orders.status
-- for cheap filtering, and this table is why that column can be trusted. Nothing
-- here is ever updated or deleted, so "who approved SO-147, and when" survives
-- the order being cancelled and reinstated twice.
--
-- from_status is nullable because the first event of an order's life has no
-- predecessor.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_events (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NOT NULL,
  from_status VARCHAR(20) DEFAULT NULL,
  to_status   VARCHAR(20) NOT NULL,
  note        VARCHAR(255) DEFAULT NULL,
  created_by  VARCHAR(20) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id, created_at),
  FOREIGN KEY (order_id)   REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- order_picks -- what the picker actually found, per order line.
--
-- One row per order_item, created when picking starts. picked_qty is what came
-- off the rack; `status` is derived from it by the route and stored so the sheet
-- can be filtered without recomputing. A short pick is NOT an error here -- it is
-- the fact the verify step and Yash's alert both depend on.
--
-- UNIQUE on order_item_id: a line is picked once. Re-picking updates the row,
-- which is safe because the pick is a working note, not a ledger -- the ledger
-- entry is the stock movement the order already wrote.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_picks (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT NOT NULL,
  order_item_id INT NOT NULL,
  rack          VARCHAR(30) DEFAULT NULL,
  need_qty      DECIMAL(15,4) NOT NULL,
  picked_qty    DECIMAL(15,4) NOT NULL DEFAULT 0,
  status        ENUM('pending','done','partial','missing') NOT NULL DEFAULT 'pending',
  note          VARCHAR(255) DEFAULT NULL,
  picked_by     VARCHAR(20) DEFAULT NULL,
  picked_at     DATETIME DEFAULT NULL,
  UNIQUE KEY unique_line (order_item_id),
  INDEX idx_order (order_id),
  FOREIGN KEY (order_id)      REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  FOREIGN KEY (picked_by)     REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- order_verifications -- Ajit's physical count before billing (R02).
--
-- expected_qty is snapshotted rather than joined back to order_items, because a
-- verification is evidence about a moment: if the order is later modified, the
-- count must still say what was expected when it was taken.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_verifications (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT NOT NULL,
  order_item_id INT NOT NULL,
  expected_qty  DECIMAL(15,4) NOT NULL,
  counted_qty   DECIMAL(15,4) NOT NULL,
  is_mismatch   BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by   VARCHAR(20) DEFAULT NULL,
  verified_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_line (order_item_id),
  INDEX idx_order (order_id),
  INDEX idx_mismatch (is_mismatch),
  FOREIGN KEY (order_id)      REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
  FOREIGN KEY (verified_by)   REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Commission agents
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- agents -- builders, electricians and interior designers who introduce a sale.
--
-- phone is UNIQUE and is the lookup key: a name is spelled six ways across a
-- ledger and a phone number is not. Uniqueness is enforced here rather than by a
-- SELECT-then-INSERT, which cannot be made race-free.
--
-- agent_type selects the commission rate column (21 for builders, 20 for
-- electricians and interior), which is why it is NOT NULL -- a ledger created
-- without it owes an amount nobody can compute.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  phone       VARCHAR(20) NOT NULL,
  agent_type  ENUM('builder','electrician') NOT NULL,
  area        VARCHAR(100) DEFAULT NULL,
  profession  VARCHAR(50) DEFAULT NULL,
  is_active   BOOLEAN DEFAULT TRUE,
  created_by  VARCHAR(20) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_phone (phone),
  INDEX idx_name (name),
  INDEX idx_active (is_active),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- agent_commissions -- what an agent earned on one order line.
--
-- Deliberately never joined into an invoice: agent identity and commission stay
-- off the printed document (R21). The party must not see what their agent is
-- paid, so this is a separate table rather than columns on order_items, and
-- nothing in the invoice path reads it.
--
-- percent and amount are both stored. The rate can be renegotiated, and a
-- historical line must keep the rate it was actually paid at.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_commissions (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  agent_id      INT NOT NULL,
  order_id      INT NOT NULL,
  order_item_id INT DEFAULT NULL,
  sale_amount   DECIMAL(15,2) NOT NULL DEFAULT 0,
  percent       DECIMAL(5,2) NOT NULL DEFAULT 0,
  amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  status        ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  paid_at       DATETIME DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_agent (agent_id, status),
  INDEX idx_order (order_id),
  FOREIGN KEY (agent_id)      REFERENCES agents(id),
  FOREIGN KEY (order_id)      REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Billing
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- invoices -- raised by Gaurav, only after verification (R02).
--
-- The party's name and GSTIN are snapshotted alongside the foreign key for the
-- same reason order_items snapshots the item: a customer who later corrects
-- their trading name must not silently rewrite documents already issued.
--
-- invoice_no is UNIQUE. It is generated by the route, but the constraint is here
-- because two concurrent bills would otherwise both read the same last number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  invoice_no   VARCHAR(30) NOT NULL,
  order_id     INT NOT NULL,
  customer_id  INT NOT NULL,
  party_name   VARCHAR(100) NOT NULL,
  party_gstin  VARCHAR(20) DEFAULT NULL,
  invoice_date DATE NOT NULL,
  sub_total    DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_amount   DECIMAL(15,2) NOT NULL DEFAULT 0,
  grand_total  DECIMAL(15,2) NOT NULL DEFAULT 0,
  status       ENUM('issued','cancelled') NOT NULL DEFAULT 'issued',
  created_by   VARCHAR(20) DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_invoice_no (invoice_no),
  INDEX idx_order (order_id),
  INDEX idx_customer (customer_id),
  INDEX idx_date (invoice_date),
  FOREIGN KEY (order_id)    REFERENCES orders(order_id),
  FOREIGN KEY (customer_id) REFERENCES customers(masterid),
  FOREIGN KEY (created_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- invoice_items -- the billed lines, snapshotted.
--
-- rate here may differ from order_items.rate: the rate is Gaurav's to edit at
-- billing time (R04) and this records what was actually charged. below_cost is
-- stored rather than derived because purchase cost moves, and the question the
-- flag answers is "was this knowingly billed under cost at the time".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id  INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  hsn         VARCHAR(20) DEFAULT NULL,
  qty         DECIMAL(15,4) NOT NULL,
  rate        DECIMAL(15,2) NOT NULL,
  discount    DECIMAL(5,2) DEFAULT 0,
  gst_percent DECIMAL(5,2) DEFAULT 0,
  gst_amount  DECIMAL(15,2) DEFAULT 0,
  total       DECIMAL(15,2) NOT NULL,
  below_cost  BOOLEAN NOT NULL DEFAULT FALSE,
  INDEX idx_invoice (invoice_id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)    REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Dispatch and delivery
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- dispatch_sheets -- one driver's run for one day, built by Ajit (R03).
--
-- UNIQUE on (sheet_date, driver_id): a driver has one sheet per day. Two sheets
-- would split the run and neither would show the whole load.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_sheets (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  sheet_date     DATE NOT NULL,
  driver_id      VARCHAR(20) NOT NULL,
  zone           VARCHAR(60) DEFAULT NULL,
  departure_time VARCHAR(10) DEFAULT NULL,
  status         ENUM('building','released','closed') NOT NULL DEFAULT 'building',
  released_by    VARCHAR(20) DEFAULT NULL,
  released_at    DATETIME DEFAULT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_driver_day (sheet_date, driver_id),
  INDEX idx_date (sheet_date),
  FOREIGN KEY (driver_id)   REFERENCES users(id),
  FOREIGN KEY (released_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- dispatch_stops -- the orders on a sheet, in delivery order.
--
-- `seq` is the DELIVERY sequence, not the load sequence. The auto is loaded in
-- reverse -- last drop at the bottom of the pile -- but the driver reads this
-- list far more often than the loader does, so it is stored the way it is read
-- and the dispatch screen reverses it for loading.
--
-- The driver may reorder en route, so seq is a suggestion and `state` is what
-- actually happened. UNIQUE on order_id: an order rides on one sheet.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dispatch_stops (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  sheet_id   INT NOT NULL,
  order_id   INT NOT NULL,
  seq        INT NOT NULL DEFAULT 0,
  cartons    INT NOT NULL DEFAULT 1,
  is_urgent  BOOLEAN NOT NULL DEFAULT FALSE,
  state      ENUM('pending','active','done','failed') NOT NULL DEFAULT 'pending',
  note       VARCHAR(255) DEFAULT NULL,
  UNIQUE KEY unique_order (order_id),
  INDEX idx_sheet (sheet_id, seq),
  FOREIGN KEY (sheet_id) REFERENCES dispatch_sheets(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- deliveries -- proof that goods reached a person (R06).
--
-- received_by is the NAME of whoever took the goods, not a user id -- it is the
-- shop boy, and he has no account. A successful delivery is required to carry
-- one, because a delivery with nobody's name against it proves nothing.
--
-- There is deliberately no party signature column. A signature scrawled on a
-- phone proves nothing about who held it, and chasing one at a counter is what
-- made drivers skip proof entirely. photo_ref is the evidence.
--
-- A failed attempt is a real result the day must record, hence status/reason
-- rather than simply no row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deliveries (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  order_id     INT NOT NULL,
  status       ENUM('delivered','undelivered') NOT NULL,
  received_by  VARCHAR(100) DEFAULT NULL,
  photo_ref    VARCHAR(255) DEFAULT NULL,
  reason       VARCHAR(60) DEFAULT NULL,
  latitude     DECIMAL(10,8) DEFAULT NULL,
  longitude    DECIMAL(11,8) DEFAULT NULL,
  delivered_by VARCHAR(20) DEFAULT NULL,
  delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_order (order_id),
  INDEX idx_status (status),
  FOREIGN KEY (order_id)     REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (delivered_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Purchase
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- purchases -- goods received. The only thing that adds stock without an order.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  supplier_name  VARCHAR(120) NOT NULL,
  invoice_no     VARCHAR(40) NOT NULL,
  purchase_date  DATE NOT NULL,
  sub_total      DECIMAL(15,2) NOT NULL DEFAULT 0,
  gst_amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
  grand_total    DECIMAL(15,2) NOT NULL DEFAULT 0,
  status         ENUM('draft','posted') NOT NULL DEFAULT 'draft',
  created_by     VARCHAR(20) DEFAULT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  posted_at      DATETIME DEFAULT NULL,
  -- One supplier cannot bill the same invoice number twice. Caught here rather
  -- than by a lookup, which would race two clerks keying the same docket.
  UNIQUE KEY unique_supplier_invoice (supplier_name, invoice_no),
  INDEX idx_date (purchase_date),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- purchase_items -- the received lines.
--
-- last_rate is the rate this item was previously bought at, copied in at entry
-- time. It is what the rate-alert screen reads, and storing it means the alert
-- survives the item master's cost being updated afterwards.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  purchase_id INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  qty         DECIMAL(15,4) NOT NULL,
  rate        DECIMAL(15,2) NOT NULL,
  last_rate   DECIMAL(15,2) DEFAULT NULL,
  gst_percent DECIMAL(5,2) DEFAULT 0,
  total       DECIMAL(15,2) NOT NULL,
  INDEX idx_purchase (purchase_id),
  INDEX idx_item (item_id, id),
  FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)     REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Returns and credit
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- sales_returns -- goods coming back from a party.
--
-- Accepting one writes `return` movements to stock_movements and recomputes the
-- cached quantity in the same transaction. The original sale's movements are
-- left exactly as they are: the ledger is append-only, so a return is new rows,
-- never an edit.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_returns (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  customer_id  INT NOT NULL,
  invoice_id   INT DEFAULT NULL,
  return_date  DATE NOT NULL,
  total_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  status       ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  note         VARCHAR(255) DEFAULT NULL,
  created_by   VARCHAR(20) DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customer (customer_id),
  INDEX idx_date (return_date),
  FOREIGN KEY (customer_id) REFERENCES customers(masterid),
  FOREIGN KEY (invoice_id)  REFERENCES invoices(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sales_return_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  return_id   INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  sold_qty    DECIMAL(15,4) NOT NULL,
  return_qty  DECIMAL(15,4) NOT NULL,
  rate        DECIMAL(15,2) NOT NULL,
  amount      DECIMAL(15,2) NOT NULL,
  reason      VARCHAR(60) DEFAULT NULL,
  INDEX idx_return (return_id),
  FOREIGN KEY (return_id) REFERENCES sales_returns(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)   REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- credit_notes -- money owed back to a party.
--
-- `pending` means promised but not yet posted to the ledger. That distinction is
-- the point of the table: an unissued credit is an understated liability at
-- month end, and it is the only figure on the screen that can still be wrong.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_notes (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  note_no     VARCHAR(30) NOT NULL,
  customer_id INT NOT NULL,
  invoice_id  INT DEFAULT NULL,
  return_id   INT DEFAULT NULL,
  amount      DECIMAL(15,2) NOT NULL,
  reason      VARCHAR(255) DEFAULT NULL,
  status      ENUM('pending','issued','cancelled') NOT NULL DEFAULT 'pending',
  note_date   DATE NOT NULL,
  issued_by   VARCHAR(20) DEFAULT NULL,
  issued_at   DATETIME DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_note_no (note_no),
  INDEX idx_customer (customer_id, status),
  FOREIGN KEY (customer_id) REFERENCES customers(masterid),
  FOREIGN KEY (invoice_id)  REFERENCES invoices(id) ON DELETE SET NULL,
  FOREIGN KEY (return_id)   REFERENCES sales_returns(id) ON DELETE SET NULL,
  FOREIGN KEY (issued_by)   REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Field sales
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- estimates -- a quote. Books nothing.
--
-- No stock is committed, no ledger row is written, and it never reaches the
-- approval queue. That is the whole reason it exists: quoting a builder should
-- not tie up goods someone else can sell today. Converting it creates a real
-- order, and converted_order_id records which.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estimates (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  customer_id        INT NOT NULL,
  estimate_date      DATE NOT NULL,
  valid_days         INT NOT NULL DEFAULT 7,
  total_amount       DECIMAL(15,2) NOT NULL DEFAULT 0,
  status             ENUM('draft','sent','converted','expired') NOT NULL DEFAULT 'draft',
  converted_order_id INT DEFAULT NULL,
  created_by         VARCHAR(20) DEFAULT NULL,
  created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customer (customer_id),
  INDEX idx_status (status),
  FOREIGN KEY (customer_id)        REFERENCES customers(masterid),
  FOREIGN KEY (converted_order_id) REFERENCES orders(order_id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)         REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS estimate_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  estimate_id INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  qty         DECIMAL(15,4) NOT NULL,
  rate        DECIMAL(15,2) NOT NULL,
  total       DECIMAL(15,2) NOT NULL,
  INDEX idx_estimate (estimate_id),
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)     REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- beat_plans / beat_stops -- the salesman's planned round for a day.
--
-- The service day comes from utils/businessDay.js, not from a UTC date: a plan
-- filed at 05:15 IST belongs to today, and toISOString().slice(0,10) would file
-- it under yesterday.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS beat_plans (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(20) NOT NULL,
  plan_date   DATE NOT NULL,
  beat_name   VARCHAR(150) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_employee_day (employee_id, plan_date),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS beat_stops (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  plan_id     INT NOT NULL,
  customer_id INT NOT NULL,
  seq         INT NOT NULL DEFAULT 0,
  state       ENUM('planned','next','done','skipped') NOT NULL DEFAULT 'planned',
  visited_at  DATETIME DEFAULT NULL,
  latitude    DECIMAL(10,8) DEFAULT NULL,
  longitude   DECIMAL(11,8) DEFAULT NULL,
  order_id    INT DEFAULT NULL,
  INDEX idx_plan (plan_id, seq),
  FOREIGN KEY (plan_id)     REFERENCES beat_plans(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(masterid),
  FOREIGN KEY (order_id)    REFERENCES orders(order_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Schemes
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- schemes / scheme_slabs / scheme_ledger -- electrician incentives.
--
-- As with agent commission, the reward is recorded against the electrician and
-- never printed on the party's invoice. scheme_ledger is append-only for the
-- same reason: what someone earned in June must not change in July.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schemes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(150) NOT NULL,
  starts_on  DATE NOT NULL,
  ends_on    DATE NOT NULL,
  is_active  BOOLEAN DEFAULT TRUE,
  note       VARCHAR(255) DEFAULT NULL,
  created_by VARCHAR(20) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_window (starts_on, ends_on),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheme_slabs (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  scheme_id   INT NOT NULL,
  min_qty     DECIMAL(15,4) NOT NULL,
  max_qty     DECIMAL(15,4) DEFAULT NULL,
  reward_rate DECIMAL(15,2) NOT NULL,
  reward_note VARCHAR(150) DEFAULT NULL,
  INDEX idx_scheme (scheme_id, min_qty),
  FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheme_ledger (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  scheme_id  INT NOT NULL,
  agent_id   INT NOT NULL,
  order_id   INT DEFAULT NULL,
  qty        DECIMAL(15,4) NOT NULL DEFAULT 0,
  earned     DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_scheme_agent (scheme_id, agent_id),
  FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)  REFERENCES agents(id),
  FOREIGN KEY (order_id)  REFERENCES orders(order_id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Cash and close
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- cheques -- collected, banked, cleared or bounced.
--
-- A bounced cheque keeps its row and its status rather than being deleted: the
-- money is not in, the party still owes it, and the history of the attempt is
-- what a payment dispute turns on.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cheques (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  cheque_no    VARCHAR(30) NOT NULL,
  customer_id  INT NOT NULL,
  bank_name    VARCHAR(120) DEFAULT NULL,
  amount       DECIMAL(15,2) NOT NULL,
  cheque_date  DATE NOT NULL,
  status       ENUM('to_deposit','deposited','cleared','bounced') NOT NULL DEFAULT 'to_deposit',
  deposited_at DATETIME DEFAULT NULL,
  cleared_at   DATETIME DEFAULT NULL,
  collected_by VARCHAR(20) DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_customer (customer_id),
  FOREIGN KEY (customer_id)  REFERENCES customers(masterid),
  FOREIGN KEY (collected_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- eod_closings -- one row per closed service day.
--
-- counted_cash is what was physically in the drawer; expected_cash is what the
-- ledger says. The variance is stored rather than recomputed, because the
-- figures behind it keep moving and the variance is a statement about a moment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS eod_closings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  close_date    DATE NOT NULL,
  opening_cash  DECIMAL(15,2) NOT NULL DEFAULT 0,
  cash_in       DECIMAL(15,2) NOT NULL DEFAULT 0,
  cheques_in    DECIMAL(15,2) NOT NULL DEFAULT 0,
  upi_in        DECIMAL(15,2) NOT NULL DEFAULT 0,
  expenses      DECIMAL(15,2) NOT NULL DEFAULT 0,
  expected_cash DECIMAL(15,2) NOT NULL DEFAULT 0,
  counted_cash  DECIMAL(15,2) NOT NULL DEFAULT 0,
  variance      DECIMAL(15,2) NOT NULL DEFAULT 0,
  note          VARCHAR(255) DEFAULT NULL,
  closed_by     VARCHAR(20) DEFAULT NULL,
  closed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_day (close_date),
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Stock count
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- stock_counts / stock_count_lines -- physical reconciliation.
--
-- Posting a count writes one `adjustment` movement per varied line and
-- recomputes the cached quantity. Nothing is edited: the count that found the
-- loss and the loss itself both stay in the ledger.
--
-- system_qty is snapshotted when the line is counted, so the variance recorded
-- is the one the counter actually saw, not one recomputed after later sales.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_counts (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  godown     VARCHAR(120) DEFAULT NULL,
  count_date DATE NOT NULL,
  status     ENUM('open','posted') NOT NULL DEFAULT 'open',
  started_by VARCHAR(20) DEFAULT NULL,
  started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  posted_at  DATETIME DEFAULT NULL,
  INDEX idx_date (count_date),
  FOREIGN KEY (started_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  count_id    INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  rack        VARCHAR(30) DEFAULT NULL,
  system_qty  DECIMAL(15,4) NOT NULL,
  counted_qty DECIMAL(15,4) DEFAULT NULL,
  variance    DECIMAL(15,4) DEFAULT NULL,
  UNIQUE KEY unique_count_item (count_id, item_id),
  INDEX idx_count (count_id),
  FOREIGN KEY (count_id) REFERENCES stock_counts(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)  REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ===========================================================================
-- Notifications
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- notifications -- what the business was told, and when.
--
-- user_id NULL means the alert is for everyone who can see it (a broadcast);
-- a value targets one person, which is how a verify mismatch reaches Yash.
--
-- Read state is a column rather than a delete: these rows are the audit trail of
-- what was raised, and a dismiss that loses that is worse than a long list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    VARCHAR(20) DEFAULT NULL,
  tone       ENUM('info','success','warning','danger') NOT NULL DEFAULT 'info',
  title      VARCHAR(150) NOT NULL,
  body       VARCHAR(500) DEFAULT NULL,
  actor      VARCHAR(60) DEFAULT NULL,
  ref_type   VARCHAR(20) DEFAULT NULL,
  ref_id     INT DEFAULT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_read (user_id, is_read, created_at),
  INDEX idx_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
