import { describe, expect, it } from 'vitest';
import announce, {
    createAnnouncePlugin,
    formatForChat,
    renderCheer,
    renderRaid,
    renderSubscribe,
    truncateForChat,
    ZERO_WIDTH_SPACE,
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

describe('truncateForChat', () => {
    it('leaves a short message untouched', () => {
        expect(truncateForChat('short')).toBe('short');
    });

    it('truncates a message over the 500 code-point limit', () => {
        const long = 'x'.repeat(600);
        const truncated = truncateForChat(long);
        expect([...truncated]).toHaveLength(500);
    });

    it('counts by code point, not UTF-16 unit, so a surrogate pair is never split', () => {
        // Each emoji is one code point but two UTF-16 units; naive .slice(0, 500)
        // on the raw string could cut a pair in half and produce invalid output.
        const long = '🎉'.repeat(600);
        const truncated = truncateForChat(long);
        expect([...truncated]).toHaveLength(500);
        expect(truncated).toBe('🎉'.repeat(500));
    });
});

describe('formatForChat', () => {
    it('leaves a message that does not start with a sigil untouched', () => {
        expect(formatForChat('Someone cheered 100 bits: hi')).toBe('Someone cheered 100 bits: hi');
    });

    it.each(['/', '.'])('neutralizes a leading "%s" so chat cannot run it', (sigil) => {
        const formatted = formatForChat(`${sigil}ban someone`);
        expect(formatted.startsWith(sigil)).toBe(false);
        expect(formatted).toBe(`${ZERO_WIDTH_SPACE}${sigil}ban someone`);
    });

    it('leaves a sigil that is not in the first position alone', () => {
        expect(formatForChat('cheered: /ban someone')).toBe('cheered: /ban someone');
    });

    it('still fits the 500 code-point limit after neutralizing', () => {
        const formatted = formatForChat(`/${'x'.repeat(600)}`);
        expect([...formatted]).toHaveLength(500);
        expect(formatted.startsWith(ZERO_WIDTH_SPACE)).toBe(true);
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

    it('truncates a cheer announcement pushed past 500 characters by a long message', async () => {
        const { bus, say } = await setup();
        bus.emit('cheer', cheerEvent({ message: 'x'.repeat(600) }));
        await flush();
        const [sent] = say.mock.calls[0]!;
        expect([...(sent as string)]).toHaveLength(500);
    });

    it('defuses a cheer message that would lead the announcement with a command', async () => {
        // A template placing the untrusted cheer message first is the case that
        // lets a chatter control the first character of what the bot sends.
        const { bus, say } = await setup({ cheer: { template: '{message}' } });
        bus.emit('cheer', cheerEvent({ message: '/ban someone' }));
        await flush();
        const [sent] = say.mock.calls[0]!;
        expect(sent as string).toBe(`${ZERO_WIDTH_SPACE}/ban someone`);
        expect((sent as string).startsWith('/')).toBe(false);
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
