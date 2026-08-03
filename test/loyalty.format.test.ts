import { describe, expect, it } from 'vitest';
import {
    applyAward,
    buildLeaderboard,
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
        expect(renderBalance('points', 'Viewer', 42)).toBe('Viewer has 42 points.');
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
        expect(renderLeaderboard('points', [])).toBe('No points earned yet.');
    });

    it('renders a numbered, comma-separated list', () => {
        expect(
            renderLeaderboard('points', [
                { displayName: 'Bob', balance: 20 },
                { displayName: 'Cara', balance: 10 },
            ]),
        ).toBe('Top points: 1. Bob (20), 2. Cara (10)');
    });

    it('keeps a full leaderboard inside the 500-character chat limit', () => {
        // ctx.say throws past 500, which would drop the whole reply. 25 rows
        // is the configurable maximum and overruns the limit on its own.
        const entries = Array.from({ length: 25 }, (_, i) => ({
            displayName: `Viewer${String(i).padStart(2, '0')}Name${'x'.repeat(14)}`,
            balance: 123456,
        }));
        const rendered = renderLeaderboard('points', entries);
        expect([...rendered].length).toBeLessThanOrEqual(500);
    });

    it('drops whole trailing rows rather than cutting one mid-entry', () => {
        const entries = Array.from({ length: 25 }, (_, i) => ({
            displayName: `Viewer${String(i).padStart(2, '0')}Name${'x'.repeat(14)}`,
            balance: 123456,
        }));
        const rendered = renderLeaderboard('points', entries);
        // Whatever rows survive, the last one is complete: it ends with the
        // closing paren of a balance, not a severed name.
        expect(rendered.endsWith(')')).toBe(true);
        expect(rendered.startsWith('Top points: 1. ')).toBe(true);
    });

    it('still truncates when even the first row cannot fit', () => {
        const rendered = renderLeaderboard('points', [
            { displayName: 'x'.repeat(600), balance: 1 },
        ]);
        expect([...rendered].length).toBe(500);
    });

    it('keeps a balance reply inside the chat limit', () => {
        const rendered = renderBalance('points', 'y'.repeat(600), 1);
        expect([...rendered].length).toBe(500);
    });
});
