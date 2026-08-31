-- ---------------------------------------------------------------------------
-- 013 — Dealer growth schemes.
--
-- Source: LEMAC_Developer_Master_v7.xlsx, sheet 'Discount & Scheme Reference'.
--
-- These are the one thing in the spreadsheets that the requirements PDF never
-- mentions, and they are a different shape from KL Utsav:
--
--   KL Utsav (electrician_gift)   accrues to a PERSON, cumulatively, over one
--                                 90-day window, and pays a physical gift at
--                                 the highest rung reached.
--
--   Growth (growth_credit/gift)   accrues to a DEALER, per window, resets each
--                                 window, and pays a PERCENTAGE of what they
--                                 billed — as a credit note, or as a gift for
--                                 the quarterly one.
--
-- The sheet's four:
--
--   Modular Monthly    25k→2%  40k→2.5%  60k→3%  80k→3.5%  1L→4%     credit note
--   Modular Quarterly  75k→3%  1.2L→3.5% 1.8L→4% 2.4L→4.5% 3L→5%     gift
--   Modular Yearly     1.75L→1% 2.8L→1.5% 4.2L→2% 5.6L→2.5% 7L→3%    credit note
--   Boxes Monthly      15k→2%  30k→3%  50k→4%                        credit note
--
-- and two rules that shape the tables:
--
--   "STACK: Monthly credit (4%) + Quarterly gift (5%) + Yearly credit (3%) are
--    ADDITIVE (separate layers), reaching up to 12% together at the top slabs.
--    Each is earned independently on its own billing."
--      → one award row per (scheme, dealer, window). Nothing nets them.
--
--   "All credit notes / gifts are computed on the NET PRE-GST value... Released
--    only after full payment of the goods."
--      → an award is EARNED on billing and RELEASED on payment, which are two
--        different moments and therefore two columns.
--
-- SEEDED INACTIVE. Whether K.L. Electricals runs Lemac's dealer schemes as a
-- distributor or merely stocks the range is a business fact not present in any
-- of the three documents. The engine is complete and the slabs are loaded; a
-- scheme accrues nothing until somebody sets is_active. Guessing would have
-- started issuing credit notes against a scheme the company may not operate.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- scheme_growth_awards — one dealer's standing in one scheme in one window.
--
-- `window_key` is the identity of the period: 'YYYY-MM' for a monthly scheme,
-- and the scheme's own start date for a quarterly or yearly one, because those
-- do not renew — the sheet gives them fixed windows ("1 September 2026 – 30
-- November 2026").
--
-- `qualifying` is a cache of scheme_ledger rows for this triple, on exactly the
-- terms items.qty is a cache of stock_movements: the ledger is the truth, and
-- utils/growthScheme.js is the only writer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheme_growth_awards (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  scheme_id     INT NOT NULL,
  customer_id   INT NOT NULL,
  window_key    VARCHAR(16) NOT NULL,
  window_from   DATE NOT NULL,
  window_to     DATE NOT NULL,

  qualifying    DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- What has actually been paid for. The reward is "released only after full
  -- payment of the goods", so this is the figure the slab is applied to at
  -- release time — while `qualifying` is what the dealer has earned toward it.
  paid_qualifying DECIMAL(15,2) NOT NULL DEFAULT 0,

  slab_id       INT DEFAULT NULL,
  reward_percent DECIMAL(6,4) DEFAULT NULL,
  reward_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  reward_gift   VARCHAR(120) DEFAULT NULL,

  -- earned  the slab is reached but the goods are not fully paid for
  -- released the payment condition is met; a credit note may be raised
  -- issued   the credit note exists (or the gift was handed over)
  -- lapsed   the window closed without the first slab being reached
  status        ENUM('accruing','earned','released','issued','lapsed')
                  NOT NULL DEFAULT 'accruing',
  released_at   DATETIME DEFAULT NULL,
  credit_note_id INT DEFAULT NULL,
  issued_at     DATETIME DEFAULT NULL,
  issued_by     VARCHAR(20) DEFAULT NULL,
  note          VARCHAR(255) DEFAULT NULL,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY unique_award (scheme_id, customer_id, window_key),
  INDEX idx_standing (scheme_id, window_key, qualifying DESC),
  INDEX idx_release (status, window_to),
  FOREIGN KEY (scheme_id)   REFERENCES schemes(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(masterid) ON DELETE CASCADE,
  FOREIGN KEY (slab_id)     REFERENCES scheme_slabs(id) ON DELETE SET NULL,
  FOREIGN KEY (credit_note_id) REFERENCES credit_notes(id) ON DELETE SET NULL,
  FOREIGN KEY (issued_by)   REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- scheme_ledger — a growth scheme credits a CUSTOMER, not a member or an agent.
--
-- The table already carries member_id (KL Utsav) and agent_id (commission).
-- Adding customer_id keeps all three accruals in one append-only ledger rather
-- than inventing a second one, so "what did this scheme pay out and why" is one
-- query regardless of which kind of scheme it was.
-- ---------------------------------------------------------------------------
ALTER TABLE scheme_ledger
  ADD COLUMN customer_id INT DEFAULT NULL AFTER member_id,
  ADD COLUMN window_key VARCHAR(16) DEFAULT NULL AFTER customer_id,
  ADD INDEX idx_customer_window (scheme_id, customer_id, window_key),
  ADD CONSTRAINT fk_ledger_customer
      FOREIGN KEY (customer_id) REFERENCES customers(masterid) ON DELETE CASCADE;

-- The ledger's `source` gains the growth accrual, so a row can say which kind
-- of scheme produced it without a join.
ALTER TABLE scheme_ledger
  MODIFY COLUMN source ENUM('purchase','referral','adjustment','growth')
    NOT NULL DEFAULT 'purchase';

-- ---------------------------------------------------------------------------
-- schemes — which window a growth scheme measures over, and how it renews.
--
-- The sheet distinguishes "renews monthly" from a fixed three-month or
-- seven-month window, and `period` already carries monthly/quarterly/yearly.
-- What was missing is the boundary between "this scheme's own dates" and "a
-- calendar month inside them".
-- ---------------------------------------------------------------------------
ALTER TABLE schemes
  -- TRUE for the two monthly schemes: the window is the calendar month and the
  -- scheme runs on. FALSE for quarterly and yearly, where the scheme's own
  -- start and end ARE the window.
  ADD COLUMN renews BOOLEAN NOT NULL DEFAULT FALSE AFTER period,
  -- "Released only after full payment of the goods."
  ADD COLUMN requires_payment BOOLEAN NOT NULL DEFAULT TRUE AFTER renews;
