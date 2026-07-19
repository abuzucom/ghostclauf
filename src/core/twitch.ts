import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import type { RefreshingAuthProvider } from '@twurple/auth';
import { resolveRoles } from './permissions.js';
import type {
  ChatMessageEvent,
  Logger,
  MessageSender,
  StreamOnlineEvent,
} from './types.js';

export interface TransportHandlers {
  onChatMessage(event: ChatMessageEvent): void | Promise<void>;
  onStreamOnline(event: StreamOnlineEvent): void | Promise<void>;
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
      return { login, id: broadcaster.id };
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

    // Stream went live. WebSocket subscriptions use the broadcaster's token.
    listener.onStreamOnline(broadcaster.id, (event) => {
      const normalized: StreamOnlineEvent = {
        broadcasterId: event.broadcasterId,
        broadcasterName: event.broadcasterName,
        broadcasterDisplayName: event.broadcasterDisplayName,
        startedAt: event.startDate,
      };
      void handlers.onStreamOnline(normalized);
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
    // Scope the send to the bot user. Without this, twurple defaults the
    // sender to the broadcaster, whose token is minted without user:write:chat
    // (see authFlow resolveAuthTarget), so the Helix call throws a scope error.
    await api.asUser(botUserId, (ctx) =>
      ctx.chat.sendChatMessage(
        broadcasterId,
        text,
        replyToId ? { replyParentMessageId: replyToId } : undefined,
      ),
    );
  };

  return {
    broadcasterId: defaultBroadcasterId,
    broadcasterIds,
    sender,
    start: async () => {
      listener.start();
      logger.info({ broadcasters }, 'EventSub listener started');
    },
    stop: async () => {
      listener.stop();
    },
  };
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
