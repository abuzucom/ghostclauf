// Pure permission logic: derive a chatter's roles from their badges and check
// them against a command's allow-list. No transport dependencies, so this is
// fully unit-testable without a live connection.

import type { Role } from './types.js';

// Twitch badge name -> role. `founder` is an early subscriber, so it counts as
// a subscriber for permission purposes.
const BADGE_TO_ROLE: Readonly<Record<string, Role>> = {
  broadcaster: 'broadcaster',
  moderator: 'moderator',
  vip: 'vip',
  subscriber: 'subscriber',
  founder: 'subscriber',
};

/**
 * Resolve the set of roles a chatter holds from their badge map.
 * `everyone` is always included.
 */
export function resolveRoles(badges: Record<string, string>): Set<Role> {
  const roles = new Set<Role>(['everyone']);
  for (const badge of Object.keys(badges)) {
    const role = BADGE_TO_ROLE[badge];
    if (role) roles.add(role);
  }
  return roles;
}

/**
 * True if any of the chatter's roles is permitted by `allow`.
 * `everyone` in the allow-list opens the command to all chatters.
 */
export function isAllowed(roles: ReadonlySet<Role>, allow: readonly Role[]): boolean {
  if (allow.includes('everyone')) return true;
  return allow.some((role) => roles.has(role));
}
