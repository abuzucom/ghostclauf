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

  private channel(channelKey: string): ChannelRecord {
    const existing = this.data.channels[channelKey];
    if (existing) return existing;
    const created: ChannelRecord = { streamDays: [], activeStreamStartedAt: null, viewers: {} };
    this.data.channels[channelKey] = created;
    return created;
  }

  /** Recorded stream-day keys for a channel (ascending copy). */
  streamDays(channelKey: string): string[] {
    return [...(this.data.channels[channelKey]?.streamDays ?? [])];
  }

  hasStreamDay(channelKey: string, day: string): boolean {
    return this.data.channels[channelKey]?.streamDays.includes(day) ?? false;
  }

  /**
   * Mark `day` a stream day and record `startedAt` as the active session
   * anchor if it's more recent than whatever's already stored (ISO instants
   * compare chronologically as strings). Returns true iff `day` was newly
   * added. Persists whenever either the day or the anchor changes.
   */
  async recordStreamDay(channelKey: string, day: string, startedAt: Date): Promise<boolean> {
    const channel = this.channel(channelKey);
    const isNewDay = !channel.streamDays.includes(day);
    if (isNewDay) {
      channel.streamDays.push(day);
      channel.streamDays.sort();
    }
    const startedAtIso = startedAt.toISOString();
    const previousAnchor = channel.activeStreamStartedAt;
    const anchorChanged = previousAnchor === null || startedAtIso > previousAnchor;
    if (anchorChanged) {
      channel.activeStreamStartedAt = startedAtIso;
    }
    if (isNewDay || anchorChanged) {
      await this.persist();
    }
    return isNewDay;
  }

  /** The most recent recorded stream start for a channel, or null if none. */
  activeStreamStartedAt(channelKey: string): Date | null {
    const iso = this.data.channels[channelKey]?.activeStreamStartedAt;
    return iso ? new Date(iso) : null;
  }

  getViewer(channelKey: string, chatterId: string): ViewerRecord | undefined {
    return this.data.channels[channelKey]?.viewers[chatterId];
  }

  /** Find a viewer by login (lowercased), for admin commands targeting @user. */
  findViewerByName(
    channelKey: string,
    login: string,
  ): { chatterId: string; viewer: ViewerRecord } | undefined {
    const wanted = login.toLowerCase();
    const viewers = this.data.channels[channelKey]?.viewers ?? {};
    for (const [chatterId, viewer] of Object.entries(viewers)) {
      if (viewer.chatterName === wanted) return { chatterId, viewer };
    }
    return undefined;
  }

  /** Apply a check-in on stream day `today` and persist the result. */
  async checkIn(
    channelKey: string,
    chatterId: string,
    chatterName: string,
    displayName: string,
    today: string,
  ): Promise<{ outcome: CheckinOutcome; viewer: ViewerRecord }> {
    const channel = this.channel(channelKey);
    const current = channel.viewers[chatterId] ?? newViewerRecord(chatterName.toLowerCase(), displayName);
    const previous = previousStreamDay(channel.streamDays, today);
    const { viewer, outcome } = applyCheckin(current, today, previous);
    const updated: ViewerRecord = { ...viewer, chatterName: chatterName.toLowerCase(), displayName };
    channel.viewers[chatterId] = updated;
    await this.persist();
    return { outcome, viewer: updated };
  }

  /** Reset a viewer's current streak to 0, preserving their longest. Persists. */
  async resetViewer(channelKey: string, chatterId: string): Promise<void> {
    const viewer = this.data.channels[channelKey]?.viewers[chatterId];
    if (!viewer) return;
    viewer.currentStreak = 0;
    viewer.lastCheckinDay = null;
    await this.persist();
  }

  /** Manually set a viewer's current streak, bumping longest if needed. Persists. */
  async setViewerStreak(channelKey: string, chatterId: string, value: number): Promise<void> {
    const viewer = this.data.channels[channelKey]?.viewers[chatterId];
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
