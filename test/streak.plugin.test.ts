import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import streak, { createStreakPlugin } from '../src/plugins/streak/index.js';
import type { StreamOfflineEvent, StreamOnlineEvent } from '../src/core/types.js';
import { flush, makeHarness, makeMessage } from './helpers.js';

function onlineNow(broadcasterId = '1', startedAt: Date = new Date()): StreamOnlineEvent {
    return {
        broadcasterId,
        broadcasterName: 'streamer',
        broadcasterDisplayName: 'Streamer',
        startedAt,
    };
}

function offlineNow(broadcasterId = '1'): StreamOfflineEvent {
    return {
        broadcasterId,
        broadcasterName: 'streamer',
        broadcasterDisplayName: 'Streamer',
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

    function modernHarness(extra: Record<string, unknown> = {}) {
        return harness({
            streakBreakPolicy: 'all-broadcasters',
            shareAcrossChannels: true,
            minimumQualifyingSessionMinutes: 0,
            reconnectGraceMinutes: 60,
            ...extra,
        });
    }

    it('registers the seven streak commands', async () => {
        const { ctx, registry } = harness();
        await streak.init(ctx);
        expect(registry.size).toBe(7);
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

    it('silently ignores repeat check-ins within the cooldown window', async () => {
        let current = new Date('2026-07-20T20:00:00.000Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, say, registry } = harness();
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();

        await registry.handle(makeMessage('!checkin', ['everyone']));
        expect(say).toHaveBeenCalledTimes(1);

        // Within the default 10s cooldown: no reply, no store call.
        current = new Date(current.getTime() + 5_000);
        await registry.handle(makeMessage('!checkin', ['everyone']));
        expect(say).toHaveBeenCalledTimes(1);

        // A different chatter is not throttled by the first one's cooldown.
        await registry.handle(
            makeMessage('!checkin', ['everyone'], {
                chatterId: '200',
                chatterName: 'other',
                chatterDisplayName: 'Other',
            }),
        );
        expect(say).toHaveBeenCalledTimes(2);

        // Past the cooldown the original chatter gets a reply again.
        current = new Date(current.getTime() + 11_000);
        await registry.handle(makeMessage('!checkin', ['everyone']));
        expect(say).toHaveBeenCalledTimes(3);
        expect(say.mock.calls[2][0]).toContain('already checked in');
    });

    it('disables the check-in cooldown when checkinCooldownSeconds is 0', async () => {
        const now = new Date('2026-07-20T20:00:00.000Z');
        const plugin = createStreakPlugin(() => now);
        const { ctx, bus, say, registry } = harness({ checkinCooldownSeconds: 0 });
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', now));
        await flush();

        await registry.handle(makeMessage('!checkin', ['everyone']));
        await registry.handle(makeMessage('!checkin', ['everyone']));
        expect(say).toHaveBeenCalledTimes(2);
        expect(say.mock.calls[1][0]).toContain('already checked in');
    });

    it('lets only the broadcaster set a streak, not moderators or plain viewers', async () => {
        const now = new Date('2026-07-20T20:00:00.000Z');
        const plugin = createStreakPlugin(() => now);
        const { ctx, bus, say, registry } = harness();
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', now));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone']));
        say.mockClear();

        await registry.handle(makeMessage('!streakset @viewer 5', ['everyone']));
        expect(say).not.toHaveBeenCalled();

        await registry.handle(makeMessage('!streakset @viewer 5', ['everyone', 'moderator']));
        expect(say).not.toHaveBeenCalled();

        await registry.handle(makeMessage('!streakset @viewer 5', ['everyone', 'broadcaster']));
        expect(say).toHaveBeenCalledTimes(1);
        expect(say.mock.calls[0][0]).toContain('Set');
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
        let current = new Date('2026-07-20T20:00:00.000Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, say, registry } = harness();
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();

        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        expect(say.mock.calls[0][0]).toContain('Streak started');

        say.mockClear();
        // Past the cooldown so the same chatter's second check-in is handled.
        current = new Date(current.getTime() + 11_000);
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
            makeMessage('!streakset @viewer 9', ['everyone', 'broadcaster'], {
                broadcasterId: '1',
            }),
        );
        expect(say.mock.calls[0][0]).toContain('Set');

        say.mockClear();
        await registry.handle(makeMessage('!streak', ['everyone'], { broadcasterId: '2' }));
        expect(say.mock.calls[0][0]).toContain('your streak is 9');
    });

    it('closes check-in once the stream goes offline, even though today was already opened', async () => {
        const { ctx, bus, say, registry } = harness();
        await streak.init(ctx);
        bus.emit('streamOnline', onlineNow('1'));
        await flush();

        await registry.handle(makeMessage('!checkin', ['everyone']));
        expect(say.mock.calls[0][0]).toContain('Streak started');

        bus.emit('streamOffline', offlineNow('1'));
        await flush();
        say.mockClear();

        // A different chatter tries to check in after the stream ended: today
        // was recorded as a stream day, but the channel is no longer live.
        await registry.handle(
            makeMessage('!checkin', ['everyone'], {
                chatterId: '200',
                chatterName: 'other',
                chatterDisplayName: 'Other',
            }),
        );
        expect(say.mock.calls[0][0]).toContain('not open');
    });

    it('reopens check-in for the pool while any shared channel is still live', async () => {
        const { ctx, bus, say, registry } = harness();
        await streak.init(ctx);
        bus.emit('streamOnline', onlineNow('1'));
        bus.emit('streamOnline', onlineNow('2'));
        await flush();

        bus.emit('streamOffline', offlineNow('1'));
        await flush();

        // Channel '2' is still live, so the shared pool remains open.
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
        expect(say.mock.calls[0][0]).toContain('Streak started');
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

    it('shares viewer streaks but gates check-in to the live broadcaster', async () => {
        const now = new Date('2026-07-20T20:00:00Z');
        const plugin = createStreakPlugin(() => now);
        const { ctx, bus, say, registry } = modernHarness({ checkinCooldownSeconds: 0 });
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', now));
        await flush();

        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
        expect(say.mock.calls[0][0]).toContain('not open');
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        expect(say.mock.calls[1][0]).toContain('Streak started');
        await plugin.dispose?.(ctx);
    });

    it('extends after missing one broadcaster and resets after missing both', async () => {
        let current = new Date('2026-07-20T20:00:00Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, say, registry } = modernHarness({ checkinCooldownSeconds: 0 });
        await plugin.init(ctx);

        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        bus.emit('streamOffline', { ...offlineNow('1'), observedAt: current, verified: true });
        await flush();

        current = new Date('2026-07-21T20:00:00Z');
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        bus.emit('streamOffline', { ...offlineNow('1'), observedAt: current, verified: true });
        await flush();

        current = new Date('2026-07-22T20:00:00Z');
        bus.emit('streamOnline', onlineNow('2', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
        expect(say.mock.calls.at(-1)?.[0]).toContain('Streak: 2');
        bus.emit('streamOffline', { ...offlineNow('2'), observedAt: current, verified: true });
        await flush();

        for (const [day, broadcasterId] of [
            ['2026-07-23', '1'],
            ['2026-07-24', '2'],
        ] as const) {
            current = new Date(`${day}T20:00:00Z`);
            bus.emit('streamOnline', onlineNow(broadcasterId, current));
            await flush();
            bus.emit('streamOffline', {
                ...offlineNow(broadcasterId),
                observedAt: current,
                verified: true,
            });
            await flush();
        }

        current = new Date('2026-07-25T20:00:00Z');
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        expect(say.mock.calls.at(-1)?.[0]).toContain('Streak started: 1');
        await plugin.dispose?.(ctx);
    });

    it('does not combine separate short sessions toward qualification', async () => {
        let current = new Date('2026-07-20T20:00:00Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, say, registry } = modernHarness({
            minimumQualifyingSessionMinutes: 30,
            checkinCooldownSeconds: 0,
        });
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));

        for (const broadcasterId of ['1', '2']) {
            current = new Date(`2026-07-${broadcasterId === '1' ? '21' : '22'}T20:00:00Z`);
            bus.emit('streamOnline', onlineNow(broadcasterId, current));
            await flush();
            current = new Date(current.getTime() + 29 * 60_000);
            bus.emit('streamOffline', {
                ...offlineNow(broadcasterId),
                observedAt: current,
                verified: true,
            });
            await flush();
        }

        current = new Date('2026-07-23T20:00:00Z');
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        expect(say.mock.calls.at(-1)?.[0]).toContain('Streak: 2');
        await plugin.dispose?.(ctx);
    });

    it('preserves the broadcaster logical day for a reconnect within grace', async () => {
        let current = new Date('2026-07-20T10:40:00Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, registry } = modernHarness({
            timezone: 'America/Chicago',
            dayBoundaryHour: 6,
        });
        await plugin.init(ctx);
        bus.emit('streamOnline', { ...onlineNow('1', current), streamId: 'first' });
        await flush();
        current = new Date('2026-07-20T10:55:00Z');
        bus.emit('streamOffline', { ...offlineNow('1'), observedAt: current, verified: true });
        await flush();
        current = new Date('2026-07-20T11:20:00Z');
        bus.emit('streamOnline', { ...onlineNow('1', current), streamId: 'second' });
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));

        const persisted = JSON.parse(await readFile(dataPath, 'utf8'));
        expect(persisted.channels.shared.viewers['100'].lastCheckinDay).toBe('2026-07-19');
        await plugin.dispose?.(ctx);
    });

    it('repairs automatic penalties and can undo the latest canonical set', async () => {
        let current = new Date('2026-07-20T20:00:00Z');
        const plugin = createStreakPlugin(() => current);
        const { ctx, bus, say, registry } = modernHarness({ checkinCooldownSeconds: 0 });
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        await registry.handle(
            makeMessage('!streakset @viewer 10', ['everyone', 'broadcaster'], {
                broadcasterId: '1',
            }),
        );

        for (const [day, broadcasterId] of [
            ['2026-07-21', '1'],
            ['2026-07-22', '2'],
        ] as const) {
            current = new Date(`${day}T20:00:00Z`);
            bus.emit('streamOnline', onlineNow(broadcasterId, current));
            await flush();
            bus.emit('streamOffline', {
                ...offlineNow(broadcasterId),
                observedAt: current,
                verified: true,
            });
            await flush();
        }

        current = new Date('2026-07-23T20:00:00Z');
        bus.emit('streamOnline', onlineNow('1', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '1' }));
        expect(say.mock.calls.at(-1)?.[0]).toContain('Streak started: 1');

        current = new Date('2026-07-24T20:00:00Z');
        bus.emit('streamOnline', onlineNow('2', current));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone'], { broadcasterId: '2' }));
        await registry.handle(
            makeMessage('!fixstreak @viewer', ['everyone', 'broadcaster'], {
                broadcasterId: '2',
            }),
        );
        expect(say.mock.calls.at(-1)?.[0]).toContain('Current streak: 12');

        await registry.handle(
            makeMessage('!undostreakset @viewer', ['everyone', 'broadcaster'], {
                broadcasterId: '1',
            }),
        );
        expect(say.mock.calls.at(-1)?.[0]).toContain('Current streak: 3');
        await plugin.dispose?.(ctx);
    });

    it('lets only the broadcaster repair a penalty or undo a set', async () => {
        const now = new Date('2026-07-20T20:00:00.000Z');
        const plugin = createStreakPlugin(() => now);
        const { ctx, bus, say, registry } = harness();
        await plugin.init(ctx);
        bus.emit('streamOnline', onlineNow('1', now));
        await flush();
        await registry.handle(makeMessage('!checkin', ['everyone']));
        say.mockClear();

        // Both commands mutate persisted streak values, so the gate must hold
        // for plain viewers and moderators alike.
        for (const trigger of ['!fixstreak @viewer', '!undostreakset @viewer']) {
            await registry.handle(makeMessage(trigger, ['everyone']));
            expect(say).not.toHaveBeenCalled();

            await registry.handle(makeMessage(trigger, ['everyone', 'moderator']));
            expect(say).not.toHaveBeenCalled();

            await registry.handle(makeMessage(trigger, ['everyone', 'vip']));
            expect(say).not.toHaveBeenCalled();

            await registry.handle(makeMessage(trigger, ['everyone', 'subscriber']));
            expect(say).not.toHaveBeenCalled();

            // The broadcaster reaches the handler: no penalty and no manual
            // set exist yet, so each reports "none" rather than staying silent.
            await registry.handle(makeMessage(trigger, ['everyone', 'broadcaster']));
            expect(say).toHaveBeenCalledTimes(1);
            say.mockClear();
        }

        await plugin.dispose?.(ctx);
    });
});
