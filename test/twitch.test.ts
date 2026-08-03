import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshingAuthProvider } from '@twurple/auth';
import { createMetrics } from '../src/core/metrics.js';
import { createTwitchTransport } from '../src/core/twitch.js';
import { testLogger } from './helpers.js';

// Map logins to Twitch user ids so the transport can resolve broadcasters.
const USER_IDS: Record<string, string> = {
    ghostbot: 'bot-id',
    streamer: 'channel-id',
};

const { sendChatMessageSpy, asUserSpy, getStreamByUserIdSpy, listenerInstances } = vi.hoisted(
    () => ({
        sendChatMessageSpy: vi.fn().mockResolvedValue({ isSent: true, id: 'sent-1' }),
        asUserSpy: vi.fn(),
        getStreamByUserIdSpy: vi.fn().mockResolvedValue(null),
        listenerInstances: [] as unknown[],
    }),
);

vi.mock('@twurple/api', () => {
    class MockApiClient {
        users = {
            getUserByName: (login: string) =>
                Promise.resolve(USER_IDS[login] ? { id: USER_IDS[login] } : null),
        };
        streams = { getStreamByUserId: getStreamByUserIdSpy };
        chat = { sendChatMessage: sendChatMessageSpy };
        // asUser scopes the call to a user; the runner receives the same client.
        asUser = (userId: string, runner: (ctx: unknown) => Promise<unknown>) => {
            asUserSpy(userId);
            return runner(this);
        };
    }
    return { ApiClient: MockApiClient };
});

vi.mock('@twurple/eventsub-ws', () => {
    class MockListener {
        constructor() {
            listenerInstances.push(this);
        }
        onChannelChatMessage = vi.fn();
        onStreamOnline = vi.fn();
        onStreamOffline = vi.fn();
        start = vi.fn();
        stop = vi.fn();
        onUserSocketConnect = vi.fn();
        onUserSocketDisconnect = vi.fn();
        onRevoke = vi.fn();
        onSubscriptionCreateFailure = vi.fn();
    }
    return { EventSubWsListener: MockListener };
});

const dummyAuthProvider = {} as RefreshingAuthProvider;

beforeEach(() => {
    sendChatMessageSpy.mockReset().mockResolvedValue({ isSent: true, id: 'sent-1' });
    asUserSpy.mockClear();
    getStreamByUserIdSpy.mockReset().mockResolvedValue(null);
    listenerInstances.length = 0;
});

