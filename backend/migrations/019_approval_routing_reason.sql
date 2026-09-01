-- ---------------------------------------------------------------------------
-- 019 — Why an order is sitting in Manas's queue.
--
-- 4.2 replaces "every order needs approval" with "only an exception needs
-- approval", and each exception has a stated reason (new party, over the
-- value threshold, an anomalous quantity). Without somewhere to keep it, the
-- reason existed only inside the notification POST /orders sent at the
-- moment of creation — gone from the screen the second Manas opens the queue
-- an hour later, which is exactly when he needs to read it.
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN approval_reason VARCHAR(500) DEFAULT NULL AFTER status;
