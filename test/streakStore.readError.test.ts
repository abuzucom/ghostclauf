// Verifies that a read failure other than "file does not exist" is never
// treated as an empty database - it must be logged and rethrown, so a
// permission or I/O error can't lead to real data being overwritten by a
// later check-in. node:fs/promises is mocked so readFile can be forced to
// reject with an arbitrary error code.

import { mkdtemp, rm, writeFile as realWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreakStore } from '../src/plugins/streak/store.js';
import { makeSpyLogger } from './helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const { readFile } = await import('node:fs/promises');
const readFileMock = vi.mocked(readFile);

describe('StreakStore.load read-error handling', () => {
  let dir: string;
  let dataPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghostclauf-streak-readerr-'));
    dataPath = join(dir, 'streaks.json');
    readFileMock.mockClear();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rethrows a non-ENOENT read error instead of starting empty', async () => {
    const eaccess = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    readFileMock.mockRejectedValueOnce(eaccess);
    const spy = makeSpyLogger();

    const store = new StreakStore(dataPath, spy.logger);
    await expect(store.load()).rejects.toBe(eaccess);
    expect(spy.error).toHaveBeenCalled();
    expect(store.getViewer('chan-1', 'viewer-1')).toBeUndefined();
  });

  it('still starts empty for a genuinely missing file (ENOENT)', async () => {
    const store = new StreakStore(dataPath, makeSpyLogger().logger);
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.hasStreamDay('chan-1', '2026-07-20')).toBe(false);
  });

  it('never overwrites the real file after a read error is fixed and retried', async () => {
    // Simulate real data already on disk from a previous run.
    await realWriteFile(
      dataPath,
      JSON.stringify({
        version: 1,
        channels: {
          'chan-1': {
            streamDays: ['2026-07-19'],
            activeStreamStartedAt: null,
            viewers: {
              'viewer-1': {
                chatterName: 'viewer',
                displayName: 'Viewer',
                currentStreak: 5,
                longestStreak: 5,
                lastCheckinDay: '2026-07-19',
                totalCheckins: 5,
              },
            },
          },
        },
      }),
      'utf8',
    );

    const eio = Object.assign(new Error('input/output error'), { code: 'EIO' });
    readFileMock.mockRejectedValueOnce(eio);
    const first = new StreakStore(dataPath, makeSpyLogger().logger);
    await expect(first.load()).rejects.toBe(eio);

    // A fresh load (as pluginManager would retry on the next boot, once the
    // transient error clears) sees the untouched real data.
    const second = new StreakStore(dataPath, makeSpyLogger().logger);
    await second.load();
    expect(second.getViewer('chan-1', 'viewer-1')?.currentStreak).toBe(5);
  });
});
