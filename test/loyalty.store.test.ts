import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
