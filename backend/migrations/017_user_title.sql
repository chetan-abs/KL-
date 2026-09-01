-- ---------------------------------------------------------------------------
-- 017 — Job title moves into the database.
--
-- The label shown beside a signed-in user's name ("Owner", "Order & Rate
-- Desk + Billing", "Salesman — Builder"...) used to live only in
-- constants/roles.js on the client — a hardcoded lookup keyed by username,
-- with no server column behind it at all. Nothing else about this app works
-- that way: `role` and `permissions` are both on the row and editable through
-- the People screen, and a hardcoded client table drifts from the database
-- the moment somebody's duty changes without a matching app release.
--
-- `title` is presentation only, same as before — it decides no permission
-- and the server consults it for nothing. It is nullable because dev/test
-- accounts (Test Employee One, the password-gate probe) never had one and
-- should not need one invented for them.
-- ---------------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN title VARCHAR(100) DEFAULT NULL AFTER role;
