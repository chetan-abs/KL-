-- ---------------------------------------------------------------------------
-- 006 — Shifts, geotagged attendance, leave, salary and advances.
--
-- Sources: KL_App_Requirements_FINAL.pdf section 6, and the addendum's
-- sections A (salary), B (advances) and C (attendance), rules R-24, R-25,
-- R-27, R-28, R-29, R-30.
--
-- The standing invariant is that attendance is DERIVED from checkins against
-- the working calendar and is never stored as a status. That still holds: no
-- table here records "present" or "absent". What is stored is the shift an
-- employee belongs to (an input, not a derivation), the photograph that makes
-- a check-in valid, and — once a month is closed — the money consequences,
-- because Yash may waive an individual deduction and a waiver has to survive.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- shifts — two of them, but as rows rather than an enum: the grace period and
-- the half-day cut-off are numbers management adjusts, and an enum would put
-- them in code where changing 6:00 p.m. means a deployment.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shifts (
  code            VARCHAR(8) PRIMARY KEY,
  name            VARCHAR(40) NOT NULL,
  starts_at       TIME NOT NULL,
  -- Check-in at or before this is On Time; after it is Late (C.2).
  grace_until     TIME NOT NULL,
  ends_at         TIME NOT NULL,
  -- Check-out before this is a Half Day (R-25).
  half_day_before TIME NOT NULL,
  -- No check-in this many minutes after the start is Absent (C.2).
  absent_after_minutes INT NOT NULL DEFAULT 60,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO shifts (code, name, starts_at, grace_until, ends_at, half_day_before)
VALUES
  ('A', 'Shift A', '10:00:00', '10:10:00', '18:45:00', '18:00:00'),
  ('B', 'Shift B', '11:00:00', '11:10:00', '20:00:00', '19:00:00')
ON DUPLICATE KEY UPDATE name = VALUES(name);

-- ---------------------------------------------------------------------------
-- users — shift membership, pay, and whether their check-in location is
-- expected to be the workplace.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN shift_code VARCHAR(8) DEFAULT NULL AFTER role,

  -- "The salary amount is editable only by Yash or Manoj" (A.1). The column is
  -- guarded by the salary.manage grant, not by role.
  ADD COLUMN fixed_salary DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER shift_code,

  -- "For showroom and godown staff, check-in must occur within a reasonable
  -- proximity of the workplace... For field salesmen the check-in location is
  -- recorded but not geofenced" (C.2). False for the three salesmen.
  ADD COLUMN geofenced BOOLEAN NOT NULL DEFAULT TRUE AFTER fixed_salary,

  ADD CONSTRAINT fk_user_shift FOREIGN KEY (shift_code) REFERENCES shifts(code) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- workplaces — what "reasonable proximity" is measured against. Two sites
-- (Lakhtokia and Fatashil), so a table rather than a pair of env vars.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workplaces (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(60) NOT NULL,
  latitude   DECIMAL(10,8) NOT NULL,
  longitude  DECIMAL(11,8) NOT NULL,
  radius_m   INT NOT NULL DEFAULT 300,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- checkins — the photograph, the shift the day was judged against, and the
-- two derived flags.
--
-- is_late and is_half_day are stored rather than recomputed on read, and that
-- is a deliberate exception to "attendance is derived". They are judgements
-- against the shift timings AS THEY STOOD THAT DAY. Management adjusts the
-- grace period; recomputing last March against today's grace would silently
-- rewrite deductions already paid out.
-- ---------------------------------------------------------------------------
ALTER TABLE checkins
  -- R-24: the check-in is not recorded until the photograph is uploaded, so
  -- in practice this is never null on a row written by the app. It is
  -- nullable only because rows written before this migration have no photo.
  ADD COLUMN checkin_photo_id  INT DEFAULT NULL AFTER checkin_lng,
  ADD COLUMN checkout_photo_id INT DEFAULT NULL AFTER checkout_lng,

  ADD COLUMN shift_code   VARCHAR(8) DEFAULT NULL AFTER checkin_date,
  ADD COLUMN is_late      BOOLEAN NOT NULL DEFAULT FALSE AFTER is_auto_checkout,
  ADD COLUMN late_minutes INT NOT NULL DEFAULT 0 AFTER is_late,
  ADD COLUMN is_half_day  BOOLEAN NOT NULL DEFAULT FALSE AFTER late_minutes,

  -- "The application flags if check-in occurs at an unusual location" (C.2).
  -- A flag, not a block: a genuine reason to be elsewhere is common enough
  -- that blocking would stop the day rather than start it.
  ADD COLUMN location_flagged BOOLEAN NOT NULL DEFAULT FALSE AFTER is_half_day,
  ADD COLUMN location_note VARCHAR(160) DEFAULT NULL AFTER location_flagged,

  ADD INDEX idx_late (checkin_date, is_late),
  ADD CONSTRAINT fk_checkin_photo  FOREIGN KEY (checkin_photo_id)  REFERENCES attachments(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_checkout_photo FOREIGN KEY (checkout_photo_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- leave_requests — "Approved leave days are not marked as absent-without-
-- information" (C.6), which is the difference between one day's pay and two
-- (R-29).
--
-- Named leave_requests, not leave: LEAVE is a reserved word in MariaDB.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leave_requests (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  employee_id VARCHAR(20) NOT NULL,
  from_date   DATE NOT NULL,
  to_date     DATE NOT NULL,
  reason      VARCHAR(255) DEFAULT NULL,
  status      ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  decided_by  VARCHAR(20) DEFAULT NULL,
  decided_at  DATETIME DEFAULT NULL,
  decision_note VARCHAR(255) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- The absence check is "was this date covered by an approved leave", so the
  -- range is the index rather than the employee alone.
  INDEX idx_employee_range (employee_id, from_date, to_date),
  INDEX idx_status (status),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (decided_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- advances — sanctioned, then recovered in equal monthly instalments (B.1).
--
-- "Multiple advances can be active simultaneously. Each is tracked
-- independently", so recovery is per advance and the salary ledger sums them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advances (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   VARCHAR(20) NOT NULL,
  amount        DECIMAL(15,2) NOT NULL,
  months        INT NOT NULL,
  -- Held rather than derived as amount/months: the last instalment absorbs the
  -- rounding, so dividing on read would leave a few paise outstanding forever.
  monthly_amount DECIMAL(15,2) NOT NULL,
  reason        VARCHAR(255) DEFAULT NULL,
  status        ENUM('pending','approved','rejected','closed') NOT NULL DEFAULT 'pending',
  requested_by  VARCHAR(20) DEFAULT NULL,
  approved_by   VARCHAR(20) DEFAULT NULL,
  approved_at   DATETIME DEFAULT NULL,
  -- Recovery starts the month after approval unless set otherwise.
  starts_month  CHAR(7) DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_employee (employee_id, status),
  FOREIGN KEY (employee_id)  REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approved_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- advance_recoveries — the ledger that makes "total recovered so far" and
-- "balance remaining" answerable (B.1).
--
-- Append-only, one row per advance per month, unique on the pair so running a
-- salary period twice cannot recover the same instalment twice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS advance_recoveries (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  advance_id INT NOT NULL,
  period     CHAR(7) NOT NULL,
  amount     DECIMAL(15,2) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_advance_period (advance_id, period),
  FOREIGN KEY (advance_id) REFERENCES advances(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- salary_periods — one employee-month (A.1).
--
-- period is CHAR(7) 'YYYY-MM' rather than a DATE pinned to the first of the
-- month: every query against it is an equality on the month, and a DATE
-- invites someone comparing it to a real date.
--
-- Draft periods are recomputed from attendance on every read. Finalising
-- freezes the numbers and writes the deduction lines, because after that point
-- the figures are what somebody was paid.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salary_periods (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  employee_id   VARCHAR(20) NOT NULL,
  period        CHAR(7) NOT NULL,
  fixed_salary  DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- Fixed Monthly Salary / 26 working days (C.4). Snapshotted so a mid-year
  -- change to the divisor cannot rewrite a closed month.
  daily_rate    DECIMAL(15,2) NOT NULL DEFAULT 0,
  working_days  INT NOT NULL DEFAULT 0,
  days_present  INT NOT NULL DEFAULT 0,
  days_late     INT NOT NULL DEFAULT 0,
  half_days     INT NOT NULL DEFAULT 0,
  days_absent_informed   INT NOT NULL DEFAULT 0,
  days_absent_uninformed INT NOT NULL DEFAULT 0,
  attendance_deduction   DECIMAL(15,2) NOT NULL DEFAULT 0,
  advance_deduction      DECIMAL(15,2) NOT NULL DEFAULT 0,
  other_deduction        DECIMAL(15,2) NOT NULL DEFAULT 0,
  net_payable   DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- R-30: finalised and paid only after approval, and both dates recorded.
  status        ENUM('draft','finalised','approved','paid') NOT NULL DEFAULT 'draft',
  approved_by   VARCHAR(20) DEFAULT NULL,
  approved_at   DATETIME DEFAULT NULL,
  paid_on       DATE DEFAULT NULL,
  note          VARCHAR(255) DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY unique_employee_period (employee_id, period),
  INDEX idx_period (period, status),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- salary_deductions — "Each deduction is shown as a separate line item in the
-- monthly salary ledger" and "Yash may manually waive any deduction with a
-- reason. The waiver is logged." (C.4)
--
-- A waiver is a flag on the line, never a delete: the deduction was earned and
-- then forgiven, and both halves are facts. The line stays visible on the slip.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS salary_deductions (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  period_id  INT NOT NULL,
  kind       ENUM('late','half_day','absent_informed','absent_uninformed','advance','other') NOT NULL,
  on_date    DATE DEFAULT NULL,
  detail     VARCHAR(160) DEFAULT NULL,
  amount     DECIMAL(15,2) NOT NULL,
  waived     BOOLEAN NOT NULL DEFAULT FALSE,
  waive_reason VARCHAR(255) DEFAULT NULL,
  waived_by  VARCHAR(20) DEFAULT NULL,
  waived_at  DATETIME DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_period (period_id),
  FOREIGN KEY (period_id) REFERENCES salary_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (waived_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
