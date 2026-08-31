/**
 * Client-side mirror of backend/utils/permissions.js.
 *
 * The two files must agree. Metro's blockList keeps backend/ out of the bundle,
 * so the server copy cannot simply be imported — this is a deliberate duplicate,
 * and changing the matching rules in one file means changing them in both.
 *
 * What this is for is hiding controls the server would refuse anyway. It is not
 * a security boundary: every grant is re-checked server-side by requirePermission
 * against the row read fresh from the database on each request. Deleting this
 * file would make the UI untidy, not insecure.
 */
import { WILDCARD } from '../constants/permissions';

/**
 * mysql2 parses a JSON column into a real array, but a value written by an older
 * client, or read back through a driver configured differently, can arrive as a
 * string. Both are accepted; anything else grants nothing.
 */
export function parsePermissions(raw) {
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
 * True when `user` may perform `action` (for example 'employees.create').
 *
 * role is deliberately not consulted, matching the server: permissions are the
 * only source of authority, so revoking a grant actually revokes the ability.
 */
export function userCan(user, action) {
  if (!user || !action) return false;

  const granted = parsePermissions(user.permissions);
  if (granted.length === 0) return false;
  if (granted.includes(WILDCARD)) return true;
  if (granted.includes(action)) return true;

  // An area grant covers every action within it: 'employees' covers
  // 'employees.create'. Compared segment-wise so 'employee' does not.
  const segments = action.split('.');
  for (let i = 1; i < segments.length; i++) {
    if (granted.includes(segments.slice(0, i).join('.'))) return true;
  }

  return false;
}
