import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import type { RefreshingAuthProvider } from '@twurple/auth';
import { ChatRateLimiter } from './chatRateLimiter.js';
import { resolveRoles } from './permissions.js';
import type {
  ChatMessageEvent,
  HelixClient,
  HelixUser,
  Logger,
  MessageSender,
  StreamOfflineEvent,
  StreamOnlineEvent,
} from './types.js';

export interface TransportHandlers {
  onChatMessage(event: ChatMessageEvent): void | Promise<void>;
  onStreamOnline(event: StreamOnlineEvent): void | Promise<void>;
  onStreamOffline(event: StreamOfflineEvent): void | Promise<void>;
}

export interface TwitchTransportOptions {
  authProvider: RefreshingAuthProvider;
  botUserId: string;
  botLogin?: string;
  broadcasters?: Array<{ login: string; userId?: string }>;
  /** Legacy single-channel option. */
  broadcasterLogin?: string;
  /** Legacy multi-channel option for callers that resolve user IDs separately. */
  broadcasterLogins?: string[];
  broadcasterUserIds?: string[];
  logger: Logger;
  handlers: TransportHandlers;
}

export interface TwitchTransport {
  broadcasterId: string;
  broadcasterIds: string[];
  sender: MessageSender;
  helix: HelixClient;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The Twitch transport: the single place that touches twurple. It resolves the
 * broadcaster, opens one EventSub WebSocket for both chat and stream events,
 * normalizes them into transport-agnostic shapes, and exposes a `sender` that
 * posts via the Helix Send Chat Message API.
 */
export async function createTwitchTransport(
  opts: TwitchTransportOptions,
): Promise<TwitchTransport> {
  const { authProvider, botUserId, botLogin, logger, handlers } = opts;

  const api = new ApiClient({ authProvider });

  const configuredBroadcasters = opts.broadcasters ?? buildLegacyBroadcasters(opts);
  const broadcasters = await Promise.all(
    configuredBroadcasters.map(async ({ login, userId }) => {
      const broadcaster = await api.users.getUserByName(login);
      if (!broadcaster) {
        throw new Error(`broadcaster "${login}" not found on Twitch`);
      }
      if (userId !== undefined && userId !== broadcaster.id) {
        throw new Error(
          `OAuth token for broadcaster "${login}" belongs to user ${userId}, ` +
            `but Twitch resolved the channel as user ${broadcaster.id}. ` +
            `Run npm run auth -- --broadcaster ${login} again while logged into that account.`,
        );
      }
      return { login, id: broadcaster.id, displayName: broadcaster.displayName };
    }),
  );

  if (botLogin) {
    const bot = await api.users.getUserByName(botLogin);
    if (!bot) {
      throw new Error(`bot "${botLogin}" not found on Twitch`);
    }
    if (bot.id !== botUserId) {
      throw new Error(
        `OAuth token belongs to user ${botUserId}, but config.bot.login is "${botLogin}". ` +
          `Run npm run auth -- --bot again while logged into that account.`,
      );
    }
  }

  const listener = new EventSubWsListener({ apiClient: api });
  const rateLimiter = new ChatRateLimiter();
  const liveStreamIds = new Map<string, string>();
  const disconnectedUsers = new Set<string>();

  listener.onUserSocketConnect((userId) => {
    const wasDisconnected = disconnectedUsers.delete(userId);
    logger.info({ userId }, 'EventSub WebSocket connected');
    if (wasDisconnected) void reconcileLiveStreams('EventSub reconnect');
  });
  listener.onUserSocketDisconnect((userId, error) => {
    disconnectedUsers.add(userId);
    logger.warn({ userId, err: error }, 'EventSub WebSocket disconnected');
  });
  listener.onRevoke((subscription, status) => {
    logger.error(
      {
        subscriptionId: subscription.id,
        subscriptionClass: subscription.constructor.name,
        authUserId: subscription.authUserId,
        status,
      },
      'EventSub subscription revoked',
    );
  });
  listener.onSubscriptionCreateFailure((subscription, error) => {
    logger.error(
      {
        subscriptionId: subscription.id,
        subscriptionClass: subscription.constructor.name,
        authUserId: subscription.authUserId,
        err: error,
      },
      'EventSub subscription creation failed; check token scopes and channel access',
    );
  });

  const emitStreamOnline = (event: StreamOnlineEvent): void => {
    if (event.streamId && liveStreamIds.get(event.broadcasterId) === event.streamId) return;
    if (event.streamId) liveStreamIds.set(event.broadcasterId, event.streamId);
    void handlers.onStreamOnline(event);
  };

  const emitStreamOffline = (event: StreamOfflineEvent): void => {
    if (!liveStreamIds.has(event.broadcasterId)) return;
    liveStreamIds.delete(event.broadcasterId);
    void handlers.onStreamOffline(event);
  };

  async function reconcileLiveStreams(reason: string): Promise<void> {
    const states = await Promise.all(
      broadcasters.map(async (broadcaster) => {
        try {
          const stream = await api.streams.getStreamByUserId(broadcaster.id);
          return { broadcaster, stream };
        } catch (error) {
          logger.warn(
            { broadcasterId: broadcaster.id, reason, err: error },
            'could not reconcile live stream state',
          );
          return null;
        }
      }),
    );

    for (const state of states) {
      if (!state) continue;
      if (!state.stream) {
        emitStreamOffline({
          broadcasterId: state.broadcaster.id,
          broadcasterName: state.broadcaster.login,
          broadcasterDisplayName: state.broadcaster.displayName,
          recovered: true,
        });
        continue;
      }
      emitStreamOnline({
        broadcasterId: state.stream.userId,
        broadcasterName: state.stream.userName,
        broadcasterDisplayName: state.stream.userDisplayName,
        streamId: state.stream.id,
        recovered: true,
        startedAt: state.stream.startDate,
      });
    }
  }
  logger.info(
    {
      botUserId,
      botLogin,
      broadcasters: broadcasters.map(({ id, login }) => ({ id, login })),
    },
    'Twitch authorization identities validated',
  );

  for (const broadcaster of broadcasters) {
    // Chat messages → normalize (resolve roles) → handler.
    listener.onChannelChatMessage(broadcaster.id, botUserId, (event) => {
      const normalized: ChatMessageEvent = {
        messageId: event.messageId,
        text: event.messageText,
        chatterId: event.chatterId,
        chatterName: event.chatterName,
        chatterDisplayName: event.chatterDisplayName,
        badges: event.badges,
        roles: resolveRoles(event.badges),
        broadcasterId: event.broadcasterId,
        broadcasterName: event.broadcasterName,
      };
      void handlers.onChatMessage(normalized);
    });

    // Stream events use the broadcaster's token, which needs no extra scope.
    listener.onStreamOnline(broadcaster.id, (event) => {
      const normalized: StreamOnlineEvent = {
        broadcasterId: event.broadcasterId,
        broadcasterName: event.broadcasterName,
        broadcasterDisplayName: event.broadcasterDisplayName,
        streamId: event.id,
        startedAt: event.startDate,
      };
      emitStreamOnline(normalized);
    });
    listener.onStreamOffline(broadcaster.id, (event) => {
      const normalized: StreamOfflineEvent = {
        broadcasterId: event.broadcasterId,
        broadcasterName: event.broadcasterName,
        broadcasterDisplayName: event.broadcasterDisplayName,
      };
      emitStreamOffline(normalized);
    });
  }

  const broadcasterIds = broadcasters.map(({ id }) => id);
  const defaultBroadcasterId = broadcasterIds[0];
  if (!defaultBroadcasterId) {
    throw new Error('at least one broadcaster is required');
  }
  const sender: MessageSender = async (text, replyToId, broadcasterId = defaultBroadcasterId) => {
    if (!broadcasterIds.includes(broadcasterId)) {
      throw new Error(`cannot send to unconfigured broadcaster "${broadcasterId}"`);
    }
    const characterCount = Array.from(text).length;
    if (characterCount > 500) {
      throw new Error(`Twitch chat messages cannot exceed 500 characters (got ${characterCount})`);
    }
    const sendChatMessage = () =>
      rateLimiter.enqueue(broadcasterId, async () => {
        // Scope the send to the bot user. Without this, twurple defaults the
        // sender to the broadcaster, whose token lacks user:write:chat.
        const result = await api.asUser(botUserId, (ctx) =>
          ctx.chat.sendChatMessage(
            broadcasterId,
            text,
            replyToId ? { replyParentMessageId: replyToId } : undefined,
          ),
        );
        if (!result.isSent) {
          logger.warn(
            {
              broadcasterId,
              dropReasonCode: result.dropReasonCode,
              dropReasonMessage: result.dropReasonMessage,
            },
            'Twitch dropped chat message',
          );
        }
        return result;
      });
    try {
      await sendChatMessageWithRetry(sendChatMessage);
    } catch (error) {
      logger.error(
        {
          broadcasterId,
          statusCode: getStatusCode(error),
          failureType: classifySendFailure(error),
          err: error,
        },
        'Twitch chat send failed',
      );
      throw error;
    }
  };

  const helix: HelixClient = {
    async getFollowage(broadcasterId, userId) {
      if (!broadcasterIds.includes(broadcasterId)) {
        throw new Error(`cannot query unconfigured broadcaster "${broadcasterId}"`);
      }
      // Requires moderator:read:followers on the broadcaster token.
      const result = await api.asUser(broadcasterId, (ctx) =>
        ctx.channels.getChannelFollowers(broadcasterId, userId),
      );
      const follower = result?.data[0];
      return follower ? { followedAt: follower.followDate } : null;
    },

    async getUserByLogin(login) {
      const user = await api.users.getUserByName(login);
      if (!user) return null;
      const channelInfo = await api.channels.getChannelInfoById(user.id);
      const helixUser: HelixUser = {
        id: user.id,
        login: user.name,
        displayName: user.displayName,
        lastGame: channelInfo?.gameName || null,
      };
      return helixUser;
    },

    async sendShoutout(fromBroadcasterId, toBroadcasterId, moderatorId) {
      // Requires moderator:manage:shoutouts on the broadcaster token.
      await api.asUser(moderatorId, (ctx) =>
        ctx.chat.shoutoutUser(fromBroadcasterId, toBroadcasterId),
      );
    },
  };

  return {
    broadcasterId: defaultBroadcasterId,
    broadcasterIds,
    sender,
    helix,
    start: async () => {
      listener.start();
      await reconcileLiveStreams('startup');
      logger.info({ broadcasters }, 'EventSub listener started');
    },
    stop: async () => {
      listener.stop();
      rateLimiter.close();
    },
  };
}

async function sendChatMessageWithRetry<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send();
  } catch (error) {
    if (getStatusCode(error) !== 503) throw error;
    return send();
  }
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function classifySendFailure(error: unknown): string {
  const statusCode = getStatusCode(error);
  if (statusCode === 403) return 'channel_access';
  if (statusCode === 422) return 'message_too_large';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'service_unavailable';
  return 'api_error';
}

function buildLegacyBroadcasters(
  opts: TwitchTransportOptions,
): Array<{ login: string; userId?: string }> {
  const logins = opts.broadcasterLogins ?? (opts.broadcasterLogin ? [opts.broadcasterLogin] : []);
  const userIds = opts.broadcasterUserIds ?? [];
  if (!logins.length) {
    throw new Error('at least one broadcaster is required');
  }
  return logins.map((login, index) => {
    const userId = userIds[index];
    return { login, userId };
  });
}
