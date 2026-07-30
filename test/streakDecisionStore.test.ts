import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreakDecisionStore } from '../src/plugins/streak/decisionStore.js';
import { makeSpyLogger } from './helpers.js';

describe('StreakDecisionStore', () => {
    let dir: string;
    let path: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-streak-decisions-'));
        path = join(dir, 'decisions.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('records manual adjustments and reverses them latest-first', async () => {
        const store = new StreakDecisionStore(path, makeSpyLogger().logger);
        await store.load();
        await store.recordSet('shared', 'viewer-1', 'viewer', 999, 5, 999, 'owner', 'tank');
        await store.recordSet('shared', 'viewer-1', 'viewer', 5, 10, 999, 'owner', 'dj');

        expect(await store.reverseLatest('shared', 'viewer-1', 'owner', 'tank')).toEqual({
            adjustment: 5,
            previousLongest: 999,
        });
        expect(await store.reverseLatest('shared', 'viewer-1', 'owner', 'tank')).toEqual({
            adjustment: -994,
            previousLongest: 999,
        });
        expect(await store.reverseLatest('shared', 'viewer-1', 'owner', 'tank')).toBeNull();
    });

    it('keeps one previous journal snapshot', async () => {
        const store = new StreakDecisionStore(path, makeSpyLogger().logger);
        await store.load();
        await store.recordSet('shared', 'viewer-1', 'viewer', 1, 5, 5, 'owner', 'tank');
        await store.recordSet('shared', 'viewer-1', 'viewer', 5, 8, 8, 'owner', 'tank');

        const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8'));
        expect(backup.decisions).toHaveLength(2);
        expect(backup.decisions[1].status).toBe('pending');
    });

    it('commits a pending set when the primary database has its transaction marker', async () => {
        const store = new StreakDecisionStore(path, makeSpyLogger().logger);
        await store.load();
        const decision = await store.prepareSet(
            'shared',
            'viewer-1',
            'viewer',
            999,
            5,
            999,
            'owner',
            'tank',
        );
        expect(store.latest('shared', 'viewer-1')).toBeNull();

        await store.reconcile((_scope, _chatterId) => decision.id);
        expect(store.latest('shared', 'viewer-1')?.id).toBe(decision.id);
    });

    it('aborts a pending set absent from the primary database', async () => {
        const store = new StreakDecisionStore(path, makeSpyLogger().logger);
        await store.load();
        await store.prepareSet('shared', 'viewer-1', 'viewer', 999, 5, 999, 'owner', 'tank');

        await store.reconcile(() => null);
        expect(store.latest('shared', 'viewer-1')).toBeNull();
    });

    it('commits or cancels a pending undo from the primary transaction marker', async () => {
        const committed = new StreakDecisionStore(path, makeSpyLogger().logger);
        await committed.load();
        await committed.recordSet('shared', 'viewer-1', 'viewer', 999, 5, 999, 'owner', 'tank');
        const reversal = await committed.prepareReverse('shared', 'viewer-1', 'owner', 'tank');
        expect(reversal).not.toBeNull();
        await committed.reconcile(() => reversal!.transactionId);
        expect(committed.latest('shared', 'viewer-1')).toBeNull();

        const secondPath = join(dir, 'cancelled-decisions.json');
        const cancelled = new StreakDecisionStore(secondPath, makeSpyLogger().logger);
        await cancelled.load();
        await cancelled.recordSet('shared', 'viewer-1', 'viewer', 999, 5, 999, 'owner', 'tank');
        await cancelled.prepareReverse('shared', 'viewer-1', 'owner', 'tank');
        await cancelled.reconcile(() => null);
        expect(cancelled.latest('shared', 'viewer-1')).not.toBeNull();
    });
});
