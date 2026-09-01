-- ---------------------------------------------------------------------------
-- 025 — 8, "Daily cash count": "physical cash entered against the app
-- figure and confirmed by TWO different users — the cash holder plus one
-- other." A close still writes immediately (the money is already whatever
-- it is, unchanged from the standing "a variance does not block the close"
-- rule) — this is a SECOND signature on the same figure, not a second
-- count, and it is what the sheet's own line means by "this is the control
-- that lets the cash holder also verify paperwork": Sibu can hand the
-- drawer over and get on with the paperwork once someone else has looked.
-- ---------------------------------------------------------------------------
ALTER TABLE eod_closings
  ADD COLUMN confirmed_by VARCHAR(20) DEFAULT NULL AFTER closed_at,
  ADD COLUMN confirmed_at DATETIME DEFAULT NULL AFTER confirmed_by,
  ADD CONSTRAINT fk_eod_confirmer FOREIGN KEY (confirmed_by) REFERENCES users (id) ON DELETE SET NULL;
