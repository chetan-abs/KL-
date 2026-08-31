-- ---------------------------------------------------------------------------
-- 008 — KL Utsav membership, dealer growth schemes, the 20-segment salesman
-- incentive, estimate follow-ups, FIFO payment matching and the dealer cash
-- discount.
--
-- Sources: KL_App_Requirements_FINAL.pdf sections 3.2, 3.3, 7, 9;
-- LEMAC_Developer_Master_v7.xlsx 'Discount & Scheme Reference';
-- rules R-18, R-19, R-22, R-23.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- schemes — the existing table modelled one shape: quantity slabs paying a
-- rate. Three shapes are now needed and they differ in what the slab is
-- measured in and what it pays:
--
--   electrician_gift  KL Utsav. Cumulative qualifying VALUE over 90 days,
--                     pays a physical gift, highest slab only.
--   growth_credit     Lemac modular monthly/yearly. Billing value in the
--                     window, pays a PERCENT as a credit note.
--   growth_gift       Lemac modular quarterly. Same measure, pays a gift.
--
-- period says which window the measure accumulates over, so the same scheme
-- row renews rather than being recreated every month.
-- ---------------------------------------------------------------------------
ALTER TABLE schemes
  ADD COLUMN kind ENUM('electrician_gift','growth_credit','growth_gift') NOT NULL DEFAULT 'electrician_gift' AFTER name,
  ADD COLUMN period ENUM('once','monthly','quarterly','yearly') NOT NULL DEFAULT 'once' AFTER kind,
  -- Which per-item validity flag on items gates membership of this scheme.
  -- Null means every item counts, which is what KL Utsav does (weighted).
  ADD COLUMN item_flag VARCHAR(30) DEFAULT NULL AFTER period,
  -- 3.2 — "If the registration falls within the first 30 days of the scheme
  -- launch, the system tags this member as an Early Bird automatically."
  ADD COLUMN early_bird_days INT NOT NULL DEFAULT 30 AFTER item_flag,
  -- "both the referring member and the new member receive Rs.5,000 added to
  -- their qualifying value."
  ADD COLUMN referral_bonus DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER early_bird_days,
  ADD INDEX idx_kind_active (kind, is_active);

-- ---------------------------------------------------------------------------
-- scheme_slabs — slabs are reached by VALUE in every scheme the documents
-- describe. min_qty stays for the quantity-slab shape the table was built for
-- and is simply unused by these.
-- ---------------------------------------------------------------------------
ALTER TABLE scheme_slabs
  ADD COLUMN slab_order INT NOT NULL DEFAULT 0 AFTER scheme_id,
  ADD COLUMN min_value DECIMAL(15,2) DEFAULT NULL AFTER max_qty,
  ADD COLUMN reward_percent DECIMAL(6,4) DEFAULT NULL AFTER reward_rate,
  ADD COLUMN reward_gift VARCHAR(120) DEFAULT NULL AFTER reward_percent,
  ADD INDEX idx_scheme_value (scheme_id, min_value);

