-- ---------------------------------------------------------------------------
-- 024 — Section 5, September 2026.
--
-- 5.1 "Beyond the set %: reason mandatory from a fixed list" — the reason
-- Sonu (or whoever enters) gave for a rate move past the configured
-- threshold. Nullable: most rate changes never cross the threshold, and
-- PURCHASE_RATE_REASON_THRESHOLD is itself unset by default.
--
-- 5, "Short-supply claims" — "wherever bill qty and actual qty differ, auto-
-- create a claim against that company with value. Track raised / accepted /
-- credited, with ageing." R-08 already keeps bill_qty and qty as two
-- separate mandatory fields; this table is what turns that difference into
-- a trackable claim instead of a number nobody follows up on.
-- ---------------------------------------------------------------------------
ALTER TABLE purchase_items
  ADD COLUMN rate_change_reason VARCHAR(40) DEFAULT NULL AFTER rate_changed;

CREATE TABLE IF NOT EXISTS purchase_claims (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  purchase_id     INT NOT NULL,
  purchase_item_id INT NOT NULL,
  item_id         INT NOT NULL,
  item_name       VARCHAR(100) NOT NULL,
  supplier_name   VARCHAR(120) NOT NULL,
  bill_qty        DECIMAL(15,4) NOT NULL,
  actual_qty      DECIMAL(15,4) NOT NULL,
  short_qty       DECIMAL(15,4) NOT NULL,
  rate            DECIMAL(15,2) NOT NULL,
  value           DECIMAL(15,2) NOT NULL,
  -- No supplier-side credit-note table exists in this schema (credit_notes
  -- is scoped to our own customers) — 'credited' here just means the claim
  -- was settled, by whatever means (a supplier credit, a price adjustment
  -- on the next bill), recorded in `note`.
  status          ENUM('raised','accepted','credited','rejected') NOT NULL DEFAULT 'raised',
  note            VARCHAR(255) DEFAULT NULL,
  decided_by      VARCHAR(20) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at      DATETIME DEFAULT NULL,

  INDEX idx_status (status, created_at),
  INDEX idx_purchase (purchase_id),
  FOREIGN KEY (purchase_id)      REFERENCES purchases (id) ON DELETE CASCADE,
  FOREIGN KEY (purchase_item_id) REFERENCES purchase_items (id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)          REFERENCES items (masterid) ON DELETE CASCADE,
  FOREIGN KEY (decided_by)       REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
