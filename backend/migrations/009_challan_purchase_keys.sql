-- ---------------------------------------------------------------------------
-- 009 — A challan purchase has no invoice number.
--
-- `purchases.invoice_no` was NOT NULL from the original schema, which was
-- correct when every purchase carried a GST bill. Three of the five forms in
-- section 5 do not: L-C, O-C and sometimes C arrive on a delivery challan and
-- the bill follows within seven days. Receiving one failed with
-- "Column 'invoice_no' cannot be null".
--
-- The unique key needs the same treatment, and NULL is what makes it work.
-- 008 replaced the original (supplier_name, invoice_no) with a four-column key
-- covering both document numbers, which sounds thorough and is not: a row with
-- a NULL in any column of a UNIQUE key never collides with anything, so a
-- challan purchase — NULL invoice_no — was unconstrained.
--
-- Two keys instead, one per document kind. Each ignores the rows that do not
-- carry its document, because those rows have NULL in it:
--
--   (supplier_name, purchase_type, invoice_no)  constrains bill purchases
--   (supplier_name, purchase_type, challan_no)  constrains challan purchases
--
-- A challan purchase that later receives its GST bill fills invoice_no in and
-- becomes subject to the first key too, which is exactly right — that is the
-- moment a duplicate bill number would matter.
-- ---------------------------------------------------------------------------

ALTER TABLE purchases
  MODIFY COLUMN invoice_no VARCHAR(40) DEFAULT NULL;

ALTER TABLE purchases
  DROP INDEX unique_supplier_doc;

ALTER TABLE purchases
  ADD UNIQUE KEY unique_supplier_bill (supplier_name, purchase_type, invoice_no),
  ADD UNIQUE KEY unique_supplier_challan (supplier_name, purchase_type, challan_no);
