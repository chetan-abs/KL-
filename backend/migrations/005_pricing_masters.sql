-- ---------------------------------------------------------------------------
-- 005 — Pricing engine, party classification, and order field capture.
--
-- Written against three documents received 30 August 2026:
--   KL_App_Requirements_FINAL.pdf   (sections 3, 4; rules R-01..R-30)
--   KL_APP_RATES_markups_3.xlsx     (8,519 KL items, 141 brands)
--   LEMAC_Developer_Master_v7.xlsx  (451 Lemac items + its own scheme regime)
--
-- The central change: an item no longer has *a* rate. It has six, one per
-- customer type, and they are derived from the master two different ways
-- depending on the item's pricing type. Storing six computed columns would put
-- the derivation in the importer where nobody can see it; storing the inputs
-- and deriving in utils/pricing.js keeps one formula in one place.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- items — the rate card.
--
-- pricing_type decides how base_price is read, and the two readings share no
-- columns:
--
--   'list_less_disc'  base_price is the LIST price.
--                     rate = base_price * (1 - disc_<type>)
--                     2,138 KL items + 439 Lemac items.
--
--   'net'             base_price is the NET DEALER rate — the dealer pays it
--                     as it stands, which is why there is no dealer ratio.
--                     rate = base_price * (1 + ratio_<type>)
--                     1,142 KL items + 12 Lemac (the 10A 1-way switches).
--
--   NULL              not rate-carded yet. 5,239 KL items are in this state:
--                     they exist in Tally with a stock balance but no rate has
--                     been set. They must remain orderable-by-nobody rather
--                     than silently priced at zero — see utils/pricing.js.
--
-- Fractions are stored as fractions (0.52), not as percentages (52), because
-- that is how both spreadsheets hold them and converting on import is one more
-- place for a factor of 100 to go missing.
-- ---------------------------------------------------------------------------
ALTER TABLE items
  ADD COLUMN pricing_type ENUM('list_less_disc','net') DEFAULT NULL AFTER unit,
  ADD COLUMN base_price   DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER pricing_type,

  -- 'list_less_disc' inputs: the fraction taken OFF the list price.
  ADD COLUMN disc_dealer         DECIMAL(6,4) DEFAULT NULL AFTER base_price,
  ADD COLUMN disc_builder_direct DECIMAL(6,4) DEFAULT NULL AFTER disc_dealer,
  ADD COLUMN disc_builder_comm   DECIMAL(6,4) DEFAULT NULL AFTER disc_builder_direct,
  ADD COLUMN disc_retail_direct  DECIMAL(6,4) DEFAULT NULL AFTER disc_builder_comm,
  ADD COLUMN disc_retail_comm    DECIMAL(6,4) DEFAULT NULL AFTER disc_retail_direct,
  ADD COLUMN disc_electrician    DECIMAL(6,4) DEFAULT NULL AFTER disc_retail_comm,

  -- 'net' inputs: the fraction added ON TOP of the net dealer rate.
  ADD COLUMN ratio_builder_direct DECIMAL(8,6) DEFAULT NULL AFTER disc_electrician,
  ADD COLUMN ratio_builder_comm   DECIMAL(8,6) DEFAULT NULL AFTER ratio_builder_direct,
  ADD COLUMN ratio_retail_direct  DECIMAL(8,6) DEFAULT NULL AFTER ratio_builder_comm,
  ADD COLUMN ratio_retail_comm    DECIMAL(8,6) DEFAULT NULL AFTER ratio_retail_direct,
  ADD COLUMN ratio_electrician    DECIMAL(8,6) DEFAULT NULL AFTER ratio_retail_comm,

  -- Agent commission is a property of the ITEM, not of a product category.
  -- The requirements say "Wire 1%, Fan 3%, all else 10%", but the rate sheet
  -- carries the number per item and disagrees with that summary in places —
  -- notably the builder agent, who is on 5% where the electrician agent is on
  -- 10%. The sheet is the master; a hard-coded category rule would quietly
  -- overpay every builder agent.
  ADD COLUMN comm_retail_agent  DECIMAL(6,4) DEFAULT NULL AFTER ratio_electrician,
  ADD COLUMN comm_builder_agent DECIMAL(6,4) DEFAULT NULL AFTER comm_retail_agent,

  -- KL Utsav qualifying weightage. The PDF says wire counts 50%, everything
  -- else 100%; the sheet holds 1, 0.5 and 0.1 per item — the 0.1 band is the
  -- whole Anchor range, which the PDF does not mention at all. Per item again.
  ADD COLUMN scheme_weightage DECIMAL(6,4) DEFAULT NULL AFTER comm_builder_agent,

  -- Lemac's own scheme regime is per-item validity flags, not a category rule
  -- (LEMAC_Developer_Master_v7, 'Discount & Scheme Reference'). Null for every
  -- KL item; the scheme engine reads the flag, then applies the dealer slab.
  ADD COLUMN sch_modular_monthly   BOOLEAN DEFAULT NULL AFTER scheme_weightage,
  ADD COLUMN sch_modular_quarterly BOOLEAN DEFAULT NULL AFTER sch_modular_monthly,
  ADD COLUMN sch_modular_yearly    BOOLEAN DEFAULT NULL AFTER sch_modular_quarterly,
  ADD COLUMN sch_dream_monthly     BOOLEAN DEFAULT NULL AFTER sch_modular_yearly,
  ADD COLUMN sch_boxes_monthly     BOOLEAN DEFAULT NULL AFTER sch_dream_monthly,
  ADD COLUMN sch_electrician       BOOLEAN DEFAULT NULL AFTER sch_boxes_monthly,
  ADD COLUMN sch_cash_discount     BOOLEAN DEFAULT NULL AFTER sch_electrician,
  ADD COLUMN modular_weightage     DECIMAL(6,4) DEFAULT NULL AFTER sch_cash_discount,
  ADD COLUMN incentive_category    VARCHAR(30) DEFAULT NULL AFTER modular_weightage,

  -- R-16 wants a below-cost alert. No cost price exists in either spreadsheet,
  -- so this is nullable and the alert fires only where a cost has been set.
  -- An item with no cost cannot be "below" it, and defaulting to zero would
  -- have made every sale look profitable.
  ADD COLUMN cost_price DECIMAL(15,2) DEFAULT NULL AFTER incentive_category,

  -- Stock Report: "items below minimum threshold" (section 12).
  ADD COLUMN min_stock DECIMAL(15,4) NOT NULL DEFAULT 0 AFTER cost_price,

  -- The picking screen shows rack locations (section 4.3), and picking from
  -- the Berlia or Fan godown requires the SO to be entered in that godown's
  -- physical register first (R-05) — so the godown is a property of the item,
  -- not of the order.
  ADD COLUMN godown VARCHAR(40) DEFAULT NULL AFTER min_stock,
  ADD COLUMN rack   VARCHAR(40) DEFAULT NULL AFTER godown,

  ADD INDEX idx_brand (brand),
  ADD INDEX idx_priced (pricing_type, is_active),
  ADD INDEX idx_incentive_cat (incentive_category);

