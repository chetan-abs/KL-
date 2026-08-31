-- ---------------------------------------------------------------------------
-- 014 — The return penalty, as a capability that is off until configured.
--
-- Source: LEMAC_Developer_Master_v7.xlsx, 'Discount & Scheme Reference', under
-- FREIGHT & KEY POLICY:
--
--   "Return policy: 20% penalty on any product returned; 80% credit note if
--    saleable."
--
-- This is the one rule in the spreadsheets that changes MONEY A CUSTOMER
-- RECEIVES, and it is not in the requirements PDF — section 5.5 describes the
-- returns flow in detail and says nothing about a penalty. So it is built as a
-- per-item rate that DEFAULTS TO NOTHING: every item's penalty is NULL, every
-- return credits in full exactly as it does today, and the behaviour changes
-- only when somebody sets a rate deliberately.
--
-- Deliberately not applied to the Lemac range during import. The sheet is a
-- Lemac trade document; whether K.L. Electricals passes that penalty on to its
-- own customers is a decision the business takes, and quietly writing 20% onto
-- 451 items would have started short-paying refunds without anybody asking for
-- it.
--
-- To switch it on for the Lemac range:
--   UPDATE items SET return_penalty_percent = 0.20
--    WHERE brand LIKE 'Lemac%' OR name LIKE 'Lemac%';
-- ---------------------------------------------------------------------------

ALTER TABLE items
  -- A fraction, like every other percentage in this schema (0.20, not 20).
  -- NULL means no penalty, which is not the same as 0.0000 — the first says
  -- "nobody has decided", the second says "somebody decided none". Both credit
  -- in full; only the first will be picked up by a future bulk-set.
  ADD COLUMN return_penalty_percent DECIMAL(6,4) DEFAULT NULL AFTER cost_price;

-- ---------------------------------------------------------------------------
-- sales_return_items — what the line was actually credited, and why.
--
-- "80% credit note if saleable" makes saleability the condition, so it is a
-- field on the line rather than an assumption. `amount` stays the value of the
-- goods coming back; `credit_amount` is what the party gets. Keeping them apart
-- is the point: a return of 1,000 that credits 800 is two facts, and one column
-- holding 800 cannot answer "what came back?".
-- ---------------------------------------------------------------------------
ALTER TABLE sales_return_items
  ADD COLUMN is_saleable BOOLEAN NOT NULL DEFAULT TRUE AFTER reason,
  ADD COLUMN penalty_percent DECIMAL(6,4) DEFAULT NULL AFTER is_saleable,
  ADD COLUMN penalty_amount DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER penalty_percent,
  -- Snapshotted, like every other computed money column: the penalty rate on
  -- the item may be changed later, and a credit note already raised must not
  -- silently re-explain itself.
  ADD COLUMN credit_amount DECIMAL(15,2) DEFAULT NULL AFTER penalty_amount;

-- Existing lines were credited in full, and the columns must say so rather
-- than reading as NULL and being mistaken for "not yet decided".
UPDATE sales_return_items
   SET credit_amount = amount, penalty_amount = 0
 WHERE credit_amount IS NULL;

ALTER TABLE sales_returns
  ADD COLUMN penalty_total DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER total_amount,
  ADD COLUMN credit_total DECIMAL(15,2) DEFAULT NULL AFTER penalty_total;

UPDATE sales_returns SET credit_total = total_amount WHERE credit_total IS NULL;
