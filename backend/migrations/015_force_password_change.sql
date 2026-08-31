-- ---------------------------------------------------------------------------
-- 015 — A seeded password is a temporary password.
--
-- `npm run seed-roles` and `npm run seed-business` create the staff accounts
-- with one shared password so a developer can sign in as anyone. That is the
-- right trade for a laptop and the wrong one for a business: the value was a
-- literal in both scripts, which means it is in the repository, which means it
-- is not a secret — and 22 active accounts were found still using it, `yash`
-- (who holds `all`) among them.
--
-- The fix is not to pick a better literal. Any password a script knows is a
-- password the repository knows. So an account created by a seed is marked as
-- carrying a password it must replace, and `authenticate` refuses every request
-- from it except the two needed to replace it.
--
-- Enforced in the middleware rather than per route, for the same reason
-- `numericId(router)` is: a check that has to be remembered on the next route
-- somebody adds is a check that will eventually be forgotten, and forgetting
-- this one silently re-opens the hole.
--
-- FALSE by default, so an account whose password a person actually chose —
-- through create-admin, POST /api/users, or change-password — is unaffected.
-- Marking the existing seeded accounts cannot be done in SQL, because deciding
-- whether a stored bcrypt hash matches a known string requires bcrypt:
--   npm run secure-accounts -- --dry-run
-- ---------------------------------------------------------------------------

ALTER TABLE users
  -- Set when a script chose the password, cleared when a person does.
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE AFTER password,
  -- When the password was last actually changed by its owner. NULL means never
  -- — which is the honest state for an account still on whatever it was
  -- created with, and is what an audit asks for before it asks anything else.
  ADD COLUMN password_changed_at DATETIME DEFAULT NULL AFTER must_change_password;

-- Accounts that predate this column and were not seeded have had their password
-- set by a person at some point; we do not know when, and recording a made-up
-- date would be worse than recording none.
