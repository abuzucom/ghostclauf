import { isIP } from 'node:net';

export interface OAuthCallback {
    redirect: URL;
    port: number;
}

/** The OAuth callback accepts connections only from this machine by default. */
const DEFAULT_LISTEN_HOST = '127.0.0.1';

/** Resolve callback settings supported by the plain local HTTP listener. */
export function resolveOAuthCallback(redirectUri: string): OAuthCallback {
    const redirect = new URL(redirectUri);
    const isLocalHost = redirect.hostname === 'localhost' || redirect.hostname === '127.0.0.1';
    if (redirect.protocol !== 'http:' || !isLocalHost) {
        throw new Error('AUTH_REDIRECT_URI must be a local HTTP URL');
    }
    return { redirect, port: Number(redirect.port || '80') };
}

/**
 * Resolve the address the one-time OAuth callback server binds.
 *
 * Inside a container, Docker forwards a published port to the container's
 * network interface, not its loopback, so docker-compose.yml sets
 * AUTH_LISTEN_HOST=0.0.0.0 and publishes the port on the host's loopback
 * only. Everywhere else the default keeps the callback loopback-only.
 */
export function resolveOAuthListenHost(env: NodeJS.ProcessEnv = process.env): string {
    const configured = env.AUTH_LISTEN_HOST;
    if (!configured) return DEFAULT_LISTEN_HOST;
    if (isIP(configured) === 0) {
        throw new Error(
            'AUTH_LISTEN_HOST must be an IP address such as 127.0.0.1 or 0.0.0.0; ' +
                'unset it to listen on 127.0.0.1.',
        );
    }
    return configured;
}
