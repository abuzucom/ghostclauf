// Shared parsing for user-supplied Twitch login arguments.

/** Twitch logins are 1-25 chars of letters, digits, and underscores. */
export const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/**
 * The `your_*_login` placeholders shipped in config.example.yaml. They are not
 * valid Twitch logins, so config loading must let them through for checkTokens
 * to report and run.sh / run.bat to replace interactively.
 */
export const PLACEHOLDER_LOGIN_PATTERN = /^your[_-][a-z0-9_-]*login$/i;

/** True if `login` is an unconfigured config.example.yaml placeholder. */
export function isPlaceholderLogin(login: string): boolean {
    return PLACEHOLDER_LOGIN_PATTERN.test(login);
}

/** Parse an optional "@login" argument into a validated lowercase login. */
export function parseLogin(token: string | undefined): string | null {
    if (!token) return null;
    const login = token.replace(/^@/, '').toLowerCase();
    return LOGIN_PATTERN.test(login) ? login : null;
}