-- ---------------------------------------------------------------------------
-- item_rate_history — "The previous rate (last sale price for this item) is
-- displayed alongside for reference" (section 4.1).
--
-- Written on invoice, not on order: the order rate is a proposal, and Gaurav
-- may still edit it. What the next salesman needs to see is what the party
-- was actually billed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_rate_history (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  item_id       INT NOT NULL,
  customer_id   INT DEFAULT NULL,
  customer_type VARCHAR(24) DEFAULT NULL,
  rate          DECIMAL(15,2) NOT NULL,
  qty           DECIMAL(15,4) NOT NULL DEFAULT 0,
  invoice_id    INT DEFAULT NULL,
  billed_on     DATE NOT NULL,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- The lookup is always "latest for this item, optionally for this party",
  -- so the id tiebreak is part of the index rather than a second sort.
  INDEX idx_item_recent (item_id, billed_on DESC, id DESC),
  INDEX idx_party_item (customer_id, item_id, billed_on DESC),
  FOREIGN KEY (item_id)     REFERENCES items(masterid) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(masterid) ON DELETE SET NULL,
  FOREIGN KEY (invoice_id)  REFERENCES invoices(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- customers — classification and the permanent salesman tag.
--
-- customer_type is nullable rather than defaulted: the six types drive pricing,
-- and a party silently defaulted to 'dealer' would be billed at list less 52%.
-- An unclassified party must be classified at order time, not assumed.
-- ---------------------------------------------------------------------------
ALTER TABLE customers
  ADD COLUMN customer_type ENUM(
      'dealer','retail_direct','retail_commission',
      'electrician_direct','builder_direct','builder_commission'
    ) DEFAULT NULL AFTER category,

  -- "If the party is already tagged to a salesman, the field is auto-filled
  -- and locked. If the party is new, the user selects... The salesman is then
  -- permanently tagged to this party." (section 4.1)
  ADD COLUMN salesman_id VARCHAR(20) DEFAULT NULL AFTER customer_type,

  -- Dealer cash discount (3.3) and the 60-day notification (3.4) both count
  -- days from the invoice date, so the party's agreed credit period is needed
  -- to say which invoices are overdue rather than merely unpaid.
  ADD COLUMN credit_days INT NOT NULL DEFAULT 0 AFTER credit_limit,

  ADD INDEX idx_type (customer_type),
  ADD INDEX idx_salesman (salesman_id),
  ADD CONSTRAINT fk_customer_salesman
      FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- orders — everything section 4.1 asks to be captured at order time.
--
-- The GPS columns are R-26: "the application captures and permanently saves
-- the GPS location at that moment. This is not optional and cannot be edited
-- post-submission." There is deliberately no route that updates them.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN so_number VARCHAR(24) DEFAULT NULL AFTER order_id,

  -- Snapshotted from the customer, not joined back to it: a party reclassified
  -- from Retail Direct to Dealer next year must not rewrite the basis on which
  -- last year's orders were priced. Same reasoning as order_items.rate.
  ADD COLUMN customer_type VARCHAR(24) DEFAULT NULL AFTER customer_id,
  ADD COLUMN salesman_id   VARCHAR(20) DEFAULT NULL AFTER created_by,

  -- 3.1 — set only for the two commission types. R-22 makes agent_id and
  -- scheme_member_id mutually exclusive; enforced in utils/pricing.js because
  -- MariaDB CHECK constraints cannot be relied on across versions here.
  ADD COLUMN agent_id INT DEFAULT NULL AFTER salesman_id,
  ADD COLUMN agent_commission DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER agent_id,

  -- 3.2 — set only for electrician_direct.
  ADD COLUMN scheme_member_id INT DEFAULT NULL AFTER agent_commission,
  ADD COLUMN scheme_qualifying DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER scheme_member_id,

  -- "Mandatory. The name of the person who will physically receive the goods
  -- ... This is not the party name" (4.1).
  ADD COLUMN delivered_to VARCHAR(100) DEFAULT NULL AFTER notes,
  ADD COLUMN delivery_mode ENUM('kl_auto','bhaara_auto','kl_scooty','rapido') DEFAULT NULL AFTER delivered_to,
  ADD COLUMN urgency ENUM('hours','days') DEFAULT NULL AFTER delivery_mode,
  ADD COLUMN special_instructions TEXT AFTER urgency,

  -- 'split' is a mode in its own right; the parts live in order_payment_splits
  -- and must sum to the total (R-23).
  ADD COLUMN payment_mode ENUM('cash','upi','credit','pdc','split') DEFAULT NULL AFTER special_instructions,

  -- R-26.
  ADD COLUMN gps_lat DECIMAL(10,8) DEFAULT NULL AFTER payment_mode,
  ADD COLUMN gps_lng DECIMAL(11,8) DEFAULT NULL AFTER gps_lat,
  ADD COLUMN gps_place VARCHAR(160) DEFAULT NULL AFTER gps_lng,

  -- 4.2 — a rejection must carry its reason back to the submitter.
  ADD COLUMN approved_by VARCHAR(20) DEFAULT NULL AFTER gps_place,
  ADD COLUMN approved_at DATETIME DEFAULT NULL AFTER approved_by,
  ADD COLUMN reject_reason VARCHAR(255) DEFAULT NULL AFTER approved_at,

  -- "A similar order was placed for this party on [date] ... The user must
  -- explicitly confirm before submitting." Recorded so the confirmation is
  -- auditable rather than merely having happened in someone's UI.
  ADD COLUMN duplicate_ack BOOLEAN NOT NULL DEFAULT FALSE AFTER reject_reason,

  ADD UNIQUE KEY unique_so_number (so_number),
  ADD INDEX idx_agent (agent_id),
  ADD INDEX idx_salesman_order (salesman_id, order_date),
  ADD CONSTRAINT fk_order_agent    FOREIGN KEY (agent_id)    REFERENCES agents(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_order_salesman FOREIGN KEY (salesman_id) REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_order_approver FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- order_items — how the rate was arrived at, not just what it was.
--
-- The existing invariant snapshots item_name/hsn/rate/gst_percent so later
-- edits to the master cannot rewrite history. With six rate columns behind one
-- number, the snapshot has to widen: base_price and the factor applied are
-- what let anyone reconstruct — a year later, after the sheet has been
-- revised twice — why this line was billed at this figure.
-- ---------------------------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN pricing_type   VARCHAR(20) DEFAULT NULL AFTER rate,
  ADD COLUMN base_price     DECIMAL(15,2) DEFAULT NULL AFTER pricing_type,
  -- The discount fraction for list_less_disc, the markup for net. One column,
  -- because pricing_type says which it is and two mutually-null columns would
  -- invite reading the wrong one.
  ADD COLUMN price_factor   DECIMAL(8,6) DEFAULT NULL AFTER base_price,
  ADD COLUMN previous_rate  DECIMAL(15,2) DEFAULT NULL AFTER price_factor,
  ADD COLUMN cost_price     DECIMAL(15,2) DEFAULT NULL AFTER previous_rate,
  ADD COLUMN below_cost     BOOLEAN NOT NULL DEFAULT FALSE AFTER cost_price,
  ADD COLUMN commission_pct DECIMAL(6,4) DEFAULT NULL AFTER below_cost,
  ADD COLUMN commission_amt DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER commission_pct,
  ADD COLUMN scheme_weightage DECIMAL(6,4) DEFAULT NULL AFTER commission_amt,
  ADD COLUMN scheme_value     DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER scheme_weightage;

-- ---------------------------------------------------------------------------
-- order_payment_splits — R-23.
--
-- A separate table rather than a JSON column: the sum has to be checked in SQL
-- against the order total, and the Daily Sales Report breaks the day down by
-- cash vs credit vs UPI, which means summing across orders by mode.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_payment_splits (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  mode     ENUM('cash','upi','credit','pdc') NOT NULL,
  amount   DECIMAL(15,2) NOT NULL,
  note     VARCHAR(120) DEFAULT NULL,
  INDEX idx_order (order_id),
  FOREIGN KEY (order_id) REFERENCES orders(order_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- agents — the commission ledger needs a payout state, and the agent window
-- shows "pending commission balance" and "commission earned this month".
-- ---------------------------------------------------------------------------
ALTER TABLE agents
  ADD COLUMN phone2 VARCHAR(20) DEFAULT NULL AFTER phone,
  ADD COLUMN notes  VARCHAR(255) DEFAULT NULL AFTER area;

-- ---------------------------------------------------------------------------
-- item_import_log — the rate sheet is a business document that gets reissued.
-- Recording what each run changed is the only way to answer "when did this
-- item's dealer discount move from 52% to 55%, and which file said so".
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS item_import_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  source_file   VARCHAR(200) NOT NULL,
  sheet_name    VARCHAR(120) DEFAULT NULL,
  rows_read     INT NOT NULL DEFAULT 0,
  rows_created  INT NOT NULL DEFAULT 0,
  rows_updated  INT NOT NULL DEFAULT 0,
  rows_skipped  INT NOT NULL DEFAULT 0,
  note          VARCHAR(255) DEFAULT NULL,
  imported_by   VARCHAR(20) DEFAULT NULL,
  imported_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (imported_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
