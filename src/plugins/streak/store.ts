// Persistent streak state. Mirrors the token-store pattern in core/auth.ts
// (mkdir recursive + pretty JSON) but adds an atomic, serialized write so
// concurrent check-ins from multiple viewers cannot lose updates.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../../core/types.js';
import { applyCheckin, newViewerRecord, previousStreamDay } from './streak.js';
import type {
  ChannelRecord,
  CheckinOutcome,
  StreakData,
  ViewerRecord,
} from './types.js';

function emptyData(): StreakData {
  return { version: 1, channels: {} };
}

/** Minimal shape guard for a loaded data file. */
function isStreakData(value: unknown): value is StreakData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<StreakData>;
  return candidate.version === 1 && typeof candidate.channels === 'object' && candidate.channels !== null;
}

export class StreakStore {
  private data: StreakData = emptyData();
  /** Serializes disk writes so concurrent persists never interleave. */
  private saveChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataPath: string,
    private readonly logger: Logger,
  ) {}

  /** Load state from disk. Missing file starts empty; corrupt file is backed up. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.dataPath, 'utf8');
    } catch {
      this.data = emptyData();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isStreakData(parsed)) throw new Error('unexpected streak data shape');
      this.data = parsed;
    } catch (err) {
      await this.backupCorruptFile(err);
      this.data = emptyData();
    }
  }

  private async backupCorruptFile(err: unknown): Promise<void> {
    const backupPath = `${this.dataPath}.corrupt-${Date.now()}`;
    try {
      await rename(this.dataPath, backupPath);
      this.logger.error(
        { err, backupPath },
        'streak data file was unreadable; backed it up and starting empty',
      );
    } catch (renameErr) {
      this.logger.error({ err: renameErr }, 'failed to back up corrupt streak data file');
    }
  }

  private channel(broadcasterId: string): ChannelRecord {
    const existing = this.data.channels[broadcasterId];
    if (existing) return existing;
    const created: ChannelRecord = { streamDays: [], viewers: {} };
    this.data.channels[broadcasterId] = created;
    return created;
  }

  /** Recorded stream-day keys for a channel (ascending copy). */
  streamDays(broadcasterId: string): string[] {
    return [...(this.data.channels[broadcasterId]?.streamDays ?? [])];
  }

  hasStreamDay(broadcasterId: string, day: string): boolean {
    return this.data.channels[broadcasterId]?.streamDays.includes(day) ?? false;
  }

  /** Mark `day` a stream day. Returns true if newly added. Persists. */
  async recordStreamDay(broadcasterId: string, day: string): Promise<boolean> {
    const channel = this.channel(broadcasterId);
    if (channel.streamDays.includes(day)) return false;
    channel.streamDays.push(day);
    channel.streamDays.sort();
    await this.persist();
    return true;
  }

  getViewer(broadcasterId: string, chatterId: string): ViewerRecord | undefined {
    return this.data.channels[broadcasterId]?.viewers[chatterId];
  }

  /** Find a viewer by login (lowercased), for admin commands targeting @user. */
  findViewerByName(
    broadcasterId: string,
    login: string,
  ): { chatterId: string; viewer: ViewerRecord } | undefined {
    const wanted = login.toLowerCase();
    const viewers = this.data.channels[broadcasterId]?.viewers ?? {};
    for (const [chatterId, viewer] of Object.entries(viewers)) {
      if (viewer.chatterName === wanted) return { chatterId, viewer };
    }
    return undefined;
  }

  /** Apply a check-in on stream day `today` and persist the result. */
  async checkIn(
    broadcasterId: string,
    chatterId: string,
    chatterName: string,
    displayName: string,
    today: string,
  ): Promise<{ outcome: CheckinOutcome; viewer: ViewerRecord }> {
    const channel = this.channel(broadcasterId);
    const current = channel.viewers[chatterId] ?? newViewerRecord(chatterName.toLowerCase(), displayName);
    const previous = previousStreamDay(channel.streamDays, today);
    const { viewer, outcome } = applyCheckin(current, today, previous);
    const updated: ViewerRecord = { ...viewer, chatterName: chatterName.toLowerCase(), displayName };
    channel.viewers[chatterId] = updated;
    await this.persist();
    return { outcome, viewer: updated };
  }

  /** Reset a viewer's current streak to 0, preserving their longest. Persists. */
  async resetViewer(broadcasterId: string, chatterId: string): Promise<void> {
    const viewer = this.data.channels[broadcasterId]?.viewers[chatterId];
    if (!viewer) return;
    viewer.currentStreak = 0;
    viewer.lastCheckinDay = null;
    await this.persist();
  }

  /** Manually set a viewer's current streak, bumping longest if needed. Persists. */
  async setViewerStreak(broadcasterId: string, chatterId: string, value: number): Promise<void> {
    const viewer = this.data.channels[broadcasterId]?.viewers[chatterId];
    if (!viewer) return;
    viewer.currentStreak = value;
    viewer.longestStreak = Math.max(viewer.longestStreak, value);
    await this.persist();
  }

  /** Snapshot current state and queue an atomic write behind any in-flight one. */
  private persist(): Promise<void> {
    const json = JSON.stringify(this.data, null, 2);
    const write = this.saveChain.then(() => this.writeAtomic(json));
    // Keep the chain alive even if a write fails; surface the error to this caller.
    this.saveChain = write.catch(() => {});
    return write;
  }

  private async writeAtomic(json: string): Promise<void> {
    await mkdir(dirname(this.dataPath), { recursive: true });
    const tempPath = `${this.dataPath}.tmp`;
    await writeFile(tempPath, json, 'utf8');
    await rename(tempPath, this.dataPath);
  }
}
