-- ---------------------------------------------------------------------------
-- 018 — September 2026 role sheet, sections 3.2 and 3.3.
--
-- 3.2 "Selling below the rate — approval slabs". v1 sent every R-11 rate
-- request to an owner regardless of size. The new sheet tiers it: up to 2%
-- below the current rate auto-applies (logged, and counted in the EOD
-- exception report); more than 2% needs Sibu; below cost (R-16) still needs
-- an owner. `tier` records which applied and `variance_percent` is what
-- decided it — both are what the EOD report and the approval screen read.
--
-- 3.3 "Credit limit and 60-day overdue — CHANGED FROM v1". v1 let a blocked
-- order proceed with only a notification (see the R-16/R-17 comments in
-- routes/orders.js this migration's route change replaces). The new sheet
-- makes both a hard block at punch, liftable only by Yash or Manoj, and every
-- lift must be logged — `order_overrides` is that log.
-- ---------------------------------------------------------------------------

-- item_rate_changes already got `tier`/`variance_percent` and the widened
-- status enum from an earlier partial run of this file (migrate.js stops on
-- first failure and does not roll back what already committed) — this
-- migration is re-run idempotently below via IF NOT EXISTS / conditional
-- guards where the ALTER itself cannot be repeated safely.

CREATE TABLE IF NOT EXISTS order_overrides (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT NOT NULL,
  -- 'credit_limit' or 'overdue_60' — an order can trip both at once, which is
  -- two rows, not one row with a comma-joined reason nobody can query on.
  kind          VARCHAR(20) NOT NULL,
  overridden_by VARCHAR(20) NOT NULL,
  note          VARCHAR(255) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_order (order_id),
  FOREIGN KEY (order_id)      REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (overridden_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
