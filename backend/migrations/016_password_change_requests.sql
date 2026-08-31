-- ---------------------------------------------------------------------------
-- 016 — A voluntary password change is proposed, then approved.
--
-- Business decision (not in KL_App_Requirements_FINAL.pdf, which lets staff
-- change their own password directly): only Yash or Manoj may put a new
-- password into effect. An employee's request sits here until one of them
-- decides it, the same shape R-11 already uses for a rate.
--
-- The MANDATORY first change (migration 015, `must_change_password`) is
-- deliberately NOT routed through this table. That gate exists because a
-- seeded password is known to more than one person and must be replaced
-- immediately — an account stuck behind an approval it cannot reach anybody
-- to grant would be locked out of the app entirely, which is the exact
-- failure the gate exists to prevent. Only a voluntary change, from an
-- account already past that gate, is approval-gated.
--
-- The new password is stored hashed, not plain, from the moment it is
-- typed — an approval queue is not an exemption from "never store a
-- password in the clear", it is a second place the rule applies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_change_requests (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   VARCHAR(20) NOT NULL,
  new_password  VARCHAR(255) NOT NULL,   -- bcrypt hash, same as users.password

  status        ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  requested_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by    VARCHAR(20) DEFAULT NULL,
  decided_at    DATETIME DEFAULT NULL,
  decision_note VARCHAR(255) DEFAULT NULL,

  INDEX idx_employee_status (employee_id, status),
  INDEX idx_pending (status, requested_at),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
