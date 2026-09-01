-- ---------------------------------------------------------------------------
-- 021 — 4.3, September 2026: the delivery slot is derived, not typed, and
-- "urgent" gets its own mandatory reason and a daily quota.
--
-- `orders.urgency` already exists (enum('hours','days')) and is a different,
-- older idea — a rough delivery TIMEFRAME captured on the v1 order form. The
-- September sheet's "urgent" is a binary flag with a fixed reason and a
-- 2-per-user daily cap, which is not a value that column's enum can hold
-- without silently reinterpreting what every existing row means. New columns,
-- not a repurposed one.
--
-- delivery_slot_date/time are wall-clock, business-local, uninterpreted —
-- the same convention `shifts.starts_at` etc already use — because a
-- delivery slot is a scheduled target on the business calendar, not an
-- instant that happened and needs UTC precision.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN is_urgent BOOLEAN NOT NULL DEFAULT FALSE AFTER urgency,
  ADD COLUMN urgency_reason VARCHAR(60) DEFAULT NULL AFTER is_urgent,
  ADD COLUMN delivery_slot_label VARCHAR(40) DEFAULT NULL AFTER urgency_reason,
  ADD COLUMN delivery_slot_date DATE DEFAULT NULL AFTER delivery_slot_label,
  ADD COLUMN delivery_slot_time TIME DEFAULT NULL AFTER delivery_slot_date;
