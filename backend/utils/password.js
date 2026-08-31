const crypto = require('crypto');

/**
 * The one password policy, applied everywhere a password is set.
 *
 * Before this existed the rules disagreed: create-admin.js demanded 8+, the
 * change-password route demanded 6+, and POST /api/users accepted anything
 * non-empty — while the employee form quietly substituted 'password123' when
 * the field was left blank. An account's strength depended on which door it
 * came through, which is not a policy.
 */

const MIN_LENGTH = 8;

// Rejected outright rather than merely discouraged. These are the values that
// get typed when someone is creating ten accounts in a hurry, and every one of
// them has appeared in this codebase or its seed data at some point.
const FORBIDDEN = new Set([
  'password',
  'password1',
  'password123',
  'admin123',
  '12345678',
  '123456789',
  'qwertyui',
  'kl123456',
]);

/**
 * Returns null when the password is acceptable, or a message naming the reason
 * it is not. The message is safe to return to the caller — it describes the
 * rule, not the stored value.
 */
function checkPassword(password) {
  if (typeof password !== 'string' || !password) {
    return 'A password is required.';
  }
  if (password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters.`;
  }
  if (FORBIDDEN.has(password.toLowerCase())) {
    return 'That password is too common. Choose something else.';
  }
  return null;
}

/**
 * A one-time password for an account a script is creating.
 *
 * Here rather than in the seed scripts because there were two of them and there
 * is one policy: a generated credential and a typed one must clear the same bar,
 * and `checkPassword` is right above this.
 *
 * `crypto.randomInt` rather than `Math.random()` — this is a credential, and a
 * CSPRNG costs nothing at this volume. The alphabet drops the glyphs that get
 * misread off a screen (no O/0, no l/1/I), because somebody copies this by hand
 * exactly once before replacing it.
 *
 * The `@7` tail is not decoration: it guarantees the result clears the policy
 * regardless of what the random draw produced, so the seed can never mint an
 * account whose password `change-password` would refuse to accept back.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function generatePassword(length = 14) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${out}@7`;
}

module.exports = { checkPassword, generatePassword, MIN_LENGTH };
