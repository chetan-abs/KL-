/**
 * The permission matcher schema.sql describes against users.permissions.
 *
 * Stored value is a JSON array. Three grant shapes, widest first:
 *
 *   ["all"]              every action
 *   ["items"]            every action in the items area
 *   ["items.create"]     that one action
 *
 * A grant covers itself and everything beneath it, so "items" satisfies a
 * check for "items.create" but "items.create" does not satisfy "items.delete".
 */

const WILDCARD = 'all';

/**
 * mysql2 parses a JSON column into a real array, but a value written by an
 * older client, or read back through a driver configured differently, can
 * arrive as a string. Both are accepted; anything else grants nothing.
 */
function parsePermissions(raw) {
  if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * True when `user` may perform `action` (for example 'items.create').
 *
 * role is deliberately NOT consulted. An account's rights are exactly what its
 * permissions array says, so revoking a grant is sufficient to revoke the
 * ability — there is no second source of authority that could silently
 * re-grant it. create-admin.js gives the first admin ["all"].
 */
function userCan(user, action) {
  if (!user || !action) return false;

  const granted = parsePermissions(user.permissions);
  if (granted.length === 0) return false;
  if (granted.includes(WILDCARD)) return true;

  // Exact grant.
  if (granted.includes(action)) return true;

  // An area grant covers every action within it: "items" covers "items.create".
  // Compared segment-wise so a grant of "item" does not cover "items.create".
  const segments = action.split('.');
  for (let i = 1; i < segments.length; i++) {
    if (granted.includes(segments.slice(0, i).join('.'))) return true;
  }

  return false;
}

module.exports = { userCan, parsePermissions, WILDCARD };
