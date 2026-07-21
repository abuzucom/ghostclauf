// Shared parsing for user-supplied Twitch login arguments.

/** Twitch logins are 1-25 chars of letters, digits, and underscores. */
export const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Parse an optional "@login" argument into a validated lowercase login. */
export function parseLogin(token: string | undefined): string | null {
  if (!token) return null;
  const login = token.replace(/^@/, '').toLowerCase();
  return LOGIN_PATTERN.test(login) ? login : null;
}
