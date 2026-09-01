-- ---------------------------------------------------------------------------
-- 022 — Billing, September 2026 sheet.
--
-- "Round-off: capped at ₹10 per invoice." A discretionary adjustment Gaurav
-- may apply at billing (rounding a total to what was verbally agreed), not
-- the sub-paisa rounding money() already does everywhere — bounded so it
-- cannot become a second, unaudited discount channel.
--
-- "Bill verification: exception-based. Sibu reviews only: manually changed
-- rate, below cost, discount above the set percentage, credit/debit note
-- above the set value, GST or HSN mismatch, plus a daily random 10% sample.
-- All other bills issue automatically." "100% manual checking is not
-- control — it is a queue... control comes from rule-based flags plus a
-- sample, reviewed daily." That "reviewed daily" is the tell: this is a
-- post-issue flag Sibu clears when he gets to it, not a pre-issue block —
-- an invoice still issues (and still pushes to Tally, still credits any
-- scheme) the moment Gaurav raises it, exactly as before. `flagged_reason`
-- is why it needs a look; `reviewed_by`/`reviewed_at` is Sibu clearing it.
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN round_off DECIMAL(6,2) NOT NULL DEFAULT 0.00 AFTER grand_total,
  ADD COLUMN flagged_reason VARCHAR(500) DEFAULT NULL AFTER round_off,
  ADD COLUMN reviewed_by VARCHAR(20) DEFAULT NULL AFTER flagged_reason,
  ADD COLUMN reviewed_at DATETIME DEFAULT NULL AFTER reviewed_by,
  ADD CONSTRAINT fk_invoice_reviewer FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL;
