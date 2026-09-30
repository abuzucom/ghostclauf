import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPublicSnapshot } from '../src/publicSite/export.js';

const execFileAsync = promisify(execFile);

describe('createPublicSnapshot', () => {
    it('keeps the public snapshot outside the private data ignore rule', async () => {
        await expect(
            execFileAsync('git', ['check-ignore', '-q', 'site/data/public.json']),
        ).rejects.toMatchObject({ code: 1 });
    });

    it('allowlists public fields and ranks loyalty rows deterministically', () => {
        const snapshot = createPublicSnapshot({
            currencyName: 'esports dollars',
            generatedAt: new Date('2026-08-09T00:00:00.000Z'),
            funFacts: {
                version: 1,
                scopes: {
                    shared: {
                        nextId: 2,
                        facts: [
                            {
                                id: 1,
                                text: 'A public fact',
                                addedByChatterId: 'private-curator-id',
                                addedByDisplayName: 'Private Curator',
                                addedInBroadcasterId: 'private-channel-id',
                                addedAt: '2026-08-08T00:00:00.000Z',
                            },
                        ],
                    },
                },
            },
            quotes: {
                version: 1,
                scopes: {
                    shared: {
                        nextId: 2,
                        quotes: [
                            {
                                id: 1,
                                text: 'A public quote',
                                speaker: 'Speaker',
                                addedByChatterId: 'private-curator-id',
                                addedByDisplayName: 'Private Curator',
                                addedInBroadcasterId: 'private-channel-id',
                                addedAt: '2026-08-08T00:00:00.000Z',
                            },
                        ],
                    },
                },
            },
            loyalty: {
                version: 2,
                scopes: {
                    shared: {
                        viewers: {
                            viewerB: {
                                displayName: 'Beta',
                                balance: 10,
                                grants: { privateGrant: 1 },
                                spent: 0,
                                redeemed: { privateReward: 1 },
                            },
                            viewerA: {
                                displayName: 'Alpha',
                                balance: 10,
                                grants: {},
                                spent: 0,
                                redeemed: {},
                            },
                        },
                        redeemedTotals: { privateReward: 1 },
                    },
                },
                decisions: [{ private: true }],
                redemptions: [{ private: true }],
            },
        });

        expect(snapshot).toEqual({
            version: 1,
            generatedAt: '2026-08-09T00:00:00.000Z',
            facts: [{ id: 1, text: 'A public fact' }],
            quotes: [{ id: 1, text: 'A public quote', speaker: 'Speaker' }],
            loyalty: {
                currencyName: 'esports dollars',
                participantCount: 2,
                totalBalance: 20,
                leaderboard: [
                    { rank: 1, displayName: 'Alpha', balance: 10 },
                    { rank: 2, displayName: 'Beta', balance: 10 },
                ],
            },
        });

        const serialized = JSON.stringify(snapshot);
        expect(serialized).not.toContain('private-');
        expect(serialized).not.toContain('addedBy');
        expect(serialized).not.toContain('decisions');
        expect(serialized).not.toContain('redemptions');
    });

    it('ignores malformed records without exporting private store structure', () => {
        const snapshot = createPublicSnapshot({
            currencyName: 'esports dollars',
            generatedAt: new Date('2026-08-09T00:00:00.000Z'),
            funFacts: { version: 1, scopes: { shared: { facts: [{ id: 'bad' }] } } },
            quotes: { version: 1, scopes: { shared: { quotes: [{ text: 1 }] } } },
            loyalty: {
                version: 2,
                scopes: { shared: { viewers: { viewer: { balance: 'bad' } } } },
            },
        });

        expect(snapshot.facts).toEqual([]);
        expect(snapshot.quotes).toEqual([]);
        expect(snapshot.loyalty).toEqual({
            currencyName: 'esports dollars',
            participantCount: 0,
            totalBalance: 0,
            leaderboard: [],
        });
    });

    it('ignores balances outside the persisted loyalty range', () => {
        const snapshot = createPublicSnapshot({
            currencyName: 'esports dollars',
            generatedAt: new Date('2026-08-09T00:00:00.000Z'),
            funFacts: {},
            quotes: {},
            loyalty: {
                scopes: {
                    shared: {
                        viewers: {
                            unsafe: {
                                displayName: 'Unsafe',
                                balance: Number.MAX_SAFE_INTEGER,
                            },
                            valid: { displayName: 'Valid', balance: 1_000_000_000 },
                        },
                    },
                },
            },
        });

        expect(snapshot.loyalty).toEqual({
            currencyName: 'esports dollars',
            participantCount: 1,
            totalBalance: 1_000_000_000,
            leaderboard: [{ rank: 1, displayName: 'Valid', balance: 1_000_000_000 }],
        });
    });
});

