import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AtomicJsonFile } from '../src/core/atomicFile.js';
import { createLoyaltyPlugin } from '../src/plugins/loyalty/index.js';
import { LoyaltyStore, SHARED_SCOPE_KEY } from '../src/plugins/loyalty/store.js';
import type { PluginConfig } from '../src/core/types.js';
import { makeHarness, makeMessage, testLogger } from './helpers.js';

const START = DateTime.utc(2026, 8, 2, 18, 0, 0);
const FIVE_MINUTES_MS = 5 * 60 * 1000;

describe('loyalty plugin', () => {
    let dir: string;
    let dataPath: string;
    let clock: DateTime;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-loyalty-'));
        dataPath = join(dir, 'loyalty.json');
        clock = START;
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

    describe('!wallet', () => {
        it('reports a zero balance before any awards', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledWith('Viewer has 0 esports dollars.', 'msg-1', '1');
        });

        it('reports the balance after an award', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany(SHARED_SCOPE_KEY, [
                { chatterId: '100', displayName: 'Viewer', amount: 7 },
            ]);
            await store.flush();

            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledWith('Viewer has 7 esports dollars.', 'msg-1', '1');
        });

        it('uses the configured currency name', async () => {
            const { registry, say } = await setup({ currencyName: 'gems' });
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledWith('Viewer has 0 gems.', 'msg-1', '1');
        });

        it('throttles a viewer to one reply per cooldown window', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledTimes(1);

            clock = clock.plus({ seconds: 9 });
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledTimes(1);

            clock = clock.plus({ seconds: 1 });
            await registry.handle(viewerMessage('!wallet'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('exempts broadcasters and moderators from the cooldown', async () => {
            const { registry, say } = await setup();
            const broadcasterMsg = makeMessage('!wallet', ['everyone', 'broadcaster'], {
                chatterId: '1',
                broadcasterName: 'streamer',
            });
            await registry.handle(broadcasterMsg);
            await registry.handle(broadcasterMsg);
            expect(say).toHaveBeenCalledTimes(2);
        });
    });

    describe('!economy', () => {
        it('reports an empty pool', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!economy'));
            expect(say).toHaveBeenCalledWith('No esports dollars earned yet.', 'msg-1', '1');
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
            await registry.handle(viewerMessage('!economy'));
            expect(say).toHaveBeenCalledWith(
                'Top esports dollars: 1. Alice (20), 2. Bob (5)',
                'msg-1',
                '1',
            );
        });
    });

    describe('passive chat-activity earning', () => {
        it('awards esports dollars only to chatters active while the channel is live', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock.toJSDate());
            const { bus, registry, say, ctx, plugin } = await setup({ dollarsPerTick: 2 });

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

            await registry.handle(viewerMessage('!wallet'));
            // '100' chatted before going live: never credited.
            expect(say).not.toHaveBeenCalledWith(
                expect.stringContaining('has 2 esports dollars'),
                'msg-1',
                '1',
            );

            const activeMsg = makeMessage('!wallet', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 2 esports dollars.', 'msg-1', '1');
        });

        it('does not award chatters again after the channel goes offline', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock.toJSDate());
            const { bus, registry, say, ctx, plugin } = await setup({ dollarsPerTick: 3 });

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

            const activeMsg = makeMessage('!wallet', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 0 esports dollars.', 'msg-1', '1');
        });

        it('preserves pending activity across an unverified offline', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock.toJSDate());
            const { bus, registry, say, ctx, plugin } = await setup({ dollarsPerTick: 3 });

            bus.emit('streamOnline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                startedAt: clock,
            });
            bus.emit('chatMessage', chatFrom('200', 'Active'));
            // Verification failed - the channel might still be live, so this
            // must not discard the tick's pending activity the way a real
            // offline does.
            bus.emit('streamOffline', {
                broadcasterId: '1',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                verified: false,
            });

            await vi.advanceTimersByTimeAsync(FIVE_MINUTES_MS);
            await plugin.dispose?.(ctx);

            const activeMsg = makeMessage('!wallet', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 3 esports dollars.', 'msg-1', '1');
        });

        it('resets activity between ticks so a chatter is credited once per tick', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock.toJSDate());
            const { bus, registry, say, ctx, plugin } = await setup({ dollarsPerTick: 1 });

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

            const activeMsg = makeMessage('!wallet', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 1 esports dollars.', 'msg-1', '1');
        });

        it('respects a configured tick interval', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(clock.toJSDate());
            const { bus, registry, say, ctx, plugin } = await setup({
                dollarsPerTick: 1,
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

            const activeMsg = makeMessage('!wallet', ['everyone'], {
                chatterId: '200',
                chatterDisplayName: 'Active',
                broadcasterName: 'streamer',
            });
            await registry.handle(activeMsg);
            expect(say).toHaveBeenCalledWith('Active has 1 esports dollars.', 'msg-1', '1');
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
            const message = makeMessage('!wallet', ['everyone'], {
                chatterId: '10',
                chatterDisplayName: 'Tank',
                broadcasterId: '2',
                broadcasterName: 'streamer2',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Tank has 4 esports dollars.', 'msg-1', '2');
        });

        it('keeps channels independent when sharing is off', async () => {
            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            await store.awardMany('1', [{ chatterId: '10', displayName: 'Tank', amount: 4 }]);
            await store.flush();

            const { registry, say } = await setup({ shareAcrossChannels: false });
            const message = makeMessage('!wallet', ['everyone'], {
                chatterId: '10',
                chatterDisplayName: 'Tank',
                broadcasterId: '2',
                broadcasterName: 'streamer2',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Tank has 0 esports dollars.', 'msg-1', '2');
        });
    });

    it('flushes pending writes on dispose', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(clock.toJSDate());
        const { plugin, bus, ctx } = await setup({ dollarsPerTick: 5 });
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
        vi.setSystemTime(clock.toJSDate());
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
        vi.setSystemTime(clock.toJSDate());
        const { plugin, bus, ctx } = await setup({ dollarsPerTick: 1 });
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
