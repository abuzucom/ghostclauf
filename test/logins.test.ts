import { describe, expect, it } from 'vitest';
import { isPlaceholderLogin, normalizeLoginAnswer } from '../src/core/logins.js';

describe('normalizeLoginAnswer', () => {
    it('trims and lowercases a valid login', () => {
        expect(normalizeLoginAnswer('  Ghost_Bot  ')).toBe('ghost_bot');
    });

    it('strips a leading @', () => {
        expect(normalizeLoginAnswer('@streamer')).toBe('streamer');
    });

    it.each(['', '   ', 'has space', 'semi;colon', 'a'.repeat(26), 'your_bot_login'])(
        'rejects %j',
        (answer) => {
            expect(normalizeLoginAnswer(answer)).toBeNull();
        },
    );
});

describe('isPlaceholderLogin', () => {
    it.each(['your_bot_login', 'your-broadcaster-login', 'YOUR_SECOND_LOGIN'])(
        'recognizes the example placeholder %s',
        (login) => {
            expect(isPlaceholderLogin(login)).toBe(true);
        },
    );

    it('does not treat a free-text value as a placeholder', () => {
        expect(isPlaceholderLogin('your bad login')).toBe(false);
    });
});
