import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshingAuthProvider } from '@twurple/auth';
import { createTwitchTransport } from '../src/core/twitch.js';
import { testLogger } from './helpers.js';

// Map logins to Twitch user ids so the transport can resolve broadcasters.
const USER_IDS: Record<string, string> = {
  ghostbot: 'bot-id',
  streamer: 'channel-id',
};

const { sendChatMessageSpy, asUserSpy, getStreamByUserIdSpy, listenerInstances } = vi.hoisted(() => ({
  sendChatMessageSpy: vi.fn().mockResolvedValue({ isSent: true, id: 'sent-1' }),
  asUserSpy: vi.fn(),
  getStreamByUserIdSpy: vi.fn().mockResolvedValue(null),
  listenerInstances: [] as unknown[],
}));

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

describe('twitch transport sender', () => {
  it('sends chat messages as the bot user, not the broadcaster', async () => {
    asUserSpy.mockClear();

    const transport = await createTwitchTransport({
      authProvider: dummyAuthProvider,
      botUserId: 'bot-id',
      broadcasters: [{ login: 'streamer' }],
      logger: testLogger,
      handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn() },
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
      handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn() },
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

  it('rejects messages longer than Twitch allows', async () => {
    sendChatMessageSpy.mockClear();
    const transport = await createTwitchTransport({
      authProvider: dummyAuthProvider,
      botUserId: 'bot-id',
      broadcasters: [{ login: 'streamer' }],
      logger: testLogger,
      handlers: { onChatMessage: vi.fn(), onStreamOnline: vi.fn() },
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
      handlers: { onChatMessage: vi.fn(), onStreamOnline },
    });

    await transport.start();

    expect(onStreamOnline).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-1', recovered: true }),
    );
    expect(listenerInstances).toHaveLength(1);
    await transport.stop();
  });
});