describe('twitch transport', () => {
    it('sends chat messages as the bot user, not the broadcaster', async () => {
        asUserSpy.mockClear();

        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('pong!', 'msg-1');

        // The send must be scoped to the bot's user context; otherwise twurple
        // defaults the sender to the broadcaster, whose token lacks
        // user:write:chat, and the Helix call throws a scope error.
        expect(asUserSpy).toHaveBeenCalledWith('bot-id');
        expect(sendChatMessageSpy).toHaveBeenCalledWith('channel-id', 'pong!', {
            replyParentMessageId: 'msg-1',
        });
    });

    it('logs when Twitch drops a message', async () => {
        sendChatMessageSpy.mockResolvedValueOnce({
            isSent: false,
            id: '',
            dropReasonCode: 'automod_held',
            dropReasonMessage: 'held for review',
        });
        const warn = vi.spyOn(testLogger, 'warn');

        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('blocked');

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                broadcasterId: 'channel-id',
                dropReasonCode: 'automod_held',
            }),
            'Twitch dropped chat message',
        );
        warn.mockRestore();
    });

    it('routes a 503 retry through the chat rate limiter', async () => {
        vi.useFakeTimers();
        try {
            const serviceUnavailable = Object.assign(new Error('unavailable'), { statusCode: 503 });
            sendChatMessageSpy
                .mockRejectedValueOnce(serviceUnavailable)
                .mockResolvedValueOnce({ isSent: true, id: 'sent-2' });
            const transport = await createTwitchTransport({
                authProvider: dummyAuthProvider,
                botUserId: 'bot-id',
                broadcasters: [{ login: 'streamer' }],
                logger: testLogger,
                handlers: {
                    onChatMessage: vi.fn(),
                    onStreamOnline: vi.fn(),
                    onStreamOffline: vi.fn(),
                },
            });

            const sending = transport.sender('retry');
            await vi.advanceTimersByTimeAsync(0);
            expect(sendChatMessageSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(999);
            expect(sendChatMessageSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            await sending;
            expect(sendChatMessageSpy).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('rejects messages longer than Twitch allows', async () => {
        sendChatMessageSpy.mockClear();
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await expect(transport.sender('x'.repeat(501))).rejects.toThrow(/500 characters/);
        expect(sendChatMessageSpy).not.toHaveBeenCalledWith(
            'channel-id',
            expect.any(String),
            expect.anything(),
        );
    });

    it('recovers a live stream during startup without announcing it as new', async () => {
        getStreamByUserIdSpy.mockResolvedValueOnce({
            id: 'stream-1',
            userId: 'channel-id',
            userName: 'streamer',
            userDisplayName: 'Streamer',
            startDate: new Date('2026-07-21T10:00:00Z'),
        });
        const onStreamOnline = vi.fn();

        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            handlers: { onChatMessage: vi.fn(), onStreamOnline, onStreamOffline: vi.fn() },
        });

        await transport.start();

        expect(onStreamOnline).toHaveBeenCalledWith(
            expect.objectContaining({ streamId: 'stream-1', recovered: true }),
        );
        expect(listenerInstances).toHaveLength(1);
        await transport.stop();
    });

    it('forwards chat messages from EventSub', async () => {
        const onChatMessage = vi.fn();
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            handlers: { onChatMessage, onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.start();
        expect(listenerInstances).toHaveLength(1);

        const listener = listenerInstances[0] as any;
        const handler = listener.onChannelChatMessage.mock.calls[0][2];

        const mockEvent = {
            messageId: 'msg-1',
            broadcasterId: 'channel-id',
            broadcasterName: 'streamer',
            chatterId: 'user-1',
            chatterName: 'viewer',
            chatterDisplayName: 'Viewer',
            messageText: 'hello world',
            badges: new Map([['subscriber', '1']]),
        };
        handler(mockEvent);

        expect(onChatMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                messageId: 'msg-1',
                broadcasterId: 'channel-id',
                text: 'hello world',
            }),
        );
        await transport.stop();
    });

    it('forwards stream online/offline events', async () => {
        vi.useFakeTimers();
        const onStreamOnline = vi.fn();
        const onStreamOffline = vi.fn();
        const onStreamOfflinePending = vi.fn();
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            offlineConfirmationMs: 100,
            handlers: {
                onChatMessage: vi.fn(),
                onStreamOnline,
                onStreamOffline,
                onStreamOfflinePending,
            },
        });

        await transport.start();
        const listener = listenerInstances[0] as any;

        // Simulate stream online
        const onlineHandler = listener.onStreamOnline.mock.calls[0][1];
        onlineHandler({
            broadcasterId: 'channel-id',
            broadcasterName: 'streamer',
            id: 'stream-123',
            startDate: new Date('2026-07-21T10:00:00Z'),
        });
        expect(onStreamOnline).toHaveBeenCalledWith(
            expect.objectContaining({ streamId: 'stream-123' }),
        );

        // Simulate stream offline
        const offlineHandler = listener.onStreamOffline.mock.calls[0][1];
        offlineHandler({
            broadcasterId: 'channel-id',
            broadcasterName: 'streamer',
        });
        expect(onStreamOfflinePending).toHaveBeenCalledOnce();
        expect(onStreamOffline).not.toHaveBeenCalled();
        getStreamByUserIdSpy.mockResolvedValueOnce(null);
        await vi.advanceTimersByTimeAsync(100);
        expect(onStreamOffline).toHaveBeenCalledWith(
            expect.objectContaining({ broadcasterId: 'channel-id', verified: true }),
        );

        await transport.stop();
        vi.useRealTimers();
    });

    it('suppresses a false offline when Helix reports the same stream', async () => {
        vi.useFakeTimers();
        try {
            const onStreamOnline = vi.fn();
            const onStreamOffline = vi.fn();
            const transport = await createTwitchTransport({
                authProvider: dummyAuthProvider,
                botUserId: 'bot-id',
                broadcasters: [{ login: 'streamer' }],
                logger: testLogger,
                offlineConfirmationMs: 100,
                handlers: { onChatMessage: vi.fn(), onStreamOnline, onStreamOffline },
            });
            await transport.start();
            const listener = listenerInstances[0] as any;
            const startDate = new Date('2026-07-21T10:00:00Z');
            listener.onStreamOnline.mock.calls[0][1]({
                broadcasterId: 'channel-id',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                id: 'stream-123',
                startDate,
            });
            listener.onStreamOffline.mock.calls[0][1]({
                broadcasterId: 'channel-id',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
            });
            getStreamByUserIdSpy.mockResolvedValueOnce({
                id: 'stream-123',
                userId: 'channel-id',
                userName: 'streamer',
                userDisplayName: 'Streamer',
                startDate,
            });

            await vi.advanceTimersByTimeAsync(100);
            expect(onStreamOffline).not.toHaveBeenCalled();
            expect(onStreamOnline).toHaveBeenLastCalledWith(
                expect.objectContaining({ streamId: 'stream-123', recovered: true }),
            );
            await transport.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails soft when offline confirmation repeatedly fails', async () => {
        vi.useFakeTimers();
        try {
            const onStreamOffline = vi.fn();
            const transport = await createTwitchTransport({
                authProvider: dummyAuthProvider,
                botUserId: 'bot-id',
                broadcasters: [{ login: 'streamer' }],
                logger: testLogger,
                offlineConfirmationMs: 100,
                offlineRetryMs: 50,
                handlers: {
                    onChatMessage: vi.fn(),
                    onStreamOnline: vi.fn(),
                    onStreamOffline,
                },
            });
            await transport.start();
            const listener = listenerInstances[0] as any;
            listener.onStreamOnline.mock.calls[0][1]({
                broadcasterId: 'channel-id',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
                id: 'stream-123',
                startDate: new Date('2026-07-21T10:00:00Z'),
            });
            listener.onStreamOffline.mock.calls[0][1]({
                broadcasterId: 'channel-id',
                broadcasterName: 'streamer',
                broadcasterDisplayName: 'Streamer',
            });
            getStreamByUserIdSpy.mockRejectedValue(new Error('unavailable'));

            await vi.advanceTimersByTimeAsync(150);
            expect(onStreamOffline).toHaveBeenCalledWith(
                expect.objectContaining({ broadcasterId: 'channel-id', verified: false }),
            );
            await transport.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('increments eventsub_reconnects when a socket reconnects after a disconnect', async () => {
        const metrics = createMetrics();
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });
        await transport.start();
        const listener = listenerInstances[0] as any;
        const disconnectHandler = listener.onUserSocketDisconnect.mock.calls[0][0];
        const connectHandler = listener.onUserSocketConnect.mock.calls[0][0];

        // A plain (re)connect with no prior disconnect must not count.
        connectHandler('bot-id');
        expect(metrics.snapshot().eventsub_reconnects).toBeUndefined();

        disconnectHandler('bot-id', new Error('dropped'));
        connectHandler('bot-id');
        expect(metrics.snapshot().eventsub_reconnects).toBe(1);
        await transport.stop();
    });

    it('increments eventsub_revocations and marks the transport not ready on revoke', async () => {
        const metrics = createMetrics();
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });
        await transport.start();
        expect(transport.isReady()).toBe(true);

        const listener = listenerInstances[0] as any;
        const revokeHandler = listener.onRevoke.mock.calls[0][0];
        revokeHandler(
            { id: 'sub-1', authUserId: 'channel-id', constructor: { name: 'FakeSubscription' } },
            'authorization_revoked',
        );

        expect(metrics.snapshot().eventsub_revocations).toBe(1);
        expect(transport.isReady()).toBe(false);
        await transport.stop();
    });

    it('increments chat_send_failures on a non-retryable send error', async () => {
        const metrics = createMetrics();
        const failure = Object.assign(new Error('forbidden'), { statusCode: 403 });
        sendChatMessageSpy.mockRejectedValueOnce(failure);
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await expect(transport.sender('oops')).rejects.toThrow('forbidden');
        expect(metrics.snapshot().chat_send_failures).toBe(1);
    });

    it('increments rate_limit_drops only for rate-limit drop reasons', async () => {
        const metrics = createMetrics();
        sendChatMessageSpy.mockResolvedValueOnce({
            isSent: false,
            id: '',
            dropReasonCode: 'automod_held',
            dropReasonMessage: 'held for review',
        });
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('not rate limited');
        expect(metrics.snapshot().rate_limit_drops).toBeUndefined();

        sendChatMessageSpy.mockResolvedValueOnce({
            isSent: false,
            id: '',
            dropReasonCode: 'rate_limited',
            dropReasonMessage: 'too many messages',
        });
        await transport.sender('rate limited');
        expect(metrics.snapshot().rate_limit_drops).toBe(1);
    });

    it('does not match a drop reason that merely contains "rate_limit"', async () => {
        const metrics = createMetrics();
        sendChatMessageSpy.mockResolvedValueOnce({
            isSent: false,
            id: '',
            dropReasonCode: 'pirate_limit_exceeded',
            dropReasonMessage: 'unrelated code sharing the substring',
        });
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('not actually rate limited');
        expect(metrics.snapshot().rate_limit_drops).toBeUndefined();
    });

    it('does not match a code starting with "rate" followed by an arbitrary character', async () => {
        const metrics = createMetrics();
        sendChatMessageSpy.mockResolvedValueOnce({
            isSent: false,
            id: '',
            dropReasonCode: 'rateXlimitedSomehow',
            dropReasonMessage: 'not a real Twitch code, but exercises the separator anchor',
        });
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('still not rate limited');
        expect(metrics.snapshot().rate_limit_drops).toBeUndefined();
    });

    it('matches rate-limited with a hyphen or no separator', async () => {
        const metrics = createMetrics();
        sendChatMessageSpy
            .mockResolvedValueOnce({ isSent: false, id: '', dropReasonCode: 'rate-limited' })
            .mockResolvedValueOnce({ isSent: false, id: '', dropReasonCode: 'ratelimited' });
        const transport = await createTwitchTransport({
            authProvider: dummyAuthProvider,
            botUserId: 'bot-id',
            broadcasters: [{ login: 'streamer' }],
            logger: testLogger,
            metrics,
            handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn(), onStreamOffline: vi.fn() },
        });

        await transport.sender('one');
        await transport.sender('two');
        expect(metrics.snapshot().rate_limit_drops).toBe(2);
    });
});
