import { describe, expect, it } from 'vitest';
import announce, {
    createAnnouncePlugin,
    renderCheer,
    renderRaid,
    renderSubscribe,
} from '../src/plugins/announce/index.js';
import type { CheerEvent, PluginConfig, RaidEvent, SubscribeEvent } from '../src/core/types.js';
import { flush, makeHarness } from './helpers.js';

function raidEvent(overrides: Partial<RaidEvent> = {}): RaidEvent {
    return {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        broadcasterDisplayName: 'Streamer',
        raidingBroadcasterId: '2',
        raidingBroadcasterName: 'raider',
        raidingBroadcasterDisplayName: 'Raider',
        viewers: 25,
        ...overrides,
    };
}

function subscribeEvent(overrides: Partial<SubscribeEvent> = {}): SubscribeEvent {
    return {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        broadcasterDisplayName: 'Streamer',
        userId: '10',
        userName: 'viewer',
        userDisplayName: 'Viewer',
        tier: '1000',
        isGift: false,
        ...overrides,
    };
}

function cheerEvent(overrides: Partial<CheerEvent> = {}): CheerEvent {
    return {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        broadcasterDisplayName: 'Streamer',
        userId: '10',
        userName: 'viewer',
        userDisplayName: 'Viewer',
        isAnonymous: false,
        message: 'nice stream!',
        bits: 500,
        ...overrides,
    };
}

describe('announce helpers', () => {
    it('renders a raid template', () => {
        expect(renderRaid('{raider} raided with {viewers} viewers!', raidEvent())).toBe(
            'Raider raided with 25 viewers!',
        );
    });

    it('renders a subscribe template with tier and gift note', () => {
        expect(
            renderSubscribe(
                '{user} subscribed at tier {tier}{giftNote}!',
                subscribeEvent({ tier: '2000', isGift: true }),
            ),
        ).toBe('Viewer subscribed at tier 2 (gifted)!');
        expect(
            renderSubscribe('{user} subscribed at tier {tier}{giftNote}!', subscribeEvent()),
        ).toBe('Viewer subscribed at tier 1!');
    });

    it('falls back to the raw tier string for an unrecognized tier code', () => {
        expect(renderSubscribe('tier {tier}', subscribeEvent({ tier: 'weird' }))).toBe(
            'tier weird',
        );
    });

    it('renders a cheer template, substituting "Someone" for an anonymous cheerer', () => {
        expect(renderCheer('{user} cheered {bits} bits: {message}', cheerEvent())).toBe(
            'Viewer cheered 500 bits: nice stream!',
        );
        expect(
            renderCheer(
                '{user} cheered {bits} bits: {message}',
                cheerEvent({ userDisplayName: null, isAnonymous: true }),
            ),
        ).toBe('Someone cheered 500 bits: nice stream!');
    });
});

describe('announce plugin', () => {
    async function setup(config: PluginConfig = {}) {
        const plugin = createAnnouncePlugin();
        const harness = makeHarness('announce', config);
        await plugin.init(harness.ctx);
        return { plugin, ...harness };
    }

    it('announces a raid with the default template', async () => {
        const { bus, say } = await setup();
        bus.emit('raid', raidEvent());
        await flush();
        expect(say).toHaveBeenCalledWith('Raider raided with 25 viewers!', undefined, '1');
    });

    it('announces a subscribe with the default template', async () => {
        const { bus, say } = await setup();
        bus.emit('subscribe', subscribeEvent({ tier: '3000' }));
        await flush();
        expect(say).toHaveBeenCalledWith('Viewer subscribed at tier 3!', undefined, '1');
    });

    it('announces a cheer at or above the default 100-bit minimum', async () => {
        const { bus, say } = await setup();
        bus.emit('cheer', cheerEvent({ bits: 100 }));
        await flush();
        expect(say).toHaveBeenCalledWith('Viewer cheered 100 bits: nice stream!', undefined, '1');
    });

    it('suppresses a cheer below the configured minimum', async () => {
        const { bus, say } = await setup({ cheer: { minBits: 200 } });
        bus.emit('cheer', cheerEvent({ bits: 199 }));
        await flush();
        expect(say).not.toHaveBeenCalled();
    });

    it('respects a configured template per event type', async () => {
        const { bus, say } = await setup({
            raid: { template: 'RAID from {raider} ({viewers})' },
            subscribe: { template: 'SUB {user}' },
            cheer: { template: 'BITS {bits}' },
        });
        bus.emit('raid', raidEvent());
        bus.emit('subscribe', subscribeEvent());
        bus.emit('cheer', cheerEvent());
        await flush();
        expect(say).toHaveBeenCalledWith('RAID from Raider (25)', undefined, '1');
        expect(say).toHaveBeenCalledWith('SUB Viewer', undefined, '1');
        expect(say).toHaveBeenCalledWith('BITS 500', undefined, '1');
    });

    it('disables a single event type independently', async () => {
        const { bus, say } = await setup({ raid: { enabled: false } });
        bus.emit('raid', raidEvent());
        bus.emit('subscribe', subscribeEvent());
        await flush();
        expect(say).toHaveBeenCalledTimes(1);
        expect(say).toHaveBeenCalledWith('Viewer subscribed at tier 1!', undefined, '1');
    });

    it('falls back to defaults for an invalid config block', async () => {
        const { bus, say } = await setup({
            raid: { enabled: 'yes', template: '' },
            cheer: { minBits: -5 },
        });
        bus.emit('raid', raidEvent());
        bus.emit('cheer', cheerEvent({ bits: 1 }));
        await flush();
        expect(say).toHaveBeenCalledWith('Raider raided with 25 viewers!', undefined, '1');
        // minBits fell back to the default (100), so a 1-bit cheer is suppressed.
        expect(say).not.toHaveBeenCalledWith(expect.stringContaining('1 bits'), undefined, '1');
    });
});

describe('default export', () => {
    it('is a ready-to-use plugin instance', () => {
        expect(announce.name).toBe('announce');
    });
});
