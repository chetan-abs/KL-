-- ---------------------------------------------------------------------------
-- 007 — Purchase types, Goods in Transit, the GST-bill countdown, and the
-- credit-note SLA.
--
-- Source: KL_App_Requirements_FINAL.pdf section 5 and rules R-08, R-09, R-10,
-- R-12, R-13, R-15.
--
-- Purchases arrive in five forms and the form decides three otherwise
-- unrelated things: when the Tally entry may be made, whether a 7-day GST
-- countdown starts, and whether the consignment is tracked in transit. Those
-- are held as one enum plus the columns each form needs, rather than five
-- tables, because everything downstream — the register, the reports — reads
-- them as one list of purchases.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- suppliers — "Supplier or Company name (searchable from master)" (5.1).
--
-- The existing purchases table carries supplier_name as free text, which is
-- why "Polycab", "Polycab Ltd" and "polycab" are three suppliers. The column
-- stays for what is already recorded; new entries carry supplier_id as well.
--
-- city drives the expected-arrival suggestion ("Delhi + 5 days, Mumbai + 7"),
-- so the lead time lives on the supplier rather than in a lookup in code.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(120) NOT NULL,
  city          VARCHAR(60) DEFAULT NULL,
  state         VARCHAR(60) DEFAULT NULL,
  phone         VARCHAR(20) DEFAULT NULL,
  gst_number    VARCHAR(20) DEFAULT NULL,
  -- Days from dispatch to expected arrival in Guwahati. Editable per entry.
  lead_days     INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_supplier_name (name),
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- transporters — freight is tracked per LR number AND per transporter (5.2),
-- which the second of those makes a master rather than a text field.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transporters (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  phone      VARCHAR(20) DEFAULT NULL,
  city       VARCHAR(60) DEFAULT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_transporter_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- git_entries — Goods in Transit.
--
-- This table exists BEFORE the purchase it becomes. "When a bilty or LR number
-- is received (typically via WhatsApp), Sibu immediately enters it into the
-- application. No Tally entry is made at this stage." So purchase_id is
-- nullable and filled in when Sonu receives the goods; modelling GIT as
-- columns on purchases would have required inventing a purchase for a
-- consignment nobody has seen.
--
-- Applies to the two outside forms (O-B, O-C) only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS git_entries (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  lr_number      VARCHAR(60) NOT NULL,
  supplier_id    INT DEFAULT NULL,
  supplier_name  VARCHAR(120) NOT NULL,
  transporter_id INT DEFAULT NULL,
  transporter_name VARCHAR(120) DEFAULT NULL,
  dispatch_date  DATE DEFAULT NULL,
  expected_date  DATE DEFAULT NULL,
  -- 'issue' is a terminal-ish state for shortage or damage found on receipt;
  -- it does not stop the goods being received, it records that they were not
  -- what the bilty said.
  status         ENUM('pending','arrived','received','issue') NOT NULL DEFAULT 'pending',
  arrived_at     DATETIME DEFAULT NULL,
  received_at    DATETIME DEFAULT NULL,
  -- Freight tracking (5.2): who bears it and how much.
  freight_type   ENUM('paid','to_pay') DEFAULT NULL,
  freight_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- Set when the goods are received and the purchase entry is raised.
  purchase_id    INT DEFAULT NULL,
  -- The two overdue escalations (2 days → Sibu, 5+ days → Yash) each fire once.
  -- Recorded here rather than inferred from notifications, so re-running the
  -- sweep after a restart does not re-notify.
  reminded_at    DATETIME DEFAULT NULL,
  escalated_at   DATETIME DEFAULT NULL,
  note           VARCHAR(255) DEFAULT NULL,
  bilty_photo_id INT DEFAULT NULL,
  created_by     VARCHAR(20) DEFAULT NULL,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_lr (lr_number),
  INDEX idx_status_expected (status, expected_date),
  FOREIGN KEY (supplier_id)    REFERENCES suppliers(id) ON DELETE SET NULL,
  FOREIGN KEY (transporter_id) REFERENCES transporters(id) ON DELETE SET NULL,
  FOREIGN KEY (purchase_id)    REFERENCES purchases(id) ON DELETE SET NULL,
  FOREIGN KEY (bilty_photo_id) REFERENCES attachments(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by)     REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- purchases — the five forms and the states they move through.
--
-- The existing unique key on (supplier_name, invoice_no) has to go: a challan
-- purchase has no invoice number at all, and two of them would collide on the
-- empty string. The replacement is scoped to the document that actually
-- identifies the entry.
-- ---------------------------------------------------------------------------
ALTER TABLE purchases
  DROP INDEX unique_supplier_invoice;

ALTER TABLE purchases
  ADD COLUMN purchase_type ENUM('LB','LC','C','OB','OC') NOT NULL DEFAULT 'LB' AFTER id,
  ADD COLUMN supplier_id INT DEFAULT NULL AFTER purchase_type,

  -- R-13: mandatory when the type is challan-based. Enforced at the route,
  -- because "mandatory depending on type" is not a column constraint.
  ADD COLUMN challan_no VARCHAR(40) DEFAULT NULL AFTER invoice_no,

  ADD COLUMN git_id INT DEFAULT NULL AFTER challan_no,

  -- The document state, which is not the workflow state. A challan purchase is
  -- 'unregistered' in Tally until the GST bill arrives and converts it.
  ADD COLUMN doc_state ENUM('registered','unregistered','converted') NOT NULL DEFAULT 'registered' AFTER status,

  -- The 7-day countdown (5.3). Starts on submission for L-C, on physical
  -- receipt for O-C — the difference is when the row is written, not a
  -- different column.
  ADD COLUMN gst_due_on DATE DEFAULT NULL AFTER doc_state,
  ADD COLUMN gst_bill_no VARCHAR(40) DEFAULT NULL AFTER gst_due_on,
  ADD COLUMN gst_received_at DATETIME DEFAULT NULL AFTER gst_bill_no,
  ADD COLUMN gst_alerted_at DATETIME DEFAULT NULL AFTER gst_received_at,

  -- "Sujay or Dishal receives the goods and submits the entry under their own
  -- name... Sonu must physically review... before Sibu can proceed with the
  -- Tally entry." received_by is who took delivery; verified_by is Sonu.
  ADD COLUMN received_by VARCHAR(20) DEFAULT NULL AFTER created_by,
  ADD COLUMN verified_by VARCHAR(20) DEFAULT NULL AFTER received_by,
  ADD COLUMN verified_at DATETIME DEFAULT NULL AFTER verified_by,

  -- 5.4 — Sibu may hold the entry for Yash's review when a rate has moved.
  -- Yash is notified either way, so 'none' is only ever set by there being no
  -- change to report.
  ADD COLUMN rate_alert ENUM('none','held','proceeded') NOT NULL DEFAULT 'none' AFTER verified_at,
  ADD COLUMN rate_alert_note VARCHAR(255) DEFAULT NULL AFTER rate_alert,

  -- R-15: "Any entry created by Sibu must be approved by a different user."
  ADD COLUMN approved_by VARCHAR(20) DEFAULT NULL AFTER rate_alert_note,
  ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER approved_by,

  ADD INDEX idx_type_state (purchase_type, doc_state),
  ADD INDEX idx_gst_due (gst_due_on),
  ADD UNIQUE KEY unique_supplier_doc (supplier_name, purchase_type, invoice_no, challan_no),
  ADD CONSTRAINT fk_purchase_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_purchase_git      FOREIGN KEY (git_id)      REFERENCES git_entries(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_purchase_receiver FOREIGN KEY (received_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_purchase_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_purchase_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- The workflow state gains the two waiting rooms between receiving and posting.
ALTER TABLE purchases
  MODIFY COLUMN status ENUM('draft','awaiting_verification','verified','posted','held') NOT NULL DEFAULT 'draft';

-- ---------------------------------------------------------------------------
-- purchase_items — R-08.
--
-- "Bill Quantity (as stated on the invoice or challan), and Actual Quantity
-- (physically counted by the receiver). These are always two separate fields.
-- They may differ. The application records both values independently."
--
-- The existing qty column becomes the actual quantity — it is what moves stock
-- — and bill_qty is added beside it. Both are recorded; neither is derived
-- from the other, and the shortage/excess flag is derived from the pair.
-- ---------------------------------------------------------------------------
ALTER TABLE purchase_items
  ADD COLUMN bill_qty DECIMAL(15,4) NOT NULL DEFAULT 0 AFTER item_name,
  ADD COLUMN goods_condition ENUM('ok','damaged','short','excess') NOT NULL DEFAULT 'ok' AFTER qty,
  ADD COLUMN condition_note VARCHAR(160) DEFAULT NULL AFTER goods_condition,
  -- Set when the rate differs from this item's previous purchase rate (5.4).
  -- last_rate already exists; this is the judgement, kept beside it so the
  -- register can list the alerts without recomputing a comparison per row.
  ADD COLUMN rate_changed BOOLEAN NOT NULL DEFAULT FALSE AFTER last_rate;

-- Existing rows predate the split, so their bill quantity is their quantity.
UPDATE purchase_items SET bill_qty = qty WHERE bill_qty = 0;

-- ---------------------------------------------------------------------------
-- sales_returns — R-09 and R-10.
--
-- The 2-hour credit-note SLA is a due timestamp on the return, not a job
-- queue: the alert sweep asks which returns are past due and have no issued
-- credit note, which is one indexed query rather than a scheduled task per
-- return that a restart would lose.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_returns
  ADD COLUMN reason VARCHAR(60) DEFAULT NULL AFTER status,
  ADD COLUMN photo_id INT DEFAULT NULL AFTER reason,
  ADD COLUMN cn_due_at DATETIME DEFAULT NULL AFTER photo_id,
  ADD COLUMN cn_alerted_at DATETIME DEFAULT NULL AFTER cn_due_at,
  ADD INDEX idx_cn_due (cn_due_at),
  ADD CONSTRAINT fk_return_photo FOREIGN KEY (photo_id) REFERENCES attachments(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- credit_notes — "requires approval from Yash or Manoj before the party's
-- ledger is updated" (5.5). The existing 'issued' status is what moves
-- closing_balance; approval has to happen before it, so it needs its own pair
-- of columns rather than reusing issued_by/issued_at.
-- ---------------------------------------------------------------------------
ALTER TABLE credit_notes
  ADD COLUMN approved_by VARCHAR(20) DEFAULT NULL AFTER issued_at,
  ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER approved_by,
  -- Cash-discount notes are generated by the system on payment (3.3), not
  -- raised by anyone against a return, and the Cash Discount Report needs to
  -- tell the two apart.
  ADD COLUMN origin ENUM('return','cash_discount','manual') NOT NULL DEFAULT 'return' AFTER reason,
  ADD COLUMN payment_id INT DEFAULT NULL AFTER origin,
  ADD INDEX idx_origin (origin),
  ADD CONSTRAINT fk_cn_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_cn_payment  FOREIGN KEY (payment_id)  REFERENCES payments(id) ON DELETE SET NULL;
