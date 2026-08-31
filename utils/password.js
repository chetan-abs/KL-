/**
 * A deliberate duplicate of `backend/utils/password.js`.
 *
 * Metro's blockList keeps `backend/` out of the bundle, so the client cannot
 * import the server copy — the same reason `utils/permissions.js` exists twice.
 * This copy is there to tell the person filling in the form what the rule is
 * before they wait for a round trip; the server's copy is the one that decides.
 *
 * Change a rule in one and you must change it in the other, or the form starts
 * accepting passwords the server will reject.
 */

export const PASSWORD_MIN_LENGTH = 8;

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

/** null when acceptable, or a message naming the rule that was not met. */
export function checkPassword(password) {
  if (typeof password !== 'string' || !password) {
    return 'A password is required.';
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (FORBIDDEN.has(password.toLowerCase())) {
    return 'That password is too common. Choose something else.';
  }
  return null;
}
