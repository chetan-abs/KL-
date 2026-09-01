/**
 * Authentication and authorisation for protected routes.
 *
 *   router.get('/', authenticate, requirePermission('items.read'), handler)
 *
 * authenticate populates req.user from the database, not from the token body.
 * The token carries an id and nothing else that is trusted: rights and account
 * status are re-read on every request, so deactivating a user or narrowing
 * their permissions takes effect immediately rather than whenever their
 * existing token happens to expire.
 */
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { userCan } = require('../utils/permissions');

// HS256 is pinned on both sign and verify. Without an explicit algorithms list
// jsonwebtoken accepts whatever the token's own header claims, which is how the
// "alg: none" and RS256->HS256 confusion attacks work.
const ALGORITHM = 'HS256';
const TOKEN_TTL = process.env.JWT_TTL || '12h';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    const err = new Error('JWT_SECRET is not configured');
    err.status = 500;
    throw err;
  }
  return secret;
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, getSecret(), {
    algorithm: ALGORITHM,
    expiresIn: TOKEN_TTL,
  });
}

// Columns every authenticated request needs. `password` is never selected here
// so a hash cannot leak through a handler that returns req.user wholesale.
const USER_FIELDS = 'id, name, email, phone, role, title, permissions, address, city, state, is_active, '
  + 'must_change_password, shift_code, fixed_salary, geofenced';

/**
 * The two things an account on a seeded password may still do: read itself, and
 * replace the password. Everything else is refused until it has.
 *
 * An allowlist rather than a list of what to block, because the failure modes
 * are not symmetric — forgetting to allow a route makes a screen unreachable
 * and somebody complains, forgetting to block one leaves a shared-password
 * account able to use it and nobody ever finds out.
 */
const PASSWORD_CHANGE_ALLOWED = new Set([
  'GET /api/auth/me',
  'PATCH /api/auth/change-password',
]);

async function authenticate(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');

  if (!token || scheme.toLowerCase() !== 'bearer') {
    return res.status(401).json({ error: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, getSecret(), { algorithms: [ALGORITHM] });
  } catch (err) {
    if (err.status === 500) return next(err); // missing secret is ours, not the caller's
    const expired = err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired' : 'Invalid token',
      code: expired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
    });
  }

  const [rows] = await pool.query(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, [payload.sub]);
  const user = rows[0];

  // A token outliving its user, or issued before the account was disabled, is
  // rejected here rather than at whatever the handler would have done with it.
  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account is not active', code: 'ACCOUNT_INACTIVE' });
  }

  /**
   * A password a script chose is not a password (migration 015).
   *
   * Checked here rather than on each route: a guard that must be remembered on
   * the next route added is one that will eventually be forgotten, and
   * forgetting this one silently restores the hole it was added to close.
   *
   * 403 rather than 401 — the credentials were good. A 401 would send the API
   * client's interceptor into a sign-out loop, logging the user straight back
   * out of the screen they need in order to fix it.
   */
  if (user.must_change_password
      && !PASSWORD_CHANGE_ALLOWED.has(`${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, ''))) {
    return res.status(403).json({
      error: 'Your password was set by an administrator and must be changed before you can continue.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }

  req.user = user;
  next();
}

function requirePermission(action) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!userCan(req.user, action)) {
      // The action is named back deliberately: this is an authenticated caller
      // being told which grant they lack, not an anonymous probe.
      return res.status(403).json({ error: 'Permission denied', required: action });
    }
    next();
  };
}

module.exports = { authenticate, requirePermission, signToken, USER_FIELDS, TOKEN_TTL };
