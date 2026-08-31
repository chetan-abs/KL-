-- ---------------------------------------------------------------------------
-- 012 — Tally Prime synchronisation, and the last three handover flows.
--
-- Sources: KL_App_Requirements_FINAL.pdf section 14 (Tally), 4.8 (the godown
-- photo), 8 (salesman collections handed to Sibu).
--
-- Section 14 asks for "real-time bidirectional synchronisation with Tally
-- Prime" and says "the technical method of integration is at the development
-- team's discretion". The method chosen is Tally's own HTTP/XML gateway, which
-- Tally Prime exposes on port 9000 when "Act as Server" is enabled. No ODBC, no
-- file drop, no third-party connector.
--
-- Three decisions shape these tables, and each is load-bearing.
--
-- 1. AN OUTBOX, NOT A DIRECT CALL.
--    Tally runs on a Windows desktop in the office. It is closed at night,
--    during backups, and whenever somebody reboots. A push attempted inline
--    inside the invoice transaction would either fail the invoice — refusing to
--    bill because an accounting package is shut — or be lost silently, which is
--    worse: a document Tally never receives and nobody knows about.
--    So every syncable event enqueues a row here IN THE SAME TRANSACTION as the
--    business write, and a worker drains the queue. "Real-time" then means the
--    worker runs continuously, not that the HTTP call blocks a salesman.
--
-- 2. NOTHING IS BIDIRECTIONAL PER RECORD.
--    Section 14 lists nine App→Tally flows and six Tally→App, and they cover
--    DIFFERENT entities. Documents (orders, invoices, vouchers, receipts) only
--    ever go one way: we author them. Masters (parties, items) only ever come
--    the other: Tally authors them. That is what makes the sync tractable
--    without conflict resolution, and it is why there is no "last write wins"
--    anywhere in this design. A record with two authors would need one.
--
-- 3. TALLY'S STOCK AND BALANCE FIGURES ARE RECONCILED, NEVER APPLIED.
--    Section 14 asks for "Current stock levels" and "Outstanding balances per
--    party" to flow Tally→App. Writing them into items.qty and
--    customers.closing_balance would destroy the standing invariant that both
--    are caches of OUR ledgers — after one pull, items.qty would no longer
--    equal SUM(stock_movements.change_qty) and nothing in the app could be
--    trusted to explain a number again.
--    So a pull lands in tally_reconciliation as a comparison, and a variance is
--    reported for a human to resolve. That is what "sync" can honestly mean for
--    a derived figure: the two systems are checked against each other, and a
--    disagreement is a finding rather than a silent overwrite.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- tally_queue — the outbox.
--
-- One row per document per direction attempt. `payload` holds the Tally XML as
-- built at enqueue time, not regenerated at send time: the document must reach
-- Tally as it was when the event happened, even if somebody edits a name
-- afterwards. It also means a failed push can be inspected verbatim.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tally_queue (
  id           INT AUTO_INCREMENT PRIMARY KEY,

  -- What kind of voucher this becomes in Tally. Named for the requirement's own
  -- rows in the section 14 table, so the two can be read side by side.
  kind         ENUM(
                 'sales_order','sales_invoice','credit_note','purchase_voucher',
                 'unregistered_purchase','purchase_conversion','cash_discount_note',
                 'stock_journal','receipt','ledger_master','item_master'
               ) NOT NULL,

  -- Our own document. ref_type/ref_id deliberately not a foreign key, the same
  -- reasoning as stock_movements: cancelling a document must not erase the
  -- record that it was sent to Tally.
  ref_type     VARCHAR(24) NOT NULL,
  ref_id       INT NOT NULL,

  payload      MEDIUMTEXT NOT NULL,

  status       ENUM('pending','sending','sent','failed','skipped') NOT NULL DEFAULT 'pending',
  attempts     INT NOT NULL DEFAULT 0,
  last_error   VARCHAR(500) DEFAULT NULL,

  -- Tally's own identifier for the voucher it created, so a re-push updates
  -- rather than duplicating. Tally returns a MASTERID and a VOUCHERKEY; the key
  -- is what an ALTER request addresses.
  tally_voucher_key VARCHAR(80) DEFAULT NULL,
  tally_master_id   VARCHAR(40) DEFAULT NULL,

  -- Not before this time. Used for backoff, so a Tally that is closed for the
  -- night is not hammered 3,600 times before morning.
  next_attempt_at DATETIME DEFAULT NULL,

  enqueued_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at      DATETIME DEFAULT NULL,
  enqueued_by  VARCHAR(20) DEFAULT NULL,

  -- One live queue row per document per kind. A second approval of the same
  -- order must not enqueue the invoice twice, and the uniqueness is what
  -- guarantees it rather than a check somebody has to remember.
  UNIQUE KEY unique_document (kind, ref_type, ref_id),
  INDEX idx_drain (status, next_attempt_at, id),
  FOREIGN KEY (enqueued_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- tally_links — our id ↔ Tally's identity, per entity.
--
-- Separate from the queue because a link outlives any one push: an invoice
-- pushed today and amended next week addresses the same Tally voucher, and the
-- queue row for the first push may have been pruned.
--
-- For masters coming the other way, this is what stops a party pulled twice
-- becoming two customers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tally_links (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  entity       ENUM('customer','item','supplier','order','invoice','credit_note',
                    'purchase','payment','transfer') NOT NULL,
  local_id     VARCHAR(40) NOT NULL,

  -- Tally identifies masters by NAME (its ledgers are name-keyed) and vouchers
  -- by GUID. Both are recorded because a rename in Tally is otherwise
  -- indistinguishable from a new party.
  tally_name   VARCHAR(200) DEFAULT NULL,
  tally_guid   VARCHAR(80) DEFAULT NULL,
  tally_master_id VARCHAR(40) DEFAULT NULL,

  -- The last state we know both sides agreed on, for the pull to detect drift.
  synced_at    DATETIME DEFAULT NULL,
  last_hash    VARCHAR(64) DEFAULT NULL,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_entity_local (entity, local_id),
  INDEX idx_guid (entity, tally_guid),
  INDEX idx_name (entity, tally_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- tally_sync_runs — what the worker did, and when.
--
-- Without this, "is the sync working?" has no answer except reading logs on a
-- server nobody can reach. The dashboard reads the latest row per direction.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tally_sync_runs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  direction     ENUM('push','pull') NOT NULL,
  scope         VARCHAR(40) NOT NULL,
  started_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME DEFAULT NULL,
  ok_count      INT NOT NULL DEFAULT 0,
  fail_count    INT NOT NULL DEFAULT 0,
  -- Whether Tally answered at all. The difference between "Tally rejected our
  -- invoice" and "Tally is switched off" is the whole diagnosis.
  reachable     BOOLEAN NOT NULL DEFAULT TRUE,
  note          VARCHAR(500) DEFAULT NULL,
  INDEX idx_recent (direction, scope, started_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- tally_reconciliation — where Tally's derived figures land.
--
-- NOT applied to items.qty or customers.closing_balance. See decision 3 at the
-- top of this file: those are caches of our own ledgers, and overwriting them
-- from another system means no figure in the app can be explained again.
--
-- A row here says "on this date, Tally said X and we said Y". A non-zero
-- variance is a finding for somebody to resolve — usually a document one system
-- has and the other does not, which is exactly what a reconciliation is for.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tally_reconciliation (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  as_at        DATE NOT NULL,
  entity       ENUM('item_stock','party_balance','purchase_rate') NOT NULL,
  local_id     VARCHAR(40) NOT NULL,
  label        VARCHAR(200) DEFAULT NULL,
  tally_value  DECIMAL(15,4) DEFAULT NULL,
  local_value  DECIMAL(15,4) DEFAULT NULL,
  variance     DECIMAL(15,4) DEFAULT NULL,
  resolved_at  DATETIME DEFAULT NULL,
  resolved_by  VARCHAR(20) DEFAULT NULL,
  resolution   VARCHAR(255) DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_snapshot (as_at, entity, local_id),
  INDEX idx_variance (entity, as_at, resolved_at),
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Historical purchase rates come the other way too (section 14), and they feed
-- the rate-change alert of 5.4. Kept on the item rather than in
-- reconciliation, because this one IS ours to store: a rate Tally holds from
-- before the app existed is a fact we did not have.
ALTER TABLE items
  ADD COLUMN tally_last_purchase_rate DECIMAL(15,2) DEFAULT NULL AFTER cost_price,
  ADD COLUMN tally_last_purchase_on DATE DEFAULT NULL AFTER tally_last_purchase_rate;

-- ---------------------------------------------------------------------------
-- collection_handovers — section 8.
--
--   "Cash collected by a salesman must be deposited with Sibu on the same day.
--    Cheques collected must be entered in the application and physically handed
--    to Sibu."
--
-- Two people and two moments: the salesman declares what he is bringing in, and
-- Sibu confirms what he actually received. Collapsing them into one row that
-- Sibu fills in loses the declaration, and the declaration is the only record
-- of a shortfall.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collection_handovers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   VARCHAR(20) NOT NULL,
  handover_date DATE NOT NULL,

  declared_cash   DECIMAL(15,2) NOT NULL DEFAULT 0,
  declared_cheques INT NOT NULL DEFAULT 0,
  declared_cheque_value DECIMAL(15,2) NOT NULL DEFAULT 0,

  -- Null until Sibu counts it. The gap between declared and received is the
  -- entire reason this table has two sets of columns.
  received_cash   DECIMAL(15,2) DEFAULT NULL,
  received_cheques INT DEFAULT NULL,

  status        ENUM('declared','received','disputed') NOT NULL DEFAULT 'declared',
  received_by   VARCHAR(20) DEFAULT NULL,
  received_at   DATETIME DEFAULT NULL,
  variance      DECIMAL(15,2) DEFAULT NULL,
  note          VARCHAR(255) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One declaration per person per day: the rule is "deposited with Sibu on the
  -- same day", so the day is the unit.
  UNIQUE KEY unique_employee_day (employee_id, handover_date),
  INDEX idx_open (status, handover_date),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- day_closings — section 4.8.
--
--   "Ajit updates the application with final order statuses by 7 p.m. and sends
--    a godown photo to Yash."
--
-- A separate act from Sibu's EOD at 7:15 (eod_closings, which is money). This
-- one is the godown: the statuses are final and here is what the floor looked
-- like. The photograph is the point, so it is mandatory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_closings (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  close_date   DATE NOT NULL,
  godown_photo_id INT NOT NULL,
  open_orders  INT NOT NULL DEFAULT 0,
  note         VARCHAR(255) DEFAULT NULL,
  closed_by    VARCHAR(20) DEFAULT NULL,
  closed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_day (close_date),
  FOREIGN KEY (godown_photo_id) REFERENCES attachments(id),
  FOREIGN KEY (closed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- orders — D.2's landmark, and how it was obtained.
--
--   "Name of the location or nearest landmark (reverse geocoded from
--    coordinates)"
--
-- `gps_place` already holds the name. What was missing is where the name came
-- from: a client-supplied string and a server-side geocode are different levels
-- of evidence, and "Yash can view exactly where the salesman was" depends on
-- knowing which. A salesman who can type the place name can type the wrong one.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN gps_place_source ENUM('client','geocoded','manual') DEFAULT NULL AFTER gps_place;
