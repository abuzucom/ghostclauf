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
  broadcasterLogin: string;
  logger: Logger;
  handlers: TransportHandlers;
}

export interface TwitchTransport {
  broadcasterId: string;
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
  const { authProvider, botUserId, broadcasterLogin, logger, handlers } = opts;

  const api = new ApiClient({ authProvider });

  const broadcaster = await api.users.getUserByName(broadcasterLogin);
  if (!broadcaster) {
    throw new Error(`broadcaster "${broadcasterLogin}" not found on Twitch`);
  }
  const broadcasterId = broadcaster.id;

  const listener = new EventSubWsListener({ apiClient: api });

  // Chat messages → normalize (resolve roles) → handler.
  listener.onChannelChatMessage(broadcasterId, botUserId, (event) => {
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

  // Stream went live.
  listener.onStreamOnline(broadcasterId, (event) => {
    const normalized: StreamOnlineEvent = {
      broadcasterId: event.broadcasterId,
      broadcasterName: event.broadcasterName,
      broadcasterDisplayName: event.broadcasterDisplayName,
      startedAt: event.startDate,
    };
    void handlers.onStreamOnline(normalized);
  });

  const sender: MessageSender = async (text, replyToId) => {
    await api.chat.sendChatMessage(
      broadcasterId,
      text,
      replyToId ? { replyParentMessageId: replyToId } : undefined,
    );
  };

  return {
    broadcasterId,
    sender,
    start: async () => {
      listener.start();
      logger.info({ broadcaster: broadcasterLogin, broadcasterId }, 'EventSub listener started');
    },
    stop: async () => {
      listener.stop();
    },
  };
}
