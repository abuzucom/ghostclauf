import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicJsonFile } from '../src/core/atomicFile.js';
import { createLoyaltyPlugin } from '../src/plugins/loyalty/index.js';
import { LoyaltyStore, SHARED_SCOPE_KEY } from '../src/plugins/loyalty/store.js';
import type { PluginConfig } from '../src/core/types.js';
import { makeHarness, makeMessage, testLogger } from './helpers.js';

const START = new Date('2026-08-02T18:00:00.000Z');
const FIVE_MINUTES_MS = 5 * 60 * 1000;

describe('loyalty plugin', () => {
    let dir: string;
    let dataPath: string;
    let clock: Date;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-loyalty-'));
        dataPath = join(dir, 'loyalty.json');
        clock = new Date(START);
    });

    afterEach(async () => {
        vi.useRealTimers();
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(config: PluginConfig = {}) {
        const plugin = createLoyaltyPlugin(() => clock);
        const harness = makeHarness('loyalty', { dataPath, ...config });
        await plugin.init(harness.ctx);
        return { plugin, ...harness };
    }

    function chatFrom(chatterId: string, displayName: string, broadcasterId = '1') {
        return makeMessage('hello', ['everyone'], {
            chatterId,
            chatterDisplayName: displayName,
            broadcasterId,
            broadcasterName: broadcasterId === '1' ? 'streamer' : 'streamer2',
        });
    }

    function viewerMessage(text: string, chatterId = '100') {
        return makeMessage(text, ['everyone'], { chatterId, broadcasterName: 'streamer' });
    }

    describe('!points', () => {
        it('reports a zero balance before any awards', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledWith('Viewer has 0 points.', 'msg-1', '1');
        });

        it('reports the balance after an award', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '100', displayName: 'Viewer', amount: 7 },
            ]);
            await store.flush();

            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledWith('Viewer has 7 points.', 'msg-1', '1');
        });

        it('uses the configured currency name', async () => {
            const { registry, say } = await setup({ currencyName: 'gems' });
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledWith('Viewer has 0 gems.', 'msg-1', '1');
        });

        it('throttles a viewer to one reply per cooldown window', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledTimes(1);

            clock = new Date(clock.getTime() + 9_000);
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledTimes(1);

            clock = new Date(clock.getTime() + 1_000);
            await registry.handle(viewerMessage('!points'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('exempts broadcasters and moderators from the cooldown', async () => {
            const { registry, say } = await setup();
            const broadcasterMsg = makeMessage('!points', ['everyone', 'broadcaster'], {
                chatterId: '1',
                broadcasterName: 'streamer',
            });
            await registry.handle(broadcasterMsg);
            await registry.handle(broadcasterMsg);
            expect(say).toHaveBeenCalledTimes(2);
        });
    });

    describe('!pointsboard', () => {
        it('reports an empty pool', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!pointsboard'));
            expect(say).toHaveBeenCalledWith('No points earned yet.', 'msg-1', '1');
        });

        it('lists the top earners after awards', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Alice', amount: 20 },
                { chatterId: '20', displayName: 'Bob', amount: 5 },
            ]);
            await store.flush();

            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!pointsboard'));
            expect(say).toHaveBeenCalledWith('Top points: 1. Alice (20), 2. Bob (5)', 'msg-1', '1');
        });
    });

    describe('passive chat-activity earning', () => {
        it('awards points only to chatters active while the channel is live', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock);
            const { bus, registry, say, ctx, plugin } = await setup({ pointsPerTick: 2 });

            // Not live yet: chatting now should not be credited.
            bus.emit('chatMessage', chatFrom('100', 'Viewer'));

            bus.emit('streamOnline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                startedAt: clock,
            });
            bus.emit('chatMessage', chatFrom('200', 'Active'));

            await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
            await plugin.dispose?.(ctx);

            await registry.handle(viewerMessage('!points'));
            // '100' chatted before going live: never credited.
            expect(say).not.toHaveBeenCalledWith(
                expect.stringContaining('has 2 points'),
                'msg-1',
                '1',
            );

            const activeMsg = makeMessage('!points', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 2 points.', 'msg-1', '1');
        });

        it('does not award chatters again after the channel goes offline', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock);
            const { bus, registry, say, ctx, plugin } = await setup({ pointsPerTick: 3 });

            bus.emit('streamOnline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                startedAt: clock,
            });
            bus.emit('chatMessage', chatFrom('200', 'Active'));
            bus.emit('streamOffline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
            });

            await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
            await plugin.dispose?.(ctx);

            const activeMsg = makeMessage('!points', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 0 points.', 'msg-1', '1');
        });

        it('resets activity between ticks so a chatter is credited once per tick', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock);
            const { bus, registry, say, ctx, plugin } = await setup({ pointsPerTick: 1 });

            bus.emit('streamOnline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                startedAt: clock,
            });
            bus.emit('chatMessage', chatFrom('200', 'Active'));
            await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
            // No further chat activity before the second tick.
            await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
            await plugin.dispose?.(ctx);

            const activeMsg = makeMessage('!points', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 1 points.', 'msg-1', '1');
        });

        it('respects a configured tick interval', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock);
            const { bus, registry, say, ctx, plugin } = await setup({
                pointsPerTick: 1,
                tickIntervalMinutes: 1,
            });

            bus.emit('streamOnline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                startedAt: clock,
            });
            bus.emit('chatMessage', chatFrom('200', 'Active'));
            await vi.advanceTimersByTimeAsync(60_000);
            await plugin.dispose?.(ctx);

            const activeMsg = makeMessage('!points', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 1 points.', 'msg-1', '1');
        });
    });

    describe('scoping', () => {
        it('shares the pool across channels by default', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '10', displayName: 'Tank', amount: 4 },
            ]);
            await store.flush();

            const { registry, say } = await setup();
            const message = makeMessage('!points', ['everyone'], {
                chatterId: '10',
                chatterDisplayName: 'Tank',
                broadcasterId: '2',
                broadcasterName: 'streamer2',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Tank has 4 points.', 'msg-1', '2');
        });

        it('keeps channels independent when sharing is off', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany('1', [{ chatterId: '10', displayName: 'Tank', amount: 4 }]);
            await store.flush();

            const { registry, say } = await setup({ shareAcrossChannels: false });
            const message = makeMessage('!points', ['everyone'], {
                chatterId: '10',
                chatterDisplayName: 'Tank',
                broadcasterId: '2',
                broadcasterName: 'streamer2',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Tank has 0 points.', 'msg-1', '2');
        });
    });

    it('flushes pending writes on dispose', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(clock);
        const { plugin, bus, ctx } = await setup({ pointsPerTick: 5 });
        bus.emit('streamOnline', {
            broadcasterId: '1',
            broadcasterName: 'streamer',
            broadcasterDisplayName: 'Streamer',
            startedAt: clock,
        });
        bus.emit('chatMessage', chatFrom('200', 'Active'));
        await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
        await plugin.dispose?.(ctx);

        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();
        expect(store.getBalance(SHARED_SCOPE_KEY, '200')).toBe(5);
    });

    it('logs a tick award failure instead of an unhandled rejection', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(clock);
        const errorSpy = vi.spyOn(testLogger, 'error');
        // Simulate a write failure (disk full, permissions, transient FS
        // error) on the tick's atomic write, independent of the real
        // filesystem's permission enforcement.
        const writeSpy = vi
            .spyOn(AtomicJsonFile.prototype, 'write')
            .mockRejectedValueOnce(new Error('simulated disk failure'));
        const { plugin, bus, ctx } = await setup();

        bus.emit('streamOnline', {
            broadcasterId: '1',
            broadcasterName: 'streamer',
            broadcasterDisplayName: 'Streamer',
            startedAt: clock,
        });
        bus.emit('chatMessage', chatFrom('200', 'Active'));

        await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
        expect(errorSpy).toHaveBeenCalledWith(
            expect.objectContaining({ scopeKey: SHARED_SCOPE_KEY, broadcasterId: '1' }),
            'loyalty tick award failed',
        );

        await plugin.dispose?.(ctx);
        writeSpy.mockRestore();
        errorSpy.mockRestore();
    });

    it('clears the tick timer on dispose so it cannot fire again', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(clock);
        const { plugin, bus, ctx } = await setup({ pointsPerTick: 1 });
        bus.emit('streamOnline', {
            broadcasterId: '1',
            broadcasterName: 'streamer',
            broadcasterDisplayName: 'Streamer',
            startedAt: clock,
        });
        await plugin.dispose?.(ctx);
        bus.emit('chatMessage', chatFrom('200', 'Active'));
        await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS * 3);

        const store = new LoyaltyStore(dataPath, testLogger);
        await store.load();
        expect(store.getBalance(SHARED_SCOPE_KEY, '200')).toBe(0);
    });
});
