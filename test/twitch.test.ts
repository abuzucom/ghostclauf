import { describe, expect, it, vi } from 'vitest';
import type { RefreshingAuthProvider } from '@twurple/auth';
import { createTwitchTransport } from '../src/core/twitch.js';
import { testLogger } from './helpers.js';

// Map logins to Twitch user ids so the transport can resolve broadcasters.
const USER_IDS: Record<string, string> = {
  ghostbot: 'bot-id',
  streamer: 'channel-id',
};

const { sendChatMessageSpy, asUserSpy } = vi.hoisted(() => ({
  sendChatMessageSpy: vi.fn().mockResolvedValue(undefined),
  asUserSpy: vi.fn(),
}));

vi.mock('@twurple/api', () => {
  class MockApiClient {
    users = {
      getUserByName: (login: string) =>
        Promise.resolve(USER_IDS[login] ? { id: USER_IDS[login] } : null),
    };
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
    onChannelChatMessage = vi.fn();
    onStreamOnline = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  }
  return { EventSubWsListener: MockListener };
});

const dummyAuthProvider = {} as RefreshingAuthProvider;

describe('twitch transport sender', () => {
  it('sends chat messages as the bot user, not the broadcaster', async () => {
    sendChatMessageSpy.mockClear();
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
});
