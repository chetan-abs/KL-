-- ---------------------------------------------------------------------------
-- 011 — R-11: a rate change is proposed, then approved.
--
--   "Gaurav can initiate a rate adjustment but cannot approve it. Only Yash or
--    Manoj can approve."
--
-- R-04 and R-11 are easy to read as one rule and are two. R-04 says Gaurav is
-- the only person who may touch a rate at all — the control is invisible to
-- everyone else. R-11 says that touching it produces a REQUEST, not a change.
--
-- Without this table the two collapsed into "Gaurav edits rates", which is R-04
-- satisfied and R-11 ignored: a rate could move without an owner ever seeing it.
--
-- One row per field per item per request, rather than a JSON blob of changes:
-- an owner approves a specific number moving from a specific value to another
-- specific value, and a blob cannot be approved line by line or read back six
-- months later as "who agreed to 55%".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_rate_changes (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  item_id      INT NOT NULL,
  item_name    VARCHAR(100) NOT NULL,

  -- The column being changed, validated by the route against its own
  -- allow-list. Stored as text because the set of pricing columns is a
  -- property of the schema, and an enum here would need a migration every time
  -- a customer type was added.
  field        VARCHAR(40) NOT NULL,
  old_value    DECIMAL(15,6) DEFAULT NULL,
  new_value    DECIMAL(15,6) DEFAULT NULL,

  -- Grouped, so a single "adjust this item" submission is approved or rejected
  -- as one decision rather than field by field. Null for a change raised alone.
  batch_ref    VARCHAR(32) DEFAULT NULL,

  reason       VARCHAR(255) DEFAULT NULL,
  status       ENUM('pending','approved','rejected','superseded') NOT NULL DEFAULT 'pending',
  requested_by VARCHAR(20) DEFAULT NULL,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by   VARCHAR(20) DEFAULT NULL,
  decided_at   DATETIME DEFAULT NULL,
  decision_note VARCHAR(255) DEFAULT NULL,

  -- What the value actually was at the moment of approval. The request may sit
  -- for days while a second one is raised against the same field, so the value
  -- applied is not necessarily the old_value the proposer saw — and the
  -- difference is exactly what an audit would ask about.
  applied_from DECIMAL(15,6) DEFAULT NULL,

  INDEX idx_pending (status, requested_at),
  INDEX idx_item (item_id, status),
  INDEX idx_batch (batch_ref),
  FOREIGN KEY (item_id)      REFERENCES items(masterid) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (decided_by)   REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
