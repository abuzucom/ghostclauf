import { describe, expect, it } from 'vitest';
import pingPlugin, { createPingPlugin } from '../src/plugins/ping/index.js';
import type { Role } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

describe('ping plugin', () => {
    it('registers exactly one command', () => {
        const { registry, ctx } = makeHarness('ping');
        pingPlugin.init(ctx);
        expect(registry.size).toBe(1);
    });

    it('replies "pong!" as a reply to the message', async () => {
        const { registry, say, ctx } = makeHarness('ping');
        pingPlugin.init(ctx);
        await registry.handle(makeMessage('!ping', ['everyone']));
        expect(say).toHaveBeenCalledWith('pong!', 'msg-1', '1');
    });

    it('does not respond to other messages', async () => {
        const { registry, say, ctx } = makeHarness('ping');
        pingPlugin.init(ctx);
        await registry.handle(makeMessage('ping', ['everyone']));
        await registry.handle(makeMessage('!pong', ['everyone']));
        expect(say).not.toHaveBeenCalled();
    });

    it('never throttles the broadcaster', async () => {
        let now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        await registry.handle(makeMessage('!ping', ['everyone', 'broadcaster']));
        await registry.handle(makeMessage('!ping', ['everyone', 'broadcaster']));
        now = new Date(now.getTime() + 1000);
        await registry.handle(makeMessage('!ping', ['everyone', 'broadcaster']));

        expect(say).toHaveBeenCalledTimes(3);
    });

    it('throttles a moderator to one reply per 5 minutes', async () => {
        let now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        await registry.handle(makeMessage('!ping', ['everyone', 'moderator']));
        now = new Date(now.getTime() + 4 * 60 * 1000);
        await registry.handle(makeMessage('!ping', ['everyone', 'moderator']));
        expect(say).toHaveBeenCalledTimes(1);

        now = new Date(now.getTime() + 60 * 1000 + 1);
        await registry.handle(makeMessage('!ping', ['everyone', 'moderator']));
        expect(say).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['vip', ['everyone', 'vip']],
        ['subscriber', ['everyone', 'subscriber']],
        ['plain viewer', ['everyone']],
    ] as const)('throttles a %s to one reply per 15 minutes', async (_label, roles) => {
        let now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        await registry.handle(makeMessage('!ping', [...roles] as Role[]));
        now = new Date(now.getTime() + 14 * 60 * 1000);
        await registry.handle(makeMessage('!ping', [...roles] as Role[]));
        expect(say).toHaveBeenCalledTimes(1);

        now = new Date(now.getTime() + 60 * 1000 + 1);
        await registry.handle(makeMessage('!ping', [...roles] as Role[]));
        expect(say).toHaveBeenCalledTimes(2);
    });

    it('tracks cooldowns independently per chatter', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        await registry.handle(makeMessage('!ping', ['everyone'], { chatterId: 'a' }));
        await registry.handle(makeMessage('!ping', ['everyone'], { chatterId: 'b' }));

        expect(say).toHaveBeenCalledTimes(2);
    });

    it('tracks cooldowns independently per broadcaster', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        await registry.handle(makeMessage('!ping', ['everyone'], { broadcasterId: '1' }));
        await registry.handle(makeMessage('!ping', ['everyone'], { broadcasterId: '2' }));

        expect(say).toHaveBeenCalledTimes(2);
    });

    it('treats a configured cross-channel moderator as unlimited', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const config = { treatAsBroadcaster: { dj1a2n: ['itsjustatank'] } };
        const { registry, say, ctx } = makeHarness('ping', config);
        await createPingPlugin(() => now).init(ctx);

        const event = makeMessage('!ping', ['everyone', 'moderator'], {
            broadcasterName: 'dj1a2n',
            chatterName: 'itsjustatank',
        });
        await registry.handle(event);
        await registry.handle(event);

        expect(say).toHaveBeenCalledTimes(2);
    });

    it('does not elevate the same moderator on an unlisted channel', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const config = { treatAsBroadcaster: { dj1a2n: ['itsjustatank'] } };
        const { registry, say, ctx } = makeHarness('ping', config);
        await createPingPlugin(() => now).init(ctx);

        const event = makeMessage('!ping', ['everyone', 'moderator'], {
            broadcasterName: 'someoneelse',
            chatterName: 'itsjustatank',
        });
        await registry.handle(event);
        await registry.handle(event);

        expect(say).toHaveBeenCalledTimes(1);
    });

    it('is case-insensitive when matching configured elevation entries', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const config = { treatAsBroadcaster: { DJ1A2N: ['ItsJustaTank'] } };
        const { registry, say, ctx } = makeHarness('ping', config);
        await createPingPlugin(() => now).init(ctx);

        const event = makeMessage('!ping', ['everyone', 'moderator'], {
            broadcasterName: 'dj1a2n',
            chatterName: 'itsjustatank',
        });
        await registry.handle(event);
        await registry.handle(event);

        expect(say).toHaveBeenCalledTimes(2);
    });

    it('does not elevate or throw on prototype-shaped lookup keys', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const { registry, say, ctx } = makeHarness('ping');
        await createPingPlugin(() => now).init(ctx);

        const event = makeMessage('!ping', ['everyone', 'moderator'], {
            broadcasterName: '__proto__',
            chatterName: 'constructor',
        });
        await registry.handle(event);
        await registry.handle(event);

        // Second call within the moderator cooldown window is throttled, proving
        // the chatter was treated as an ordinary moderator, not elevated.
        expect(say).toHaveBeenCalledTimes(1);
    });

    it('never treats an invalid-login chatter or channel as elevated', async () => {
        const now = new Date('2026-07-21T12:00:00Z');
        const config = { treatAsBroadcaster: { 'Not A Login!': ['also not a login'] } };
        const { registry, say, ctx } = makeHarness('ping', config);
        await createPingPlugin(() => now).init(ctx);

        const event = makeMessage('!ping', ['everyone', 'moderator'], {
            broadcasterName: 'not a login!',
            chatterName: 'also not a login',
        });
        await registry.handle(event);
        await registry.handle(event);

        expect(say).toHaveBeenCalledTimes(1);
    });
});
