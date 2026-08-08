import { describe, expect, it } from 'vitest';
import {
    applyAward,
    buildLeaderboard,
    parseEsdAmount,
    renderBalance,
    renderLeaderboard,
} from '../src/plugins/loyalty/loyalty.js';
import type { ViewerRecord } from '../src/plugins/loyalty/types.js';

describe('applyAward', () => {
    it('adds a positive award to the balance', () => {
        expect(applyAward(10, 5)).toBe(15);
    });

    it('floors the result at 0', () => {
        expect(applyAward(3, -10)).toBe(0);
    });

    it('starts from zero', () => {
        expect(applyAward(0, 1)).toBe(1);
    });
});

describe('renderBalance', () => {
    it('renders the display name, balance, and currency name', () => {
        expect(renderBalance('esports dollars', 'Viewer', 42)).toBe(
            'Viewer has 42 esports dollars.',
        );
    });
});

describe('buildLeaderboard', () => {
    function viewers(entries: Record<string, ViewerRecord>): Record<string, ViewerRecord> {
        return entries;
    }

    it('sorts by balance descending', () => {
        const ranked = buildLeaderboard(
            viewers({
                a: { displayName: 'Alice', balance: 5 },
                b: { displayName: 'Bob', balance: 20 },
                c: { displayName: 'Cara', balance: 10 },
            }),
            5,
        );
        expect(ranked).toEqual([
            { displayName: 'Bob', balance: 20 },
            { displayName: 'Cara', balance: 10 },
            { displayName: 'Alice', balance: 5 },
        ]);
    });

    it('breaks ties alphabetically by display name', () => {
        const ranked = buildLeaderboard(
            viewers({
                a: { displayName: 'Zed', balance: 10 },
                b: { displayName: 'Amy', balance: 10 },
            }),
            5,
        );
        expect(ranked.map((entry) => entry.displayName)).toEqual(['Amy', 'Zed']);
    });

    it('excludes zero-balance viewers', () => {
        const ranked = buildLeaderboard(viewers({ a: { displayName: 'Alice', balance: 0 } }), 5);
        expect(ranked).toEqual([]);
    });

    it('truncates to the limit', () => {
        const ranked = buildLeaderboard(
            viewers({
                a: { displayName: 'A', balance: 3 },
                b: { displayName: 'B', balance: 2 },
                c: { displayName: 'C', balance: 1 },
            }),
            2,
        );
        expect(ranked).toHaveLength(2);
    });
});

describe('renderLeaderboard', () => {
    it('reports an empty pool', () => {
        expect(renderLeaderboard('esports dollars', [])).toBe('No esports dollars earned yet.');
    });

    it('renders a numbered, comma-separated list', () => {
        expect(
            renderLeaderboard('esports dollars', [
                { displayName: 'Bob', balance: 20 },
                { displayName: 'Cara', balance: 10 },
            ]),
        ).toBe('Top esports dollars: 1. Bob (20), 2. Cara (10)');
    });

    it('keeps a full leaderboard inside the 500-character chat limit', () => {
        // ctx.say throws past 500, which would drop the whole reply. 25 rows
        // is the configurable maximum and overruns the limit on its own.
        const entries = Array.from({ length: 25 }, (_, i) => ({
            displayName: `Viewer${String(i).padStart(2, '0')}Name${'x'.repeat(14)}`,
            balance: 123456,
        }));
        const rendered = renderLeaderboard('esports dollars', entries);
        expect([...rendered].length).toBeLessThanOrEqual(500);
    });

    it('drops whole trailing rows rather than cutting one mid-entry', () => {
        const entries = Array.from({ length: 25 }, (_, i) => ({
            displayName: `Viewer${String(i).padStart(2, '0')}Name${'x'.repeat(14)}`,
            balance: 123456,
        }));
        const rendered = renderLeaderboard('esports dollars', entries);
        // Whatever rows survive, the last one is complete: it ends with the
        // closing paren of a balance, not a severed name.
        expect(rendered.endsWith(')')).toBe(true);
        expect(rendered.startsWith('Top esports dollars: 1. ')).toBe(true);
    });

    it('still truncates when even the first row cannot fit', () => {
        const rendered = renderLeaderboard('esports dollars', [
            { displayName: 'x'.repeat(600), balance: 1 },
        ]);
        expect([...rendered].length).toBe(500);
    });

    it('keeps a balance reply inside the chat limit', () => {
        const rendered = renderBalance('esports dollars', 'y'.repeat(600), 1);
        expect([...rendered].length).toBe(500);
    });
});

describe('parseEsdAmount', () => {
    it('accepts a plain whole number', () => {
        expect(parseEsdAmount('100')).toBe(100);
        expect(parseEsdAmount('0')).toBe(0);
    });

    // !setESD/!giveESD/!takeESD write straight into a balance, so the
    // argument must be a plain decimal integer literal and nothing else - no
    // arithmetic, no expression evaluation, no alternate bases or notations.
    // Number() and parseInt() are both unsafe here: Number('') is 0 (a
    // missing argument would parse as a valid zero), Number('1e3') is 1000,
    // and parseInt silently partial-parses '10+5' to 10 and '5abc' to 5.
    const badAmounts: ReadonlyArray<[string, string]> = [
        ['an arithmetic expression', '10+5'],
        ['scientific notation', '1e3'],
        ['hexadecimal', '0x10'],
        ['a numeric separator', '1_000'],
        ['a trailing decimal', '1.0'],
        ['a fractional value', '1.5'],
        ['a leading plus', '+5'],
        ['surrounding whitespace', ' 5 '],
        ['a negative value', '-3'],
        ['digits with a suffix', '5abc'],
        ['a number word', 'one'],
        ['Infinity', 'Infinity'],
        ['NaN', 'NaN'],
        ['empty', ''],
        ['a fullwidth digit', '\uFF15'],
    ];

    it.each(badAmounts)('rejects %s (%s)', (_label, token) => {
        expect(parseEsdAmount(token)).toBeNull();
    });

    it('rejects a missing token', () => {
        expect(parseEsdAmount(undefined)).toBeNull();
    });

    it('rejects a token past the 10-digit length bound', () => {
        expect(parseEsdAmount('12345678901')).toBeNull();
    });
});
