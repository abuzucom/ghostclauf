import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_QUOTES, QuoteStore, SHARED_SCOPE_KEY } from '../src/plugins/quotes/store.js';
import { makeSpyLogger, testLogger } from './helpers.js';

const ADDED_AT = new Date('2026-08-02T18:04:05.000Z');

describe('QuoteStore', () => {
    let dir: string;
    let dataPath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-quotes-store-'));
        dataPath = join(dir, 'quotes.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function makeStore(): Promise<QuoteStore> {
        const store = new QuoteStore(dataPath, testLogger);
        await store.load();
        return store;
    }

    async function add(store: QuoteStore, text: string, speaker: string | null = null) {
        return store.add(SHARED_SCOPE_KEY, text, speaker, '10', 'Tank', '1', ADDED_AT);
    }

    it('starts empty when no file exists', async () => {
        const store = await makeStore();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        expect(store.pick(SHARED_SCOPE_KEY, 0)).toBeUndefined();
    });

    it('assigns monotonic ids and records attribution and speaker', async () => {
        const store = await makeStore();
        const first = await add(store, 'first quote', 'Tank');
        const second = await add(store, 'second quote');
        expect(first).toEqual({
            status: 'added',
            quote: {
                id: 1,
                text: 'first quote',
                speaker: 'Tank',
                addedByChatterId: '10',
                addedByDisplayName: 'Tank',
                addedInBroadcasterId: '1',
                addedAt: '2026-08-02T18:04:05.000Z',
            },
        });
        expect(second.status).toBe('added');
        expect(store.count(SHARED_SCOPE_KEY)).toBe(2);
    });

    it('reports the existing entry for a case-insensitive duplicate of text and speaker', async () => {
        const store = await makeStore();
        await add(store, 'Repeated Quote', 'Tank');
        const outcome = await add(store, 'repeated quote', 'tank');
        expect(outcome).toEqual({
            status: 'duplicate',
            quote: expect.objectContaining({ id: 1, text: 'Repeated Quote' }),
        });
        expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
    });

    it('treats the same text with a different speaker as distinct', async () => {
        const store = await makeStore();
        await add(store, 'same text', 'Tank');
        const outcome = await add(store, 'same text', 'Dj');
        expect(outcome.status).toBe('added');
        expect(store.count(SHARED_SCOPE_KEY)).toBe(2);
    });

    it('refuses adds once the pool is full', async () => {
        const store = await makeStore();
        for (let i = 0; i < MAX_QUOTES; i += 1) {
            await add(store, `quote ${i}`);
        }
        const outcome = await add(store, 'one too many');
        expect(outcome).toEqual({ status: 'full' });
        expect(store.count(SHARED_SCOPE_KEY)).toBe(MAX_QUOTES);
    });

    it('picks by roll across the pool', async () => {
        const store = await makeStore();
        await add(store, 'a');
        await add(store, 'b');
        await add(store, 'c');
        expect(store.pick(SHARED_SCOPE_KEY, 0)?.text).toBe('a');
        expect(store.pick(SHARED_SCOPE_KEY, 0.5)?.text).toBe('b');
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
        expect(next).toMatchObject({ status: 'added', quote: { id: 3 } });
    });

    it('keeps scopes independent', async () => {
        const store = await makeStore();
        await store.add('1', 'channel one quote', null, '10', 'Tank', '1', ADDED_AT);
        await store.add('2', 'channel two quote', null, '20', 'Dj', '2', ADDED_AT);
        expect(store.count('1')).toBe(1);
        expect(store.count('2')).toBe(1);
        expect(store.pick('1', 0)?.text).toBe('channel one quote');
    });

    it('persists to an owner-only file that a fresh store reloads', async () => {
        const store = await makeStore();
        await add(store, 'durable quote', 'Tank');
        await store.flush();

        const reloaded = await makeStore();
        expect(reloaded.count(SHARED_SCOPE_KEY)).toBe(1);
        expect(reloaded.get(SHARED_SCOPE_KEY, 1)).toMatchObject({
            text: 'durable quote',
            speaker: 'Tank',
        });
        expect(await add(reloaded, 'another')).toMatchObject({ quote: { id: 2 } });
    });

    it('preserves an unreadable file and starts empty', async () => {
        await writeFile(dataPath, 'not json at all', 'utf8');
        const spy = makeSpyLogger();
        const store = new QuoteStore(dataPath, spy.logger);
        await store.load();

        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        const preserved = (await readdir(dir)).filter((name) =>
            name.startsWith('quotes.json.corrupt-'),
        );
        expect(preserved).toHaveLength(1);
        expect(await readFile(join(dir, preserved[0]!), 'utf8')).toBe('not json at all');
        expect(spy.error).toHaveBeenCalled();
    });

    function storedQuote(overrides: Record<string, unknown> = {}) {
        return {
            id: 1,
            text: 'a stored quote',
            speaker: null,
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
            scopes: { shared: { nextId: 2, quotes: [], ...scope } },
        });
    }

    const invalidFiles: ReadonlyArray<[string, string]> = [
        ['a quote missing fields', storedFile({ quotes: [{ id: 1 }] })],
        [
            'text past the length cap',
            storedFile({ quotes: [storedQuote({ text: 'x'.repeat(301) })] }),
        ],
        ['empty text', storedFile({ quotes: [storedQuote({ text: '' })] })],
        [
            'a speaker past the length cap',
            storedFile({ quotes: [storedQuote({ speaker: 'x'.repeat(51) })] }),
        ],
        ['an empty-string speaker', storedFile({ quotes: [storedQuote({ speaker: '' })] })],
        ['a non-integer id', storedFile({ quotes: [storedQuote({ id: 1.5 })] })],
        [
            'a timestamp that is not ISO 8601',
            storedFile({ quotes: [storedQuote({ addedAt: 'now' })] }),
        ],
        [
            'duplicate ids',
            storedFile({ nextId: 3, quotes: [storedQuote(), storedQuote({ text: 'other' })] }),
        ],
        ['an id at or past nextId', storedFile({ nextId: 1, quotes: [storedQuote()] })],
        ['a wrong version', JSON.stringify({ version: 2, scopes: {} })],
    ];

    it.each(invalidFiles)('rejects a file with %s', async (_label, contents) => {
        await writeFile(dataPath, contents, 'utf8');
        const store = new QuoteStore(dataPath, testLogger);
        await store.load();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
    });

    it('never resolves a scope key to an inherited object member', async () => {
        const store = await makeStore();
        await add(store, 'a quote');
        await store.flush();

        const reloaded = await makeStore();
        for (const key of ['constructor', 'toString', '__proto__']) {
            expect(reloaded.count(key)).toBe(0);
            expect(reloaded.pick(key, 0)).toBeUndefined();
            expect(reloaded.get(key, 1)).toBeUndefined();
        }
    });
});
