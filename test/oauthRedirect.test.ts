import { describe, expect, it } from 'vitest';
import { resolveOAuthCallback, resolveOAuthListenHost } from '../src/core/oauthRedirect.js';

describe('resolveOAuthCallback', () => {
    it('resolves a local HTTP callback before the server starts', () => {
        expect(resolveOAuthCallback('http://localhost:3000/callback')).toEqual({
            redirect: new URL('http://localhost:3000/callback'),
            port: 3000,
        });
    });

    it.each([
        'https://localhost/callback',
        'http://example.com/callback',
        'ftp://localhost/callback',
    ])('rejects a callback the local HTTP server cannot serve: %s', (redirectUri) => {
        expect(() => resolveOAuthCallback(redirectUri)).toThrow(/local HTTP URL/);
    });
});

describe('resolveOAuthListenHost', () => {
    it('binds loopback when AUTH_LISTEN_HOST is unset', () => {
        expect(resolveOAuthListenHost({})).toBe('127.0.0.1');
    });

    it.each(['0.0.0.0', '127.0.0.1', '::', '::1'])('accepts the IP literal %s', (host) => {
        expect(resolveOAuthListenHost({ AUTH_LISTEN_HOST: host })).toBe(host);
    });

    it('treats an empty value as unset', () => {
        expect(resolveOAuthListenHost({ AUTH_LISTEN_HOST: '' })).toBe('127.0.0.1');
    });

    it.each(['localhost', 'example.com', '0.0.0.0; rm -rf /', '999.1.1.1'])(
        'rejects a value that is not an IP literal: %s',
        (host) => {
            expect(() => resolveOAuthListenHost({ AUTH_LISTEN_HOST: host })).toThrow(
                /AUTH_LISTEN_HOST must be an IP address/,
            );
        },
    );
});
