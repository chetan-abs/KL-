-- Migration 001 — brings an existing database up to the current schema.sql.
--
-- Run against a database created before these changes:
--   mysql -u root -p kl_electricals < migrations/001_constraints_datetime_stock.sql
--
-- A database created fresh by scripts/init-db.js already has all of this and
-- does not need the migration.
--
-- Every statement here is non-destructive: no table is dropped and no row is
-- deleted. The TIMESTAMP -> DATETIME conversions rewrite values in place, which
-- is lossless while the session time zone is UTC (config/db.js pins it, and the
-- SET below does the same for a direct mysql client run).

SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- users — email uniqueness, self-referencing created_by, DATETIME audit columns
-- ---------------------------------------------------------------------------
ALTER TABLE users
  MODIFY email      VARCHAR(100) DEFAULT NULL,
  MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD UNIQUE KEY unique_email (email),
  ADD FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- holidays — created_by gains the foreign key orders already had
-- ---------------------------------------------------------------------------
ALTER TABLE holidays
  MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ADD FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- checkins — TIMESTAMP columns cannot represent 2038 and are silently
-- converted against the session time zone on every read and write
-- ---------------------------------------------------------------------------
ALTER TABLE checkins
  MODIFY checkin_time  DATETIME NOT NULL,
  MODIFY checkout_time DATETIME NULL DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- location_logs — DATETIME, plus the index the retention sweep needs
-- ---------------------------------------------------------------------------
ALTER TABLE location_logs
  MODIFY recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ADD INDEX idx_recorded_at (recorded_at);

-- ---------------------------------------------------------------------------
-- items — money widened to the DECIMAL(15,2) convention; qty made NOT NULL so
-- the cached stock level is always a number, never NULL
-- ---------------------------------------------------------------------------
ALTER TABLE items
  MODIFY rate       DECIMAL(15,2) NOT NULL DEFAULT 0,
  MODIFY qty        DECIMAL(15,4) NOT NULL DEFAULT 0,
  MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  MODIFY updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- stock_movements — the ledger that makes items.qty recomputable
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  item_id    INT NOT NULL,
  change_qty DECIMAL(15,4) NOT NULL,
  reason     ENUM('order','receipt','adjustment','return','opening') NOT NULL,
  ref_type   VARCHAR(20) DEFAULT NULL,
  ref_id     INT DEFAULT NULL,
  note       VARCHAR(255) DEFAULT NULL,
  created_by VARCHAR(20) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_item (item_id, created_at),
  INDEX idx_ref (ref_type, ref_id),
  FOREIGN KEY (item_id)    REFERENCES items(masterid),
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seeds the ledger from whatever items.qty already held, so the invariant
-- items.qty = SUM(stock_movements.change_qty) holds from here on. Inserts
-- nothing when there are no items or every qty is zero.
INSERT INTO stock_movements (item_id, change_qty, reason, note)
SELECT masterid, qty, 'opening', 'Opening balance captured by migration 001'
FROM items
WHERE qty <> 0;

-- ---------------------------------------------------------------------------
-- customers — latitude/longitude to the schema-wide precision
-- ---------------------------------------------------------------------------
ALTER TABLE customers
  MODIFY latitude   DECIMAL(10,8) DEFAULT NULL,
  MODIFY longitude  DECIMAL(11,8) DEFAULT NULL,
  MODIFY created_at DATETIME DEFAULT CURRENT_TIMESTAMP;

-- ---------------------------------------------------------------------------
-- orders / order_items — money and quantity widths
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  MODIFY total_amount DECIMAL(15,2) DEFAULT 0,
  MODIFY created_at   DATETIME DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE order_items
  MODIFY qty        DECIMAL(15,4) NOT NULL,
  MODIFY rate       DECIMAL(15,2) NOT NULL,
  MODIFY gst_amount DECIMAL(15,2) DEFAULT 0,
  MODIFY total      DECIMAL(15,2) NOT NULL;