describe('public leaderboard cap and hidden names', () => {
    function loyaltyWith(
        viewers: Record<string, { displayName: string; balance: number }>,
        hiddenViewers?: unknown,
    ): unknown {
        return {
            version: 2,
            scopes: { shared: { viewers } },
            decisions: [],
            redemptions: [],
            ...(hiddenViewers === undefined ? {} : { hiddenViewers }),
        };
    }

    function snapshotOf(loyalty: unknown, leaderboardSize?: number) {
        return createPublicSnapshot({
            currencyName: 'esports dollars',
            generatedAt: new Date('2026-08-09T00:00:00.000Z'),
            funFacts: {},
            quotes: {},
            loyalty,
            ...(leaderboardSize === undefined ? {} : { leaderboardSize }),
        });
    }

    const SEVEN_VIEWERS = Object.fromEntries(
        Array.from({ length: 7 }, (_, index) => [
            `id${index}`,
            { displayName: `Viewer${index}`, balance: 100 - index },
        ]),
    );

    it('publishes the top five by default but aggregates every viewer', () => {
        const { loyalty } = snapshotOf(loyaltyWith(SEVEN_VIEWERS));
        expect(loyalty.leaderboard.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(loyalty.participantCount).toBe(7);
        expect(loyalty.totalBalance).toBe(100 + 99 + 98 + 97 + 96 + 95 + 94);
    });

    it('honors a configured leaderboard size', () => {
        const { loyalty } = snapshotOf(loyaltyWith(SEVEN_VIEWERS), 2);
        expect(loyalty.leaderboard.map((entry) => entry.displayName)).toEqual([
            'Viewer0',
            'Viewer1',
        ]);
    });

    it('replaces a hidden name with the placeholder, keeping rank and balance', () => {
        const { loyalty } = snapshotOf(
            loyaltyWith(
                {
                    secret: { displayName: 'Secret', balance: 50 },
                    open: { displayName: 'Open', balance: 20 },
                },
                { secret: 'self' },
            ),
        );
        expect(loyalty.leaderboard).toEqual([
            { rank: 1, displayName: 'Hidden viewer', balance: 50 },
            { rank: 2, displayName: 'Open', balance: 20 },
        ]);
        expect(JSON.stringify(loyalty)).not.toContain('Secret');
    });

    it('orders ties on the shown name so a hidden name cannot be inferred', () => {
        const { loyalty } = snapshotOf(
            loyaltyWith(
                {
                    a: { displayName: 'Aaron', balance: 10 },
                    m: { displayName: 'Mia', balance: 10 },
                },
                { a: 'broadcaster' },
            ),
        );
        expect(loyalty.leaderboard.map((entry) => entry.displayName)).toEqual([
            'Hidden viewer',
            'Mia',
        ]);
    });

    it('refuses to export when the hidden-name list is malformed', () => {
        expect(() => snapshotOf(loyaltyWith(SEVEN_VIEWERS, ['id0']))).toThrow(/hiddenViewers/);
    });
});
