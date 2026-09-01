-- ---------------------------------------------------------------------------
-- 020 — 4.4, "Collection at delivery" (NEW, September 2026 sheet).
--
-- "The driver records cash or cheque collected at the point of delivery,
-- with a photo of the cheque, against that invoice, immediately."
--
-- `cheques.deposit_slip_photo_id` already exists but photographs the BANK
-- DEPOSIT slip, taken later by whoever deposits it — a different document
-- from the cheque itself, which nobody photographed at all until now. A
-- second column rather than reusing the first: overwriting the deposit
-- slip's own photo when the cheque is later deposited would lose the proof
-- that the cheque was collected as described in the first place.
-- ---------------------------------------------------------------------------
ALTER TABLE cheques
  ADD COLUMN photo_id INT DEFAULT NULL AFTER deposit_slip_photo_id,
  ADD CONSTRAINT fk_cheque_photo FOREIGN KEY (photo_id) REFERENCES attachments (id) ON DELETE SET NULL;
