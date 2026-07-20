import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StreakStore } from '../src/plugins/streak/store.js';
import { makeSpyLogger } from './helpers.js';

const BID = 'chan-1';
const CID = 'viewer-1';

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
    await first.recordStreamDay(BID, '2026-07-20');
    await first.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-20');

    const second = new StreakStore(dataPath, makeSpyLogger().logger);
    await second.load();
    expect(second.hasStreamDay(BID, '2026-07-20')).toBe(true);
    const viewer = second.getViewer(BID, CID);
    expect(viewer?.currentStreak).toBe(1);
    expect(viewer?.totalCheckins).toBe(1);
  });

  it('writes valid pretty-printed JSON with version 1', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    await store.recordStreamDay(BID, '2026-07-20');
    const raw = await readFile(dataPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(raw).toBe(JSON.stringify(parsed, null, 2));
  });

  it('dedupes and orders stream days, reporting whether newly added', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    expect(await store.recordStreamDay(BID, '2026-07-20')).toBe(true);
    expect(await store.recordStreamDay(BID, '2026-07-18')).toBe(true);
    expect(await store.recordStreamDay(BID, '2026-07-20')).toBe(false);
    expect(store.streamDays(BID)).toEqual(['2026-07-18', '2026-07-20']);
  });

  it('extends a streak across consecutive recorded stream days', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    await store.recordStreamDay(BID, '2026-07-18');
    const first = await store.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-18');
    expect(first.outcome).toBe('started');
    await store.recordStreamDay(BID, '2026-07-20');
    const second = await store.checkIn(BID, CID, 'viewer', 'Viewer', '2026-07-20');
    expect(second.outcome).toBe('extended');
    expect(second.viewer.currentStreak).toBe(2);
  });

  it('finds a viewer by login and supports admin reset/set', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    await store.recordStreamDay(BID, '2026-07-20');
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
    const backups = files.filter((f) => f.startsWith(basename(dataPath)) && f.includes('corrupt'));
    expect(backups.length).toBe(1);
  });
});
