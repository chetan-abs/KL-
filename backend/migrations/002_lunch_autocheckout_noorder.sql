-- Migration 002 — brings an existing database up to the current schema.sql.
--
--   mysql -u root -p kl_electricals < migrations/002_lunch_autocheckout_noorder.sql
--
-- A database created fresh by scripts/init-db.js already has all of this.
--
-- Two things are being fixed here:
--
--   1. Columns schema.sql declares that migration 001 never added. `checkins`
--      gained lunch_out_time, lunch_in_time and is_auto_checkout, and 001 only
--      converted checkin_time/checkout_time — so a database brought forward
--      with 001 alone answers /attendance/lunch-out with ER_BAD_FIELD_ERROR.
--
--   2. orders.is_no_order, which separates a visit that produced no order from
--      an order the customer cancelled. Both were stored as status 'cancelled'.
--
-- Every statement is guarded, so this is safe to run against a database that
-- already has some or all of these columns, and safe to run twice. MySQL has no
-- ADD COLUMN IF NOT EXISTS, hence the INFORMATION_SCHEMA lookups.

SET time_zone = '+00:00';

-- ---------------------------------------------------------------------------
-- checkins — lunch break window and the auto-checkout flag
-- ---------------------------------------------------------------------------

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkins' AND COLUMN_NAME = 'lunch_out_time') = 0,
  'ALTER TABLE checkins ADD COLUMN lunch_out_time DATETIME NULL DEFAULT NULL AFTER checkout_lng',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkins' AND COLUMN_NAME = 'lunch_in_time') = 0,
  'ALTER TABLE checkins ADD COLUMN lunch_in_time DATETIME NULL DEFAULT NULL AFTER lunch_out_time',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkins' AND COLUMN_NAME = 'is_auto_checkout') = 0,
  'ALTER TABLE checkins ADD COLUMN is_auto_checkout BOOLEAN DEFAULT FALSE AFTER lunch_in_time',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The check-in and check-out fixes, also absent from 001.
SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'checkins' AND COLUMN_NAME = 'checkin_lat') = 0,
  'ALTER TABLE checkins ADD COLUMN checkin_lat DECIMAL(10,8) DEFAULT NULL AFTER checkin_time,
                        ADD COLUMN checkin_lng DECIMAL(11,8) DEFAULT NULL AFTER checkin_lat,
                        ADD COLUMN checkout_lat DECIMAL(10,8) DEFAULT NULL AFTER checkout_time,
                        ADD COLUMN checkout_lng DECIMAL(11,8) DEFAULT NULL AFTER checkout_lat',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- holidays — the flags the attendance calendar reads
-- ---------------------------------------------------------------------------

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND COLUMN_NAME = 'is_custom') = 0,
  'ALTER TABLE holidays ADD COLUMN is_custom BOOLEAN DEFAULT FALSE AFTER name',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'holidays' AND COLUMN_NAME = 'is_active') = 0,
  'ALTER TABLE holidays ADD COLUMN is_active BOOLEAN DEFAULT TRUE AFTER is_custom',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- orders — no-order visits get their own column
-- ---------------------------------------------------------------------------

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'is_no_order') = 0,
  'ALTER TABLE orders ADD COLUMN is_no_order BOOLEAN NOT NULL DEFAULT FALSE AFTER status',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (SELECT IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND INDEX_NAME = 'idx_no_order') = 0,
  'ALTER TABLE orders ADD INDEX idx_no_order (is_no_order)',
  'DO 0'));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Rows written before the column existed: a cancelled order carrying the
-- marker the old code wrote into notes was a no-order visit, not a
-- cancellation. Anything else stays a real cancelled order.
UPDATE orders
   SET is_no_order = TRUE
 WHERE status = 'cancelled'
   AND notes LIKE '[NO ORDER REASON]%'
   AND is_no_order = FALSE;
