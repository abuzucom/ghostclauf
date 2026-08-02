import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FunFactStore, MAX_FACTS, SHARED_SCOPE_KEY } from '../src/plugins/funfact/store.js';
import { makeSpyLogger, testLogger } from './helpers.js';

const ADDED_AT = new Date('2026-08-02T18:04:05.000Z');

describe('FunFactStore', () => {
    let dir: string;
    let dataPath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-funfact-store-'));
        dataPath = join(dir, 'funfacts.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function makeStore(): Promise<FunFactStore> {
        const store = new FunFactStore(dataPath, testLogger);
        await store.load();
        return store;
    }

    async function add(store: FunFactStore, text: string) {
        return store.add(SHARED_SCOPE_KEY, text, '10', 'Tank', '1', ADDED_AT);
    }

    it('starts empty when no file exists', async () => {
        const store = await makeStore();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        expect(store.pick(SHARED_SCOPE_KEY, 0)).toBeUndefined();
    });

    it('assigns monotonic ids and records attribution', async () => {
        const store = await makeStore();
        const first = await add(store, 'first fact');
        const second = await add(store, 'second fact');
        expect(first).toEqual({
            status: 'added',
            fact: {
                id: 1,
                text: 'first fact',
                addedByChatterId: '10',
                addedByDisplayName: 'Tank',
                addedInBroadcasterId: '1',
                addedAt: '2026-08-02T18:04:05.000Z',
            },
        });
        expect(second.status).toBe('added');
        expect(store.count(SHARED_SCOPE_KEY)).toBe(2);
    });

    it('reports the existing entry for a case-insensitive duplicate', async () => {
        const store = await makeStore();
        await add(store, 'Repeated Fact');
        const outcome = await add(store, 'repeated fact');
        expect(outcome).toEqual({
            status: 'duplicate',
            fact: expect.objectContaining({ id: 1, text: 'Repeated Fact' }),
        });
        expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
    });

    it('refuses adds once the pool is full', async () => {
        const store = await makeStore();
        for (let i = 0; i < MAX_FACTS; i += 1) {
            await add(store, `fact ${i}`);
        }
        const outcome = await add(store, 'one too many');
        expect(outcome).toEqual({ status: 'full' });
        expect(store.count(SHARED_SCOPE_KEY)).toBe(MAX_FACTS);
    });

    it('picks by roll across the pool', async () => {
        const store = await makeStore();
        await add(store, 'a');
        await add(store, 'b');
        await add(store, 'c');
        expect(store.pick(SHARED_SCOPE_KEY, 0)?.text).toBe('a');
        expect(store.pick(SHARED_SCOPE_KEY, 0.5)?.text).toBe('b');
        // A roll of exactly 1 cannot happen with Math.random, but must not
        // fall off the end if a caller supplies it.
        expect(store.pick(SHARED_SCOPE_KEY, 1)?.text).toBe('c');
    });

    it('removes by id without reusing the id', async () => {
        const store = await makeStore();
        await add(store, 'first');
        await add(store, 'second');
        const removed = await store.remove(SHARED_SCOPE_KEY, 1);
        expect(removed?.text).toBe('first');
        expect(await store.remove(SHARED_SCOPE_KEY, 1)).toBeNull();
        expect(store.get(SHARED_SCOPE_KEY, 1)).toBeUndefined();
        const next = await add(store, 'third');
        expect(next).toMatchObject({ status: 'added', fact: { id: 3 } });
    });

    it('keeps scopes independent', async () => {
        const store = await makeStore();
        await store.add('1', 'channel one fact', '10', 'Tank', '1', ADDED_AT);
        await store.add('2', 'channel two fact', '20', 'Dj', '2', ADDED_AT);
        expect(store.count('1')).toBe(1);
        expect(store.count('2')).toBe(1);
        expect(store.pick('1', 0)?.text).toBe('channel one fact');
    });

    it('persists to an owner-only file that a fresh store reloads', async () => {
        const store = await makeStore();
        await add(store, 'durable fact');
        await store.flush();

        const reloaded = await makeStore();
        expect(reloaded.count(SHARED_SCOPE_KEY)).toBe(1);
        expect(reloaded.get(SHARED_SCOPE_KEY, 1)?.text).toBe('durable fact');
        // Ids continue from the persisted counter.
        expect(await add(reloaded, 'another')).toMatchObject({ fact: { id: 2 } });
    });

    it('preserves an unreadable file and starts empty', async () => {
        await writeFile(dataPath, 'not json at all', 'utf8');
        const spy = makeSpyLogger();
        const store = new FunFactStore(dataPath, spy.logger);
        await store.load();

        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        const preserved = (await readdir(dir)).filter((name) =>
            name.startsWith('funfacts.json.corrupt-'),
        );
        expect(preserved).toHaveLength(1);
        expect(await readFile(join(dir, preserved[0]!), 'utf8')).toBe('not json at all');
        expect(spy.error).toHaveBeenCalled();
    });

    function storedFact(overrides: Record<string, unknown> = {}) {
        return {
            id: 1,
            text: 'a stored fact',
            addedByChatterId: '10',
            addedByDisplayName: 'Tank',
            addedInBroadcasterId: '1',
            addedAt: '2026-08-02T18:04:05.000Z',
            ...overrides,
        };
    }

    function storedFile(scope: Record<string, unknown>) {
        return JSON.stringify({
            version: 1,
            scopes: { shared: { nextId: 2, facts: [], ...scope } },
        });
    }

    const invalidFiles: ReadonlyArray<[string, string]> = [
        ['a fact missing fields', storedFile({ facts: [{ id: 1 }] })],
        [
            'text past the length cap',
            storedFile({ facts: [storedFact({ text: 'x'.repeat(301) })] }),
        ],
        ['empty text', storedFile({ facts: [storedFact({ text: '' })] })],
        ['a non-integer id', storedFile({ facts: [storedFact({ id: 1.5 })] })],
        [
            'a timestamp that is not ISO 8601',
            storedFile({ facts: [storedFact({ addedAt: 'now' })] }),
        ],
        [
            'duplicate ids',
            storedFile({ nextId: 3, facts: [storedFact(), storedFact({ text: 'other' })] }),
        ],
        ['an id at or past nextId', storedFile({ nextId: 1, facts: [storedFact()] })],
        ['a wrong version', JSON.stringify({ version: 2, scopes: {} })],
    ];

    it.each(invalidFiles)('rejects a file with %s', async (_label, contents) => {
        await writeFile(dataPath, contents, 'utf8');
        const store = new FunFactStore(dataPath, testLogger);
        await store.load();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
    });

    it('never resolves a scope key to an inherited object member', async () => {
        const store = await makeStore();
        await add(store, 'a fact');
        await store.flush();

        const reloaded = await makeStore();
        for (const key of ['constructor', 'toString', '__proto__']) {
            expect(reloaded.count(key)).toBe(0);
            expect(reloaded.pick(key, 0)).toBeUndefined();
            expect(reloaded.get(key, 1)).toBeUndefined();
        }
    });
});
