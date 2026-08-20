export interface OAuthCallback {
    redirect: URL;
    port: number;
}

/** Resolve callback settings supported by the plain local HTTP listener. */
export function resolveOAuthCallback(redirectUri: string): OAuthCallback {
    const redirect = new URL(redirectUri);
    const isLocalHost = redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1';
    if (redirect.protocol !== 'http:' || !isLocalHost) {
        throw new Error('AUTH_REDIRECT_URI must be a local HTTP URL');
    }
    return { redirect, port: Number(redirect.port || '80') };
}
