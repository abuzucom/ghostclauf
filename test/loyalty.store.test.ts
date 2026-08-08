import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { LoyaltyStore, SHARED_SCOPE_KEY } from '../src/plugins/loyalty/store.js';
import { makeSpyLogger, testLogger } from './helpers.js';

describe('LoyaltyStore', () => {
    let dir: string;
    let dataPath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-loyalty-store-'));
        dataPath = join(dir, 'loyalty.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function makeStore(): Promise<LoyaltyStore> {
        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();
        return store;
    }

    it('starts at a zero balance when no file exists', async () => {
        const store = await makeStore();
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
        expect(store.leaderboardViewers(SHARED_SCOPE_KEY)).toEqual({});
    });

    it('awards a new viewer and records their display name', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 3 },
        ]);
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(3);
        expect(store.getDisplayName(SHARED_SCOPE_KEY, '10')).toBe('Tank');
    });

    it('accumulates across multiple awards', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 3 },
        ]);
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 4 },
        ]);
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(7);
    });

    it('applies a whole batch of awards in one call', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 1 },
            { chatterId: '20', displayName: 'Dj', amount: 1 },
        ]);
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(1);
        expect(store.getBalance(SHARED_SCOPE_KEY, '20')).toBe(1);
    });

    it('updates a viewer display name on a later award', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'OldName', amount: 1 },
        ]);
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'NewName', amount: 1 },
        ]);
        expect(store.getDisplayName(SHARED_SCOPE_KEY, '10')).toBe('NewName');
    });

    it('clamps a negative or over-cap award instead of corrupting the balance', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: -5 },
        ]);
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
    });

    it('does nothing and does not persist for an empty award batch', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, []);
        expect(await readdir(dir).catch(() => [])).toEqual([]);
    });

    it('does not persist when every award in the batch clamps to zero', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 0 },
            { chatterId: '11', displayName: 'Dj', amount: -5 },
        ]);
        // Nothing changed, so the tick must not rewrite the same file.
        expect(await readdir(dir).catch(() => [])).toEqual([]);
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
    });

    it('keeps scopes independent', async () => {
        const store = await makeStore();
        await store.awardMany('1', [{ chatterId: '10', displayName: 'Tank', amount: 5 }]);
        await store.awardMany('2', [{ chatterId: '10', displayName: 'Tank', amount: 9 }]);
        expect(store.getBalance('1', '10')).toBe(5);
        expect(store.getBalance('2', '10')).toBe(9);
    });

    it('persists to an owner-only file that a fresh store reloads', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 5 },
        ]);
        await store.flush();

        const reloaded = await makeStore();
        expect(reloaded.getBalance(SHARED_SCOPE_KEY, '10')).toBe(5);
    });

    it('preserves an unreadable file and starts empty', async () => {
        await writeFile(dataPath, 'not json at all', 'utf8');
        const spy = makeSpyLogger();
        const store = new LoyaltyStore(dataPath, spy.logger);
        await store.load();

        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
        const preserved = (await readdir(dir)).filter((name) =>
            name.startsWith('loyalty.json.corrupt-'),
        );
        expect(preserved).toHaveLength(1);
        expect(await readFile(join(dir, preserved[0]!), 'utf8')).toBe('not json at all');
        expect(spy.error).toHaveBeenCalled();
    });

    describe('grant pruning', () => {
        function v2WithGrants(grants: Record<string, number>) {
            return JSON.stringify({
                version: 2,
                scopes: {
                    shared: {
                        viewers: { '10': { displayName: 'Tank', balance: 1, grants } },
                    },
                },
                decisions: [],
                redemptions: [],
            });
        }

        async function loadGrants(grants: Record<string, number>) {
            await writeFile(dataPath, v2WithGrants(grants), 'utf8');
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            // Force a write so the pruned shape lands on disk, then read it back.
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Tank', amount: 1 },
            ]);
            await store.flush();
            const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
                scopes: {
                    shared: { viewers: Record<string, { grants?: Record<string, number> }> };
                };
            };
            return written.scopes.shared.viewers['10']!.grants ?? {};
        }

        it('keeps time-bucketed keys under the cap untouched', async () => {
            const grants: Record<string, number> = {};
            for (let i = 0; i < 10; i += 1)
                grants[`sub:1:2026-${String(i + 1).padStart(2, '0')}`] = i;

            expect(Object.keys(await loadGrants(grants))).toHaveLength(10);
        });

        it('trims time-bucketed keys past the cap, newest first', async () => {
            const grants: Record<string, number> = {};
            for (let i = 0; i < 100; i += 1) grants[`cheer:1:20:${i}`] = i;

            const pruned = await loadGrants(grants);

            expect(Object.keys(pruned)).toHaveLength(64);
            // Newest survive: 36..99 by timestamp.
            expect(pruned['cheer:1:20:99']).toBe(99);
            expect(pruned['cheer:1:20:0']).toBeUndefined();
        });

        it('never prunes a follow grant, even far past the cap', async () => {
            // The anti-refarm guarantee: if this key ages out, an unfollow and
            // refollow pays the bonus again, forever.
            const grants: Record<string, number> = { 'follow:1': 0 };
            for (let i = 0; i < 200; i += 1) grants[`cheer:1:20:${i}`] = i + 1;

            const pruned = await loadGrants(grants);

            expect(pruned['follow:1']).toBe(0);
            expect(Object.keys(pruned)).toHaveLength(65);
        });

        it('keeps every follow grant when they alone exceed the cap', async () => {
            const grants: Record<string, number> = {};
            for (let i = 0; i < 100; i += 1) grants[`follow:${i}`] = i;

            expect(Object.keys(await loadGrants(grants))).toHaveLength(100);
        });
    });

    describe('applyDecision / undoLatest', () => {
        const clock = DateTime.utc(2026, 8, 4, 12, 0, 0);
        const admin = { chatterId: '1', chatterName: 'broadcaster' };

        function decisionInput(
            kind: 'set' | 'give' | 'take',
            requestedAmount: number,
            overrides: Partial<Parameters<LoyaltyStore['applyDecision']>[0]> = {},
        ) {
            return {
                scopeKey: SHARED_SCOPE_KEY,
                kind,
                chatterId: '10',
                chatterName: 'viewer',
                displayName: 'Viewer',
                requestedAmount,
                createdByChatterId: admin.chatterId,
                createdByChatterName: admin.chatterName,
                createdInBroadcasterId: '1',
                now: clock,
                ...overrides,
            };
        }

        it('set writes the balance exactly and records before/after', async () => {
            const store = await makeStore();
            const result = await store.applyDecision(decisionInput('set', 100));

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.decision.beforeBalance).toBe(0);
            expect(result.decision.afterBalance).toBe(100);
            expect(result.decision.requestedAmount).toBe(100);
            expect(result.decision.kind).toBe('set');
            expect(result.decision.status).toBe('applied');
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(100);
        });

        it('give adds to the existing balance', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            const result = await store.applyDecision(decisionInput('give', 50));

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.decision.beforeBalance).toBe(100);
            expect(result.decision.afterBalance).toBe(150);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(150);
        });

        it('take subtracts from the existing balance', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            const result = await store.applyDecision(decisionInput('take', 30));

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.decision.afterBalance).toBe(70);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(70);
        });

        it('take clamps at 0 rather than going negative, and records what actually happened', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 30));
            const result = await store.applyDecision(decisionInput('take', 50));

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.decision.requestedAmount).toBe(50);
            expect(result.decision.beforeBalance).toBe(30);
            expect(result.decision.afterBalance).toBe(0);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
        });

        it('give clamps at MAX_BALANCE', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 999_999_999));
            const result = await store.applyDecision(decisionInput('give', 100));

            expect(result.ok).toBe(true);
            if (!result.ok) return;
            expect(result.decision.afterBalance).toBe(1_000_000_000);
        });

        it('set on a brand new viewer creates the record', async () => {
            const store = await makeStore();
            const result = await store.applyDecision(decisionInput('set', 5));

            expect(result.ok).toBe(true);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(5);
            expect(store.getDisplayName(SHARED_SCOPE_KEY, '10')).toBe('Viewer');
        });

        it('persists the decision to the journal, in the same write as the balance', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            await store.flush();

            const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
                decisions: Array<{ kind: string; afterBalance: number }>;
            };
            expect(written.decisions).toHaveLength(1);
            expect(written.decisions[0]).toMatchObject({ kind: 'set', afterBalance: 100 });
        });

        it('undoLatest reverses a set by its recorded delta, keeping earnings made after it', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            // Earnings after the set must survive the undo - undo removes the
            // set's effect, it does not pin the viewer back to beforeBalance.
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Viewer', amount: 20 },
            ]);

            const undo = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'set', admin, clock);

            expect(undo.ok).toBe(true);
            if (!undo.ok) return;
            // 120 - (100 - 0) = 20: the untouched pre-set balance plus the award.
            // An absolute restore would give 0, discarding the award - this is
            // the case that tells the two strategies apart.
            expect(undo.balance).toBe(20);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(20);
        });

        it('undo reverses only its own kind, keeping an intervening operation of a different kind', async () => {
            // The worked example from the plan: give then take, undo the give.
            // Chosen so delta reversal and absolute restore disagree - proof the
            // undo is genuinely reversing a delta, not resetting to beforeBalance.
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 200));
            await store.applyDecision(decisionInput('give', 50)); // 200 -> 250
            await store.applyDecision(decisionInput('take', 30)); // 250 -> 220

            const undo = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'give', admin, clock);

            expect(undo.ok).toBe(true);
            if (!undo.ok) return;
            // 220 - (250 - 200) = 170: the take's -30 survives the give's undo.
            // Absolute restore to the give's beforeBalance would give 200,
            // silently discarding the take - a different, wrong answer.
            expect(undo.balance).toBe(170);
            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(170);
        });

        it('marks the reversed decision undone and records who/when', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            await store.undoLatest(SHARED_SCOPE_KEY, '10', 'set', admin, clock);
            await store.flush();

            const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
                decisions: Array<{
                    status: string;
                    undoneAt: string | null;
                    undoneByChatterId: string | null;
                }>;
            };
            expect(written.decisions[0]!.status).toBe('undone');
            expect(written.decisions[0]!.undoneAt).not.toBeNull();
            expect(written.decisions[0]!.undoneByChatterId).toBe(admin.chatterId);
        });

        it('reports nothing to undo when there is no applied decision of that kind', async () => {
            const store = await makeStore();
            const undo = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'give', admin, clock);
            expect(undo.ok).toBe(false);
        });

        it('reports nothing to undo on a second undo of the same kind', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('set', 100));
            await store.undoLatest(SHARED_SCOPE_KEY, '10', 'set', admin, clock);
            const second = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'set', admin, clock);
            expect(second.ok).toBe(false);
        });

        it('undoing one kind does not consume the undo availability of another kind', async () => {
            const store = await makeStore();
            await store.applyDecision(decisionInput('give', 50));
            await store.applyDecision(decisionInput('take', 20));
            const undoTake = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'take', admin, clock);
            expect(undoTake.ok).toBe(true);
            // The give is still reversible after the take's undo.
            const undoGive = await store.undoLatest(SHARED_SCOPE_KEY, '10', 'give', admin, clock);
            expect(undoGive.ok).toBe(true);
            if (!undoGive.ok) return;
            expect(undoGive.balance).toBe(0);
        });
    });

    describe('decision journal retention', () => {
        function retentionInput(minute: number) {
            return {
                scopeKey: SHARED_SCOPE_KEY,
                kind: 'give' as const,
                chatterId: '10',
                chatterName: 'viewer',
                displayName: 'Viewer',
                requestedAmount: 1,
                createdByChatterId: '1',
                createdByChatterName: 'broadcaster',
                createdInBroadcasterId: '1',
                // .plus, not a raw minute field: DateTime.utc does not
                // normalize an overflowing minute (60+), it returns an
                // Invalid DateTime, silently persisting createdAt as null.
                now: DateTime.utc(2026, 8, 4, 12, 0, 0).plus({ minutes: minute }),
            };
        }

        it('never prunes an applied decision, however many accumulate', async () => {
            const store = await makeStore();
            for (let i = 0; i < 80; i += 1) {
                await store.applyDecision(retentionInput(i));
            }
            await store.flush();

            const reloaded = new LoyaltyStore(dataPath, testLogger);
            await reloaded.load();
            // Force a write so the post-load (pruned) state lands on disk.
            await reloaded.applyDecision({ ...retentionInput(999), chatterId: 'force-write' });
            await reloaded.flush();

            const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
                decisions: Array<{ status: string }>;
            };
            const applied = written.decisions.filter((d) => d.status === 'applied');
            // 80 from the loop, plus the force-write itself - also applied.
            expect(applied).toHaveLength(81);
        });

        it('prunes undone decisions to the newest 50 per viewer at load()', async () => {
            const store = await makeStore();
            for (let i = 0; i < 80; i += 1) {
                const input = retentionInput(i);
                await store.applyDecision(input);
                await store.undoLatest(
                    SHARED_SCOPE_KEY,
                    '10',
                    'give',
                    { chatterId: '1' },
                    input.now,
                );
            }
            await store.flush();

            const reloaded = new LoyaltyStore(dataPath, testLogger);
            await reloaded.load();
            // Force a write so the post-load (pruned) state lands on disk.
            await reloaded.applyDecision({ ...retentionInput(999), chatterId: 'force-write' });
            await reloaded.flush();

            const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
                decisions: Array<{ status: string }>;
            };
            const undone = written.decisions.filter((d) => d.status === 'undone');
            expect(undone).toHaveLength(50);
        });
    });

    describe('schema v2 migration', () => {
        function v1File(viewers: Record<string, { displayName: string; balance: number }>) {
            return JSON.stringify({ version: 1, scopes: { shared: { viewers } } });
        }

        it('loads a version 1 file with balances intact', async () => {
            await writeFile(
                dataPath,
                v1File({ '10': { displayName: 'Tank', balance: 42 } }),
                'utf8',
            );
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();

            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(42);
            // A rejected file would have been quarantined and the balance lost.
            const preserved = (await readdir(dir)).filter((n) =>
                n.startsWith('loyalty.json.corrupt-'),
            );
            expect(preserved).toHaveLength(0);
        });

        it('round-trips a version 2 file', async () => {
            // Pre-fix this fails by *silently starting empty*, not by throwing:
            // z.literal(1) rejects v2, the file is quarantined, balances vanish.
            const v2 = JSON.stringify({
                version: 2,
                scopes: { shared: { viewers: { '10': { displayName: 'Tank', balance: 7 } } } },
                decisions: [],
                redemptions: [],
            });
            await writeFile(dataPath, v2, 'utf8');
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();

            expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(7);
        });

        it('writes a one-time v1 snapshot before the first v2 persist', async () => {
            const original = v1File({ '10': { displayName: 'Tank', balance: 5 } });
            await writeFile(dataPath, original, 'utf8');
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();

            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Tank', amount: 1 },
            ]);
            await store.flush();

            // The snapshot is the pristine v1 file, so a rollback to a v1 build
            // can recover rather than quarantining a v2 file it cannot parse.
            expect(await readFile(`${dataPath}.v1`, 'utf8')).toBe(original);
        });

        it('never overwrites an existing v1 snapshot', async () => {
            const original = v1File({ '10': { displayName: 'Tank', balance: 5 } });
            await writeFile(dataPath, original, 'utf8');
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Tank', amount: 1 },
            ]);
            await store.flush();

            // A second run must not clobber the snapshot with v2 content.
            const reloaded = new LoyaltyStore(dataPath, testLogger);
            await reloaded.load();
            await reloaded.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Tank', amount: 1 },
            ]);
            await reloaded.flush();

            expect(await readFile(`${dataPath}.v1`, 'utf8')).toBe(original);
        });

        it('leaves a v1 file untouched when nothing is ever written', async () => {
            const original = v1File({ '10': { displayName: 'Tank', balance: 5 } });
            await writeFile(dataPath, original, 'utf8');
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.flush();

            // Migration is lazy: starting the bot and earning nothing must not
            // rewrite the file, so the operation stays idempotent.
            expect(await readFile(dataPath, 'utf8')).toBe(original);
            expect(await readdir(dir)).toEqual(['loyalty.json']);
        });
    });

    function storedFile(scope: Record<string, unknown>) {
        return JSON.stringify({ version: 1, scopes: { shared: { viewers: {}, ...scope } } });
    }

    const invalidFiles: ReadonlyArray<[string, string]> = [
        ['a viewer missing fields', storedFile({ viewers: { '10': { displayName: 'Tank' } } })],
        [
            'a negative balance',
            storedFile({ viewers: { '10': { displayName: 'Tank', balance: -1 } } }),
        ],
        [
            'a non-integer balance',
            storedFile({ viewers: { '10': { displayName: 'Tank', balance: 1.5 } } }),
        ],
        [
            'an empty display name',
            storedFile({ viewers: { '10': { displayName: '', balance: 1 } } }),
        ],
        ['a wrong version', JSON.stringify({ version: 2, scopes: {} })],
    ];

    it.each(invalidFiles)('rejects a file with %s', async (_label, contents) => {
        await writeFile(dataPath, contents, 'utf8');
        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();
        expect(store.getBalance(SHARED_SCOPE_KEY, '10')).toBe(0);
    });

    // The load schema is the contract; anything awardMany writes must survive a
    // reload. Asserted as a round-trip rather than by inspecting the file, so
    // these fail if either side of the invariant drifts.
    const selfCorruptionCases: ReadonlyArray<[string, { displayName: string; amount: number }]> = [
        ['a NaN amount', { displayName: 'Tank', amount: Number.NaN }],
        ['an Infinite amount', { displayName: 'Tank', amount: Number.POSITIVE_INFINITY }],
        ['an over-long display name', { displayName: 'x'.repeat(500), amount: 5 }],
        ['an empty display name', { displayName: '', amount: 5 }],
    ];

    it.each(selfCorruptionCases)(
        'writes a file that reloads cleanly despite %s',
        async (_label, award) => {
            const store = await makeStore();
            await store.awardMany(SHARED_SCOPE_KEY, [{ chatterId: '10', ...award }]);
            await store.flush();

            const reloaded = new LoyaltyStore(dataPath, testLogger);
            await reloaded.load();

            // A rejected file would have been preserved as .corrupt-* and the
            // balance reset to 0, so a surviving balance proves it round-tripped.
            const preserved = (await readdir(dir)).filter((name) =>
                name.startsWith('loyalty.json.corrupt-'),
            );
            expect(preserved).toHaveLength(0);
            expect(reloaded.getBalance(SHARED_SCOPE_KEY, '10')).toBe(
                store.getBalance(SHARED_SCOPE_KEY, '10'),
            );
        },
    );

    it('skips an award whose chatter id cannot be stored', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '', displayName: 'Tank', amount: 5 },
            { chatterId: 'x'.repeat(65), displayName: 'Dj', amount: 5 },
        ]);
        expect(await readdir(dir).catch(() => [])).toEqual([]);
    });

    it('rejects a file whose scope exceeds the viewer cap', async () => {
        // The write path caps viewers per scope; the file is untrusted input,
        // so a hand-edited one claiming more must not load unbounded.
        const viewers: Record<string, { displayName: string; balance: number }> = {};
        for (let i = 0; i <= 100_000; i += 1) {
            viewers[String(i)] = { displayName: 'V', balance: 1 };
        }
        await writeFile(dataPath, storedFile({ viewers }), 'utf8');
        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();

        expect(store.getBalance(SHARED_SCOPE_KEY, '0')).toBe(0);
    });

    it('loads a file at exactly the viewer cap', async () => {
        const viewers: Record<string, { displayName: string; balance: number }> = {};
        for (let i = 0; i < 100_000; i += 1) {
            viewers[String(i)] = { displayName: 'V', balance: 7 };
        }
        await writeFile(dataPath, storedFile({ viewers }), 'utf8');
        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();

        expect(store.getBalance(SHARED_SCOPE_KEY, '0')).toBe(7);
    });

    it('never resolves a scope or chatter key to an inherited object member', async () => {
        const store = await makeStore();
        await store.awardMany(SHARED_SCOPE_KEY, [
            { chatterId: '10', displayName: 'Tank', amount: 1 },
        ]);
        await store.flush();

        const reloaded = await makeStore();
        for (const key of ['constructor', 'toString', '__proto__']) {
            expect(reloaded.getBalance(key, '10')).toBe(0);
            expect(reloaded.getBalance(SHARED_SCOPE_KEY, key)).toBe(0);
        }
    });
});
