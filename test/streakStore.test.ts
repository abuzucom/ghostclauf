import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreakStore } from '../src/plugins/streak/store.js';
import { makeSpyLogger } from './helpers.js';

const BID = 'chan-1';
const CID = 'viewer-1';

/** A UTC instant on the given YYYY-MM-DD day, for recordStreamDay's startedAt. */
function instantOn(day: string, hour = 20): Date {
    return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

describe('StreakStore', () => {
    let dir: string;
    let dataPath: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-streak-'));
        dataPath = join(dir, 'nested', 'streaks.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('persists and reloads state across store instances', async () => {
        const first = new StreakStore(dataPath, makeSpyLogger().logger);
        await first.load();
        await first.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        await first.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-20');

        const second = new StreakStore(dataPath, makeSpyLogger().logger);
        await second.load();
        expect(second.hasStreamDay(BID, '2026-07-20')).toBe(true);
        const viewer = second.getViewer(BID, CID);
        expect(viewer?.currentStreak).toBe(1);
        expect(viewer?.totalCheckins).toBe(1);
    });

    it('writes valid pretty-printed JSON with version 2', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        const raw = await readFile(dataPath, 'utf8');
        const parsed = JSON.parse(raw);
        expect(parsed.version).toBe(2);
        expect(raw).toBe(JSON.stringify(parsed, null, 2));
    });

    it('records qualified days by broadcaster and finds misses in an interval', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.recordQualifiedDay('shared', 'tank', '2026-07-21');
        await store.recordQualifiedDay('shared', 'tank', '2026-07-22');
        await store.recordQualifiedDay('shared', 'dj', '2026-07-23');

        expect(
            store.missedBroadcasters('shared', '2026-07-20', '2026-07-24', new Set(['tank', 'dj'])),
        ).toEqual(new Set(['tank', 'dj']));
        expect(
            store.missedBroadcasters('shared', '2026-07-22', '2026-07-24', new Set(['tank', 'dj'])),
        ).toEqual(new Set(['dj']));
    });

    it('records and repairs the latest automatic penalty without losing later check-ins', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.checkInBroadcaster(
            'shared',
            CID,
            'viewer',
            'Viewer',
            '2026-07-20',
            new Set(['tank', 'dj']),
            'tank',
            instantOn('2026-07-20'),
        );
        await store.setViewerStreak('shared', CID, 10);
        await store.recordQualifiedDay('shared', 'tank', '2026-07-21');
        await store.recordQualifiedDay('shared', 'dj', '2026-07-22');
        const penalized = await store.checkInBroadcaster(
            'shared',
            CID,
            'viewer',
            'Viewer',
            '2026-07-23',
            new Set(['tank', 'dj']),
            'dj',
            instantOn('2026-07-23'),
        );
        expect(penalized.viewer.currentStreak).toBe(1);
        await store.checkInBroadcaster(
            'shared',
            CID,
            'viewer',
            'Viewer',
            '2026-07-24',
            new Set(['tank', 'dj']),
            'tank',
            instantOn('2026-07-24'),
        );

        const fixed = await store.fixLatestPenalty(
            'shared',
            CID,
            'owner',
            'tank',
            instantOn('2026-07-25'),
        );
        expect(fixed).toEqual({ amount: 10, currentStreak: 12 });
        expect(await store.fixLatestPenalty('shared', CID, 'owner', 'tank')).toBeNull();
    });

    it('keeps the previous committed database as a backup', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        await store.recordStreamDay(BID, '2026-07-21', instantOn('2026-07-21'));

        const backup = JSON.parse(await readFile(`${dataPath}.bak`, 'utf8'));
        expect(backup.channels[BID].streamDays).toEqual(['2026-07-20']);
    });

    it('loads the previous backup when the primary database is missing', async () => {
        const first = new StreakStore(dataPath, makeSpyLogger().logger);
        await first.load();
        await first.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        await first.recordStreamDay(BID, '2026-07-21', instantOn('2026-07-21'));
        await rename(dataPath, `${dataPath}.missing-for-test`);

        const recovered = new StreakStore(dataPath, makeSpyLogger().logger);
        await recovered.load();
        expect(recovered.streamDays(BID)).toEqual(['2026-07-20']);
    });

    it('dedupes and orders stream days, reporting whether newly added', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        expect(await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'))).toBe(true);
        expect(await store.recordStreamDay(BID, '2026-07-18', instantOn('2026-07-18'))).toBe(true);
        expect(await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'))).toBe(false);
        expect(store.streamDays(BID)).toEqual(['2026-07-18', '2026-07-20']);
    });

    it('extends a streak across consecutive recorded stream days', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.recordStreamDay(BID, '2026-07-18', instantOn('2026-07-18'));
        const first = await store.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-18');
        expect(first.outcome).toBe('started');
        await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        const second = await store.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-20');
        expect(second.outcome).toBe('extended');
        expect(second.viewer.currentStreak).toBe(2);
    });

    it('finds a viewer by login and supports admin reset/set', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        await store.recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'));
        await store.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-20');

        const found = store.findViewerByName(BID, 'viewer');
        expect(found?.chatterId).toBe(CID);

        await store.setViewerStreak(BID, CID, 5);
        expect(store.getViewer(BID, CID)?.currentStreak).toBe(5);
        expect(store.getViewer(BID, CID)?.longestStreak).toBe(5);

        await store.resetViewer(BID, CID);
        expect(store.getViewer(BID, CID)?.currentStreak).toBe(0);
        expect(store.getViewer(BID, CID)?.longestStreak).toBe(5); // history preserved
    });

    it('returns null activeStreamStartedAt for an unrecorded channel', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        expect(store.activeStreamStartedAt(BID)).toBeNull();
    });

    it('persists activeStreamStartedAt and round-trips it across store reloads', async () => {
        const startedAt = instantOn('2026-07-20', 23);
        const first = new StreakStore(dataPath, makeSpyLogger().logger);
        await first.load();
        await first.recordStreamDay(BID, '2026-07-20', startedAt);

        const second = new StreakStore(dataPath, makeSpyLogger().logger);
        await second.load();
        expect(second.activeStreamStartedAt(BID)).toEqual(startedAt);
    });

    it('overwrites the anchor with a more recent start but not with an older one', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();
        const earlier = instantOn('2026-07-20', 20);
        const later = instantOn('2026-07-20', 23);

        await store.recordStreamDay(BID, '2026-07-20', earlier);
        expect(store.activeStreamStartedAt(BID)).toEqual(earlier);

        await store.recordStreamDay(BID, '2026-07-20', later);
        expect(store.activeStreamStartedAt(BID)).toEqual(later);

        // An older start for a new day shouldn't roll the anchor backwards.
        await store.recordStreamDay(BID, '2026-07-21', earlier);
        expect(store.activeStreamStartedAt(BID)).toEqual(later);
    });

    it('starts empty and backs up a corrupt data file instead of destroying it', async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(dataPath), { recursive: true });
        await writeFile(dataPath, '{ not valid json', 'utf8');
        const spy = makeSpyLogger();

        const store = new StreakStore(dataPath, spy.logger);
        await store.load();

        expect(store.getViewer(BID, CID)).toBeUndefined();
        expect(spy.error).toHaveBeenCalled();
        const files = await readdir(dirname(dataPath));
        const backups = files.filter(
            (f) => f.startsWith(basename(dataPath)) && f.includes('corrupt'),
        );
        expect(backups.length).toBe(1);
    });

    it('starts empty and backs up valid JSON with a malformed nested viewer record', async () => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(dirname(dataPath), { recursive: true });
        const malformed = {
            version: 1,
            channels: {
                [BID]: {
                    streamDays: ['2026-07-20'],
                    activeStreamStartedAt: null,
                    // currentStreak should be a number - this file was hand-edited or
                    // corrupted in a way that survives JSON.parse but not the shape
                    // guard.
                    viewers: {
                        [CID]: {
                            chatterName: 'viewer',
                            displayName: 'Viewer',
                            currentStreak: 'oops',
                        },
                    },
                },
            },
        };
        await writeFile(dataPath, JSON.stringify(malformed), 'utf8');
        const spy = makeSpyLogger();

        const store = new StreakStore(dataPath, spy.logger);
        await store.load();

        expect(store.getViewer(BID, CID)).toBeUndefined();
        expect(spy.error).toHaveBeenCalled();
        const files = await readdir(dirname(dataPath));
        const backups = files.filter(
            (f) => f.startsWith(basename(dataPath)) && f.includes('corrupt'),
        );
        expect(backups.length).toBe(1);
    });

    it('flush awaits an in-flight write', async () => {
        const store = new StreakStore(dataPath, makeSpyLogger().logger);
        await store.load();

        let writeFinished = false;
        // Don't await it yet so it remains in-flight
        const writePromise = store
            .recordStreamDay(BID, '2026-07-20', instantOn('2026-07-20'))
            .then(() => {
                writeFinished = true;
            });

        expect(writeFinished).toBe(false);
        await store.flush();
        expect(writeFinished).toBe(true);
        await writePromise; // Ensure we clean up the promise
    });
});