-- ---------------------------------------------------------------------------
-- scheme_members — who is enrolled.
--
-- A member is a person, and the same person is a customer when they buy and an
-- agent when they refer. Keying membership on either one alone breaks the
-- other half: an electrician who buys for his own stock this week and brings a
-- customer next week is one member with two roles, and R-22 is precisely the
-- rule that the two must not both fire in one transaction. So membership has
-- its own identity, with optional links to both.
--
-- phone is the unique key because that is what the registration screen
-- searches on (3.1, 3.2) and what the business actually knows about an
-- electrician.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheme_members (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  scheme_id      INT NOT NULL,
  name           VARCHAR(120) NOT NULL,
  phone          VARCHAR(20) NOT NULL,
  profession     VARCHAR(60) DEFAULT NULL,
  area           VARCHAR(120) DEFAULT NULL,
  customer_id    INT DEFAULT NULL,
  agent_id       INT DEFAULT NULL,
  registered_on  DATE NOT NULL,
  is_early_bird  BOOLEAN NOT NULL DEFAULT FALSE,
  referred_by    INT DEFAULT NULL,
  -- A cache of scheme_ledger for this member, exactly like items.qty: the
  -- ledger is the truth and utils/scheme.js is the only writer.
  qualifying_total DECIMAL(15,2) NOT NULL DEFAULT 0,
  awarded_slab_id  INT DEFAULT NULL,
  awarded_at       DATETIME DEFAULT NULL,
  status         ENUM('active','awarded','lapsed') NOT NULL DEFAULT 'active',
  created_by     VARCHAR(20) DEFAULT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_scheme_phone (scheme_id, phone),
  INDEX idx_total (scheme_id, qualifying_total DESC),
  FOREIGN KEY (scheme_id)   REFERENCES schemes(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(masterid) ON DELETE SET NULL,
  FOREIGN KEY (agent_id)    REFERENCES agents(id) ON DELETE SET NULL,
  FOREIGN KEY (referred_by) REFERENCES scheme_members(id) ON DELETE SET NULL,
  FOREIGN KEY (awarded_slab_id) REFERENCES scheme_slabs(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- scheme_ledger — the existing table credits an AGENT. Qualifying value
-- accrues to a MEMBER, and a referral bonus accrues to no order at all, so the
-- ledger gains a member column and a source.
--
-- agent_id becomes nullable: a referral bonus row has a member and no agent.
-- ---------------------------------------------------------------------------
ALTER TABLE scheme_ledger
  MODIFY COLUMN agent_id INT DEFAULT NULL,
  ADD COLUMN member_id INT DEFAULT NULL AFTER agent_id,
  ADD COLUMN invoice_id INT DEFAULT NULL AFTER order_id,
  ADD COLUMN source ENUM('purchase','referral','adjustment') NOT NULL DEFAULT 'purchase' AFTER earned,
  ADD COLUMN note VARCHAR(200) DEFAULT NULL AFTER source,
  ADD INDEX idx_member (member_id, created_at),
  ADD CONSTRAINT fk_ledger_member  FOREIGN KEY (member_id)  REFERENCES scheme_members(id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_ledger_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- incentive_segments — the 20 rows of section 9.
--
-- target_kind exists because one of the twenty is not money: Precision Casing
-- is targeted at 4,000 PIECES. A single DECIMAL target column with a silent
-- unit would have measured it in rupees and paid nobody.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incentive_segments (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(80) NOT NULL,
  seq            INT NOT NULL DEFAULT 0,
  target_kind    ENUM('value','qty') NOT NULL DEFAULT 'value',
  monthly_target DECIMAL(15,2) NOT NULL,
  base_incentive DECIMAL(15,2) NOT NULL,
  -- "Their wire-related targets are set at double those of field salesmen."
  showroom_multiplier DECIMAL(5,2) NOT NULL DEFAULT 1,
  -- Which brands land in this segment. Matched case-insensitively against
  -- items.brand at import; an item matching nothing falls to the catch-all.
  match_brands   JSON DEFAULT NULL,
  is_catch_all   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE KEY unique_segment_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE items
  ADD COLUMN incentive_segment_id INT DEFAULT NULL AFTER incentive_category,
  ADD INDEX idx_incentive_segment (incentive_segment_id),
  ADD CONSTRAINT fk_item_segment FOREIGN KEY (incentive_segment_id)
      REFERENCES incentive_segments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- incentive_periods — one salesman-month.
--
-- Recomputed while draft, frozen on approval (R-18: payouts only through the
-- app, only after Yash's explicit approval).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incentive_periods (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  employee_id  VARCHAR(20) NOT NULL,
  period       CHAR(7) NOT NULL,
  -- Pulen and Prabal "share a combined incentive pool... The total earned
  -- incentive is split equally between the two." A showroom period is computed
  -- on the pair's combined sales and then halved.
  is_showroom  BOOLEAN NOT NULL DEFAULT FALSE,
  gross_payout DECIMAL(15,2) NOT NULL DEFAULT 0,
  share_pct    DECIMAL(6,4) NOT NULL DEFAULT 1,
  net_payout   DECIMAL(15,2) NOT NULL DEFAULT 0,
  status       ENUM('draft','approved','paid') NOT NULL DEFAULT 'draft',
  approved_by  VARCHAR(20) DEFAULT NULL,
  approved_at  DATETIME DEFAULT NULL,
  paid_on      DATE DEFAULT NULL,
  computed_at  DATETIME DEFAULT NULL,
  UNIQUE KEY unique_employee_period (employee_id, period),
  INDEX idx_period (period, status),
  FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- incentive_lines — one segment within a period.
--
-- achieved_gross and removed_unpaid are held apart rather than netted, because
-- R-19 is the rule the salesman most needs to see working: the sale counted,
-- then it was taken back out because the party had not paid in 60 days. One
-- net figure hides which of the two happened.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incentive_lines (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  period_id    INT NOT NULL,
  segment_id   INT NOT NULL,
  target       DECIMAL(15,2) NOT NULL DEFAULT 0,
  achieved_gross DECIMAL(15,2) NOT NULL DEFAULT 0,
  removed_unpaid DECIMAL(15,2) NOT NULL DEFAULT 0,
  achieved_net   DECIMAL(15,2) NOT NULL DEFAULT 0,
  achieved_pct   DECIMAL(8,4) NOT NULL DEFAULT 0,
  base_incentive DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- 0 / 0.8 / 1 / 1.1 per the four achievement slabs.
  payout_factor  DECIMAL(5,2) NOT NULL DEFAULT 0,
  payout         DECIMAL(15,2) NOT NULL DEFAULT 0,
  UNIQUE KEY unique_period_segment (period_id, segment_id),
  FOREIGN KEY (period_id)  REFERENCES incentive_periods(id) ON DELETE CASCADE,
  FOREIGN KEY (segment_id) REFERENCES incentive_segments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- estimates — validity, follow-up and the lost reasons of section 7.
-- ---------------------------------------------------------------------------
ALTER TABLE estimates
  ADD COLUMN valid_until DATE DEFAULT NULL AFTER valid_days,
  ADD COLUMN follow_up_on DATE DEFAULT NULL AFTER valid_until,
  ADD COLUMN attempts INT NOT NULL DEFAULT 0 AFTER follow_up_on,
  ADD COLUMN lost_reason VARCHAR(60) DEFAULT NULL AFTER attempts,
  ADD COLUMN closed_at DATETIME DEFAULT NULL AFTER lost_reason,
  ADD COLUMN shared_at DATETIME DEFAULT NULL AFTER closed_at,
  ADD INDEX idx_follow_up (follow_up_on, status);

ALTER TABLE estimates
  MODIFY COLUMN status ENUM('draft','sent','converted','expired','lost') NOT NULL DEFAULT 'draft';

ALTER TABLE estimates
  MODIFY COLUMN valid_days INT NOT NULL DEFAULT 15;

-- ---------------------------------------------------------------------------
-- estimate_followups — "After each follow-up attempt, the creator logs the
-- outcome and sets the next follow-up date. Maximum 3 follow-up attempts."
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS estimate_followups (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  estimate_id INT NOT NULL,
  seq         INT NOT NULL,
  due_on      DATE NOT NULL,
  done_at     DATETIME DEFAULT NULL,
  outcome     VARCHAR(60) DEFAULT NULL,
  note        VARCHAR(255) DEFAULT NULL,
  next_due_on DATE DEFAULT NULL,
  done_by     VARCHAR(20) DEFAULT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_estimate_seq (estimate_id, seq),
  FOREIGN KEY (estimate_id) REFERENCES estimates(id) ON DELETE CASCADE,
  FOREIGN KEY (done_by)     REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- invoices — what FIFO matching and the 60-day tests need.
--
-- amount_paid is a cache of payment_allocations, maintained by the same
-- transaction that writes an allocation. settled_on is the date the invoice
-- reached fully paid, which is the date R-19 measures against — not the date
-- of the last payment, which may have overpaid a different invoice.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN due_on DATE DEFAULT NULL AFTER invoice_date,
  ADD COLUMN amount_paid DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER grand_total,
  ADD COLUMN settled_on DATE DEFAULT NULL AFTER amount_paid,
  ADD COLUMN cd_percent DECIMAL(6,4) DEFAULT NULL AFTER settled_on,
  ADD COLUMN cd_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER cd_percent,
  ADD INDEX idx_open (customer_id, settled_on, invoice_date);

-- ---------------------------------------------------------------------------
-- payment_allocations — "Payment matching follows FIFO — the oldest unpaid
-- invoice is settled first." (3.3)
--
-- Without this table a payment is a number against a party and nobody can say
-- which invoice it cleared — which makes both the cash discount (a function of
-- the age of the invoice being settled) and the 60-day incentive rule
-- (a function of when a specific invoice was paid) uncomputable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_allocations (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  payment_id INT NOT NULL,
  invoice_id INT NOT NULL,
  amount     DECIMAL(15,2) NOT NULL,
  -- Days between the invoice date and the payment date, snapshotted because
  -- the discount band is decided on it and both dates could be corrected later.
  age_days   INT NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_payment (payment_id),
  INDEX idx_invoice (invoice_id),
  FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- cash_discount_bands — 0-2 days 2.5%, 3-10 days 2.0%, 11-20 days 1.0% (3.3).
--
-- Lemac's sheet states a different ladder for its own goods (30/45/60 days →
-- 3/2/1%), so the bands are rows with an optional scheme scope rather than a
-- constant in code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cash_discount_bands (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  label      VARCHAR(40) NOT NULL,
  min_days   INT NOT NULL,
  max_days   INT NOT NULL,
  percent    DECIMAL(6,4) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  INDEX idx_days (min_days, max_days)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO cash_discount_bands (label, min_days, max_days, percent) VALUES
  ('0 to 2 days',   0,  2, 0.0250),
  ('3 to 10 days',  3, 10, 0.0200),
  ('11 to 20 days', 11, 20, 0.0100);

-- ---------------------------------------------------------------------------
-- Staff sign-off on internal documents.
--
-- The delivery invariant stands: a party's signature scrawled on a phone
-- proves nothing, and the photograph is the proof. These are different — an
-- acknowledgement by an identified, authenticated member of staff that they
-- personally counted or loaded the goods. What carries the weight is the
-- account and the timestamp; the drawn image is kept because Ajit and the
-- drivers expect to sign, and it costs one nullable column.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN verified_by VARCHAR(20) DEFAULT NULL AFTER approved_at,
  ADD COLUMN verified_at DATETIME DEFAULT NULL AFTER verified_by,
  ADD COLUMN verify_sign_id INT DEFAULT NULL AFTER verified_at,
  ADD CONSTRAINT fk_order_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_order_sign     FOREIGN KEY (verify_sign_id) REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE dispatch_sheets
  ADD COLUMN driver_signed_at DATETIME DEFAULT NULL AFTER departure_time,
  ADD COLUMN driver_sign_id INT DEFAULT NULL AFTER driver_signed_at,
  -- "Departure time is expected at 10:30 a.m." — the threshold is a column so
  -- it can move without a deployment.
  ADD COLUMN expected_departure TIME NOT NULL DEFAULT '10:30:00' AFTER driver_sign_id,
  ADD CONSTRAINT fk_sheet_sign FOREIGN KEY (driver_sign_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- stock_counts — "the application randomly assigns 5 items to designated staff
-- members (Ajit and Hirak)... Staff are not informed in advance which items
-- will be selected." (section 10)
-- ---------------------------------------------------------------------------
ALTER TABLE stock_counts
  ADD COLUMN assigned_to VARCHAR(20) DEFAULT NULL AFTER count_date,
  ADD COLUMN is_auto BOOLEAN NOT NULL DEFAULT FALSE AFTER assigned_to,
  ADD CONSTRAINT fk_count_assignee FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- alert_log — the recurring sweeps.
--
-- A dozen rules in section 13 fire once per subject per day: EOD not submitted
-- by 7:15 p.m., departure not logged by 10:30 a.m., a cheque due today, a
-- dealer not visited, a salesman's GPS silent for 15 minutes. Each could carry
-- its own alerted_at column, and each would then need one; the sweep runs
-- hourly and a restart must not re-notify.
--
-- One row per (kind, subject, day), with the uniqueness doing the work: the
-- sweep inserts, and a duplicate key means it has already fired.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS alert_log (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  kind       VARCHAR(40) NOT NULL,
  ref_type   VARCHAR(24) NOT NULL DEFAULT '',
  ref_id     VARCHAR(40) NOT NULL DEFAULT '',
  on_date    DATE NOT NULL,
  detail     VARCHAR(255) DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_alert (kind, ref_type, ref_id, on_date),
  INDEX idx_date (on_date, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Yash's daily dashboard acknowledgement (section 12).
-- "Yash taps a 'Mark Reviewed' button daily... This timestamp is recorded."
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dashboard_reviews (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     VARCHAR(20) NOT NULL,
  review_date DATE NOT NULL,
  reviewed_at DATETIME NOT NULL,
  note        VARCHAR(255) DEFAULT NULL,
  UNIQUE KEY unique_user_day (user_id, review_date),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- beat_stops — "any dealer not visited must have a reason recorded" and the
-- flag raised when the check-in is nowhere near the dealer's address (D.2).
-- ---------------------------------------------------------------------------
ALTER TABLE beat_stops
  ADD COLUMN skip_reason VARCHAR(160) DEFAULT NULL AFTER state,
  ADD COLUMN distance_m INT DEFAULT NULL AFTER longitude,
  ADD COLUMN location_flagged BOOLEAN NOT NULL DEFAULT FALSE AFTER distance_m;
