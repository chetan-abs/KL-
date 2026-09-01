-- ---------------------------------------------------------------------------
-- 023 — Section 6, September 2026: "NEW — two-step, with a damaged-goods
-- bucket."
--
-- v1's `sales_returns.status` went pending -> accepted in one action, and
-- that one action both took the stock back AND raised the credit note. The
-- sheet splits this into three people, three steps: whoever RECEIVES the
-- goods enters what they were told (status stays 'pending', stock does not
-- move); Sonu (or Hirak backing him up) PHYSICALLY checks and decides the
-- good/damaged split — this is the step that moves stock, and it is also the
-- one step the entry's own creator may never perform, so a receiver cannot
-- wave their own return through; only THEN may Gaurav raise the credit note,
-- and only against the approved figures.
--
-- `return_qty` on sales_return_items is now specifically what was ENTERED —
-- unchanged column, new meaning by contrast with `approved_qty`, which is
-- what Sonu actually counted. Both are kept, forever: "the system stores
-- both entered and actual, never overwriting" is the sheet's own sentence,
-- and it is what lets the EOD report show a receiver whose counts keep
-- disagreeing with Sonu's.
--
-- `damaged_stock` is a new, separate bucket rather than a status on
-- `items` — damaged goods are not sellable stock with an asterisk, they are
-- goods excluded from picking, billing and the minimum-stock alert
-- entirely, sitting in their own ageing report until someone disposes of
-- them.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_returns
  MODIFY COLUMN status ENUM('pending','approved','credited','accepted','rejected')
    NOT NULL DEFAULT 'pending',
  ADD COLUMN approved_by VARCHAR(20) DEFAULT NULL AFTER status,
  ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER approved_by,
  ADD CONSTRAINT fk_return_approver FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE sales_return_items
  ADD COLUMN approved_qty DECIMAL(15,4) DEFAULT NULL AFTER return_qty,
  ADD COLUMN good_qty DECIMAL(15,4) DEFAULT NULL AFTER approved_qty,
  ADD COLUMN damaged_qty DECIMAL(15,4) DEFAULT NULL AFTER good_qty,
  ADD COLUMN damaged_photo_id INT DEFAULT NULL AFTER damaged_qty,
  ADD CONSTRAINT fk_return_item_photo FOREIGN KEY (damaged_photo_id) REFERENCES attachments (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS damaged_stock (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  item_id         INT NOT NULL,
  item_name       VARCHAR(100) NOT NULL,
  return_id       INT DEFAULT NULL,
  return_item_id  INT DEFAULT NULL,
  qty             DECIMAL(15,4) NOT NULL,
  -- What each unit is worth for the weekly "damaged stock by value" report —
  -- the item's cost at the moment it was written off, not a live join to
  -- whatever the item master says today.
  unit_cost       DECIMAL(15,2) DEFAULT NULL,
  condition_note  VARCHAR(255) DEFAULT NULL,
  disposition     ENUM('undecided','claim','repair','scrap','second') NOT NULL DEFAULT 'undecided',
  disposition_note VARCHAR(255) DEFAULT NULL,
  disposed_by     VARCHAR(20) DEFAULT NULL,
  disposed_at     DATETIME DEFAULT NULL,
  created_by      VARCHAR(20) DEFAULT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_item (item_id),
  INDEX idx_disposition (disposition),
  FOREIGN KEY (item_id)        REFERENCES items (masterid) ON DELETE CASCADE,
  FOREIGN KEY (return_id)      REFERENCES sales_returns (id) ON DELETE SET NULL,
  FOREIGN KEY (return_item_id) REFERENCES sales_return_items (id) ON DELETE SET NULL,
  FOREIGN KEY (disposed_by)    REFERENCES users (id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)     REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
