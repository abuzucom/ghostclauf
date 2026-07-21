import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import streak, { createStreakPlugin } from '../src/plugins/streak/index.js';
import type { StreamOnlineEvent } from '../src/core/types.js';
import { flush, makeHarness, makeMessage } from './helpers.js';

function onlineNow(broadcasterId = '1', startedAt: Date = new Date()): StreamOnlineEvent {
  return {
    broadcasterId,
    broadcasterName: 'streamer',
    broadcasterDisplayName: 'Streamer',
    startedAt,
  };
}

describe('streak plugin', () => {
  let dir: string;
  let dataPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghostclauf-streak-plugin-'));
    dataPath = join(dir, 'streaks.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function harness(extra: Record<string, unknown> = {}) {
    return makeHarness('streak', { dataPath, timezone: 'UTC', ...extra });
  }

  it('registers the five streak commands', async () => {
    const { ctx, registry } = harness();
    await streak.init(ctx);
    expect(registry.size).toBe(5);
  });

  it('starts a streak on check-in after the stream is marked live', async () => {
    const { ctx, bus, say, registry } = harness();
    await streak.init(ctx);
    bus.emit('streamOnline', onlineNow('1'));
    await flush();

    await registry.handle(makeMessage('!checkin', ['everyone']));
    expect(say).toHaveBeenCalledTimes(1);
    const [text, replyTo, broadcasterId] = say.mock.calls[0];
    expect(text).toContain('Streak started');
    expect(replyTo).toBe('msg-1');
    expect(broadcasterId).toBe('1');
  });

  it('refuses check-in before the stream is live when requireStreamDay', async () => {
    const { ctx, say, registry } = harness();
    await streak.init(ctx);
    await registry.handle(makeMessage('!checkin', ['everyone']));
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0]).toContain('not open');
  });

  it('counts check-in without stream events when requireStreamDay is false', async () => {
    const { ctx, say, registry } = harness({ requireStreamDay: false });
    await streak.init(ctx);
    await registry.handle(makeMessage('!checkin', ['everyone']));
    expect(say.mock.calls[0][0]).toContain('Streak started');
  });

  it('looks up own streak and reports none when absent', async () => {
    const { ctx, bus, say, registry } = harness();
    await streak.init(ctx);

    await registry.handle(makeMessage('!streak', ['everyone']));
    expect(say.mock.calls[0][0]).toContain('no streak yet');

    bus.emit('streamOnline', onlineNow('1'));
    await flush();
    await registry.handle(makeMessage('!checkin', ['everyone']));
    await registry.handle(makeMessage('!streak', ['everyone']));
    expect(say.mock.calls[say.mock.calls.length - 1][0]).toContain('your streak is 1');
  });

  it('lets only the broadcaster reset a streak, not moderators or plain viewers', async () => {
    const { ctx, bus, say, registry } = harness();
    await streak.init(ctx);
    bus.emit('streamOnline', onlineNow('1'));
    await flush();
    await registry.handle(makeMessage('!checkin', ['everyone']));
    say.mockClear();

    // Plain viewer cannot reset - the permission gate blocks the handler.
    await registry.handle(makeMessage('!streakreset @viewer', ['everyone']));
    expect(say).not.toHaveBeenCalled();

    // Moderators cannot reset either - broadcaster only.
    await registry.handle(makeMessage('!streakreset @viewer', ['everyone', 'moderator']));
    expect(say).not.toHaveBeenCalled();

    // Broadcaster can.
    await registry.handle(makeMessage('!streakreset @viewer', ['everyone', 'broadcaster']));
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0]).toContain('Reset');

    // Confirm the reset took effect.
    say.mockClear();
    await registry.handle(makeMessage('!streak', ['everyone']));
    expect(say.mock.calls[0][0]).toContain('your streak is 0');
  });

  it('counts a post-midnight check-in toward the overnight stream that started it', async () => {
    const startedAt = new Date('2026-07-20T23:00:00.000Z'); // 11PM
    const checkinNow = new Date('2026-07-21T01:00:00.000Z'); // 1AM, 2 hours later
    const plugin = createStreakPlugin(() => checkinNow);
    const { ctx, bus, say, registry } = harness();
    await plugin.init(ctx);
    bus.emit('streamOnline', onlineNow('1', startedAt));
    await flush();

    await registry.handle(makeMessage('!checkin', ['everyone']));
    expect(say.mock.calls[0][0]).toContain('Streak started');

    const raw = await readFile(dataPath, 'utf8');
    const persisted = JSON.parse(raw);
    const channel = Object.values(persisted.channels)[0] as {
      streamDays: string[];
      viewers: Record<string, { lastCheckinDay: string }>;
    };
    expect(channel.streamDays).toEqual(['2026-07-20']);
    const [viewer] = Object.values(channel.viewers);
    expect(viewer.lastCheckinDay).toBe('2026-07-20');
  });

  it('falls back to plain wall-clock gating once the session window has elapsed', async () => {
    const startedAt = new Date('2026-07-18T23:00:00.000Z');
    const checkinNow = new Date('2026-07-20T01:00:00.000Z'); // ~26 hours later
    const plugin = createStreakPlugin(() => checkinNow);
    const { ctx, bus, say, registry } = harness();
    await plugin.init(ctx);
    bus.emit('streamOnline', onlineNow('1', startedAt));
    await flush();

    await registry.handle(makeMessage('!checkin', ['everyone']));
    expect(say.mock.calls[0][0]).toContain('not open');
  });

  it('shares a streak across channels by default', async () => {
    const now = new Date('2026-07-20T20:00:00.000Z');
    const plugin = createStreakPlugin(() => now);
    const { ctx, bus, say, registry } = harness();
    await plugin.init(ctx);
    bus.emit('streamOnline', onlineNow('1', now));
    await flush();

    await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
    expect(say.mock.calls[0][0]).toContain('Streak started');

    say.mockClear();
    // Channel '2' never went live, but the shared pool is already open via channel '1'.
    await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
    expect(say.mock.calls[0][0]).toContain('already checked in');

    say.mockClear();
    await registry.handle(makeMessage('!streak', ['everyone'], { broadcasterId: '2' }));
    expect(say.mock.calls[0][0]).toContain('your streak is 1');
  });

  it('reflects admin reset/set across channels when shared', async () => {
    const now = new Date('2026-07-20T20:00:00.000Z');
    const plugin = createStreakPlugin(() => now);
    const { ctx, bus, say, registry } = harness();
    await plugin.init(ctx);
    bus.emit('streamOnline', onlineNow('1', now));
    await flush();
    await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
    say.mockClear();

    await registry.handle(
      makeMessage('!streakset @viewer 9', ['everyone', 'broadcaster'], { broadcasterId: '1' }),
    );
    expect(say.mock.calls[0][0]).toContain('Set');

    say.mockClear();
    await registry.handle(makeMessage('!streak', ['everyone'], { broadcasterId: '2' }));
    expect(say.mock.calls[0][0]).toContain('your streak is 9');
  });

  it('keeps channels independent when shareAcrossChannels is false', async () => {
    const now = new Date('2026-07-20T20:00:00.000Z');
    const plugin = createStreakPlugin(() => now);
    const { ctx, bus, say, registry } = harness({ shareAcrossChannels: false });
    await plugin.init(ctx);
    bus.emit('streamOnline', onlineNow('1', now));
    await flush();

    await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
    expect(say.mock.calls[0][0]).toContain('Streak started');

    say.mockClear();
    // Channel '2' is its own independent scope and was never marked live.
    await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
    expect(say.mock.calls[0][0]).toContain('not open');
  });
});
