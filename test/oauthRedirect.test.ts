import { describe, expect, it } from 'vitest';
import { resolveOAuthCallback } from '../src/core/oauthRedirect.js';

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
