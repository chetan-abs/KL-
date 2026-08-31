-- Migration 004 — payments and attachments.
--
--   npm run migrate
--
-- payments is what customers.closing_balance was always missing: the column was
-- read across the app and written by nothing. It is now a cache of invoices,
-- payments and issued credit notes, maintained by recomputeBalance() in
-- utils/workflow.js — never written on its own.
--
-- attachments backs the delivery photo (R06). Files live on the API host under
-- backend/uploads and are served through an authenticated route, because they
-- are photographs of identified people's premises.
--
-- Both statements are CREATE TABLE IF NOT EXISTS and safe to run twice.

SET time_zone = '+00:00';

-- ===========================================================================
-- Payments
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- payments -- money actually received against a party's account.
--
-- This is what customers.closing_balance was always missing. The column was
-- reported on across the app -- the approval screen's "Outstanding", the
-- register's ageing -- while nothing ever wrote it, so every figure derived
-- from it was whatever had been seeded.
--
-- closing_balance is now a CACHE of this table and invoices, in exactly the way
-- items.qty is a cache of stock_movements:
--
--   closing_balance = SUM(invoices.grand_total  WHERE status='issued')
--                   - SUM(payments.amount)
--                   - SUM(credit_notes.amount   WHERE status='issued')
--
-- maintained inside the same transaction as the row that changed it. Never
-- write it on its own; call recomputeBalance() in utils/workflow.js.
--
-- cheque_id links a cheque-mode receipt back to the instrument, so a bounce can
-- find the payment it invalidated.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  receipt_no   VARCHAR(30) NOT NULL,
  customer_id  INT NOT NULL,
  invoice_id   INT DEFAULT NULL,
  cheque_id    INT DEFAULT NULL,
  amount       DECIMAL(15,2) NOT NULL,
  mode         ENUM('cash','cheque','upi','bank') NOT NULL DEFAULT 'cash',
  payment_date DATE NOT NULL,
  note         VARCHAR(255) DEFAULT NULL,
  status       ENUM('received','reversed') NOT NULL DEFAULT 'received',
  collected_by VARCHAR(20) DEFAULT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_receipt_no (receipt_no),
  INDEX idx_customer (customer_id, payment_date),
  INDEX idx_invoice (invoice_id),
  INDEX idx_date (payment_date),
  FOREIGN KEY (customer_id)  REFERENCES customers(masterid),
  FOREIGN KEY (invoice_id)   REFERENCES invoices(id) ON DELETE SET NULL,
  FOREIGN KEY (cheque_id)    REFERENCES cheques(id) ON DELETE SET NULL,
  FOREIGN KEY (collected_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- attachments -- files captured in the field.
--
-- A delivery photo is the proof of delivery (R06), so the file has to live
-- somewhere the row can point at. Stored on the API host's disk under
-- backend/uploads and served through an authenticated route -- these are
-- photographs of identified people's premises, and a public static mount would
-- make the whole delivery history readable to anyone who guessed a filename.
--
-- The row records who uploaded what and against which document; `stored_name`
-- is the on-disk name, which is generated and never the client's own filename.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attachments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  stored_name   VARCHAR(120) NOT NULL,
  original_name VARCHAR(255) DEFAULT NULL,
  mime_type     VARCHAR(60) DEFAULT NULL,
  byte_size     INT DEFAULT NULL,
  ref_type      VARCHAR(20) DEFAULT NULL,
  ref_id        INT DEFAULT NULL,
  uploaded_by   VARCHAR(20) DEFAULT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_stored_name (stored_name),
  INDEX idx_ref (ref_type, ref_id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
