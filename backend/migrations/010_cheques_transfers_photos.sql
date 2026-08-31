-- ---------------------------------------------------------------------------
-- 010 — Cheque handling, internal transfers, and the remaining mandatory
-- photographs.
--
-- Sources: KL_App_Requirements_FINAL.pdf sections 4.1, 4.3, 4.6, 11;
-- rules R-05, R-06, R-14.
--
-- Closes the last of the non-negotiable rules that had no schema behind them.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- cheques — section 11.
--
-- The table already records the PARTY's bank ("bank name (party's bank)").
-- What was missing is everything after that: which KL account it goes into,
-- who carried it there, and the photograph of the deposit slip that R-06 makes
-- mandatory.
--
--   "Sibu selects the cheques to be deposited and specifies the KL bank
--    account (ICICI / SBI / other) for each. Sibu hands the physical cheques
--    to Damodar with instructions. Damodar deposits the cheques, photographs
--    the deposit slip, and uploads it in the application."
--
-- Three distinct people touch one cheque, so three distinct stamps. Collapsing
-- them into one "deposited_at" loses the handover, which is the step where a
-- cheque actually goes missing.
-- ---------------------------------------------------------------------------
ALTER TABLE cheques
  -- Which of KL's own accounts it is being paid into. Free text rather than an
  -- enum: the document names ICICI and SBI and then says "other", so an enum
  -- would need altering the first time a third account is opened.
  ADD COLUMN deposit_bank VARCHAR(60) DEFAULT NULL AFTER bank_name,
  ADD COLUMN deposit_instruction VARCHAR(255) DEFAULT NULL AFTER deposit_bank,

  -- Sibu hands over; Damodar carries and deposits.
  ADD COLUMN handed_to VARCHAR(20) DEFAULT NULL AFTER collected_by,
  ADD COLUMN handed_at DATETIME DEFAULT NULL AFTER handed_to,
  ADD COLUMN deposited_by VARCHAR(20) DEFAULT NULL AFTER handed_at,

  -- R-06. The cheque is not marked deposited without it.
  ADD COLUMN deposit_slip_photo_id INT DEFAULT NULL AFTER deposited_by,

  -- "Yash and the relevant salesman receive an immediate notification" on a
  -- bounce. Which salesman is a property of the party, but the cheque may have
  -- been collected in the field by someone else, so it is recorded here.
  ADD COLUMN salesman_id VARCHAR(20) DEFAULT NULL AFTER deposit_slip_photo_id,

  ADD INDEX idx_due (cheque_date, status),
  ADD CONSTRAINT fk_cheque_handed FOREIGN KEY (handed_to) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_cheque_depositor FOREIGN KEY (deposited_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_cheque_slip FOREIGN KEY (deposit_slip_photo_id) REFERENCES attachments(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_cheque_salesman FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE SET NULL;

-- A cheque moves through more states than the original four. 'handed' is the
-- gap between Sibu releasing it and the bank receiving it — the step where a
-- physical cheque is in somebody's pocket.
--
-- The original enum's first state was 'to_deposit'. 'received' is the better
-- name — section 11 opens "When a cheque is received, Sibu records it" — but
-- renaming a value an enum already holds is a data migration, not a MODIFY:
-- dropping 'to_deposit' in one statement turns every row holding it into the
-- empty string, and those cheques then fall out of every status filter in the
-- app with no error anywhere.
--
-- So the value is added, the rows are moved, and only then is the old value
-- dropped. Three statements because MariaDB gives no way to do it in one.
ALTER TABLE cheques
  MODIFY COLUMN status ENUM(
    'to_deposit','received','handed','deposited','cleared','bounced','cancelled'
  ) NOT NULL DEFAULT 'to_deposit';

UPDATE cheques SET status = 'received' WHERE status = 'to_deposit';

ALTER TABLE cheques
  MODIFY COLUMN status ENUM('received','handed','deposited','cleared','bounced','cancelled')
    NOT NULL DEFAULT 'received';

-- ---------------------------------------------------------------------------
-- godown_register_acks — R-05.
--
--   "A valid SO number must be entered in the physical godown register before
--    picking begins. App enforces acknowledgement."
--   "When picking from the Berlia or Fan godown, the picker must first record
--    the SO number in the physical godown register before picking begins."
--
-- The app cannot see the paper register, so what it enforces is the
-- acknowledgement: the picker states that they have written the SO number down,
-- and that statement is timestamped against their account before any pick is
-- accepted. That is the honest reading of "enforces acknowledgement" — the app
-- makes the step unskippable and attributable, not verified.
--
-- Keyed per (order, godown) because an order can draw from more than one, and
-- each has its own register on its own wall.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS godown_register_acks (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT NOT NULL,
  godown     VARCHAR(40) NOT NULL,
  so_number  VARCHAR(24) DEFAULT NULL,
  acked_by   VARCHAR(20) NOT NULL,
  acked_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_order_godown (order_id, godown),
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE,
  FOREIGN KEY (acked_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- internal_transfers — R-14.
--
--   "Gaurav must create the Tally Stock Journal entry on the same day a
--    transfer is received. If not done, Yash is notified the next day."
--
-- Stock moving between the two premises is not a purchase and not a sale, so it
-- cannot ride on either table: both would move the company's total stock, and a
-- transfer does not. It is two opposing movements against one document.
--
-- `journal_done_at` is what the next-day sweep looks for. Held as a nullable
-- timestamp rather than a boolean so the alert can say how late it is.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS internal_transfers (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  transfer_no    VARCHAR(24) DEFAULT NULL,
  from_godown    VARCHAR(40) NOT NULL,
  to_godown      VARCHAR(40) NOT NULL,
  transfer_date  DATE NOT NULL,
  status         ENUM('sent','received','cancelled') NOT NULL DEFAULT 'sent',
  note           VARCHAR(255) DEFAULT NULL,
  sent_by        VARCHAR(20) DEFAULT NULL,
  received_by    VARCHAR(20) DEFAULT NULL,
  received_at    DATETIME DEFAULT NULL,
  -- R-14: the Tally stock journal, due the same day the transfer is received.
  journal_done_at DATETIME DEFAULT NULL,
  journal_by     VARCHAR(20) DEFAULT NULL,
  journal_alerted_at DATETIME DEFAULT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_transfer_no (transfer_no),
  INDEX idx_journal_due (status, journal_done_at),
  FOREIGN KEY (sent_by)     REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (journal_by)  REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS internal_transfer_items (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  transfer_id INT NOT NULL,
  item_id     INT NOT NULL,
  item_name   VARCHAR(100) NOT NULL,
  sent_qty    DECIMAL(15,4) NOT NULL,
  -- Counted at the receiving end. The same two-field discipline as a purchase
  -- (R-08): what was sent and what arrived are separate facts.
  received_qty DECIMAL(15,4) DEFAULT NULL,
  INDEX idx_transfer (transfer_id),
  FOREIGN KEY (transfer_id) REFERENCES internal_transfers(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id)     REFERENCES items(masterid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- The ledger needs a reason for a transfer leg, or the two movements look like
-- an unexplained adjustment pair.
ALTER TABLE stock_movements
  MODIFY COLUMN reason ENUM('order','receipt','adjustment','return','opening','transfer')
    NOT NULL;

-- ---------------------------------------------------------------------------
-- The two optional photographs of section 4.
--
-- Both are explicitly optional in the document — "Optional: The user may
-- photograph a handwritten order note" (4.1) and "the application provides the
-- option to photograph the material" (4.3) — so neither is enforced. They are
-- columns rather than nothing because the document says who may see them:
-- "accessible to Yash, Manas, Ajit, and the relevant salesman".
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN order_photo_id INT DEFAULT NULL AFTER duplicate_ack,
  ADD CONSTRAINT fk_order_photo FOREIGN KEY (order_photo_id) REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE order_picks
  ADD COLUMN photo_id INT DEFAULT NULL AFTER note,
  ADD CONSTRAINT fk_pick_photo FOREIGN KEY (photo_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- estimates — the WhatsApp share of section 7 records who sent what, and when.
-- `shared_at` already exists; this says where it went, because the party may
-- have more than one number and "sent" without "to whom" cannot be chased.
-- ---------------------------------------------------------------------------
ALTER TABLE estimates
  ADD COLUMN shared_to VARCHAR(20) DEFAULT NULL AFTER shared_at,
  ADD COLUMN shared_by VARCHAR(20) DEFAULT NULL AFTER shared_to,
  ADD CONSTRAINT fk_estimate_sharer FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- salary_periods — A.2, the salary slip.
--
-- "Yash can share the salary slip with the employee directly through the
-- application. Salary slips are stored month-wise in the employee profile."
--
-- The slip is generated from the period and its deduction lines, so nothing
-- about its content needs storing. What needs storing is that it was sent —
-- otherwise "I never got my slip" has no answer either way.
-- ---------------------------------------------------------------------------
ALTER TABLE salary_periods
  ADD COLUMN slip_shared_at DATETIME DEFAULT NULL AFTER paid_on,
  ADD COLUMN slip_shared_by VARCHAR(20) DEFAULT NULL AFTER slip_shared_at,
  ADD CONSTRAINT fk_slip_sharer FOREIGN KEY (slip_shared_by) REFERENCES users(id) ON DELETE SET NULL;
