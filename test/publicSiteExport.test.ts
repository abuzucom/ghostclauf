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
});
