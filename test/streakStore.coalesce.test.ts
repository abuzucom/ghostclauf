// Verifies persist coalescing: a burst of concurrent mutations must not queue
// one full-file write per mutation. node:fs/promises is partially mocked so
// writeFile calls can be counted while still hitting the real temp dir.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreakStore } from '../src/plugins/streak/store.js';
import { makeSpyLogger } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const writeFileMock = vi.mocked(writeFile);
const BID = 'chan-1';
const DAY = '2026-07-20';
const STARTED_AT = new Date('2026-07-20T20:00:00.000Z');
const BURST_SIZE = 25;

describe('StreakStore persist coalescing', () => {
  let dir: string;
  let dataPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghostclauf-streak-coalesce-'));
    dataPath = join(dir, 'streaks.json');
    writeFileMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('coalesces a burst of concurrent check-ins into at most two writes', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    await store.recordStreamDay(BID, DAY, STARTED_AT);
    writeFileMock.mockClear();

    await Promise.all(
      Array.from({ length: BURST_SIZE }, (_, i) =>
        store.checkIn(BID, `viewer-${i}`, `viewer${i}`, `Viewer${i}`, DAY),
      ),
    );

    // One in-flight write plus one queued write covering the rest.
    expect(writeFileMock.mock.calls.length).toBeLessThanOrEqual(2);

    const parsed = JSON.parse(await readFile(dataPath, 'utf8'));
    expect(Object.keys(parsed.channels[BID].viewers)).toHaveLength(BURST_SIZE);
  });

  it('resolves an awaited persist only after that mutation is on disk', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await store.load();
    await store.recordStreamDay(BID, DAY, STARTED_AT);
    await store.checkIn(BID, 'viewer-1', 'viewer', 'Viewer', DAY);

    await store.setViewerStreak(BID, 'viewer-1', 7);
    const parsed = JSON.parse(await readFile(dataPath, 'utf8'));
    expect(parsed.channels[BID].viewers['viewer-1'].currentStreak).toBe(7);
  });
});
