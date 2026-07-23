// Public contract shared by the core and every plugin.
//
// Plugins depend ONLY on the types in this file — never on twurple or any other
// transport-specific package. The transport layer (see core/twitch.ts) is
// responsible for translating raw platform events into the normalized shapes
// below, which keeps the extensibility layer portable to future platforms.

import type { Logger as PinoLogger } from 'pino';

/** Structured logger handed to plugins (a pino logger under the hood). */
export type Logger = PinoLogger;

/** Roles a chatter can hold. `everyone` is always present. */
export type Role = 'everyone' | 'subscriber' | 'vip' | 'moderator' | 'broadcaster';

/** A normalized chat message, transport-agnostic. */
export interface ChatMessageEvent {
  /** Platform message id (used for replies). */
  messageId: string;
  /** Raw message text. */
  text: string;
  /** Chatter's user id. */
  chatterId: string;
  /** Chatter's login (lowercase username). */
  chatterName: string;
  /** Chatter's display name. */
  chatterDisplayName: string;
  /** Raw badge map (badge name -> version). */
  badges: Record<string, string>;
  /** Roles resolved from the badges. */
  roles: ReadonlySet<Role>;
  /** Channel owner's user id. */
  broadcasterId: string;
  /** Channel owner's login. */
  broadcasterName: string;
}

/** A normalized "stream went live" event. */
export interface StreamOnlineEvent {
  broadcasterId: string;
  broadcasterName: string;
  broadcasterDisplayName: string;
  /** Platform stream id, when supplied by the transport. */
  streamId?: string;
  /** True when the event was synthesized during live-state recovery. */
  recovered?: boolean;
  /** When the stream started (UTC instant). */
  startedAt: Date;
}

/** A normalized "stream went offline" event. */
export interface StreamOfflineEvent {
  broadcasterId: string;
  broadcasterName: string;
  broadcasterDisplayName: string;
  /** True when the event was synthesized during live-state recovery. */
  recovered?: boolean;
}

/** A chat message that matched a registered command, with parsed args. */
export interface ChatCommandEvent extends ChatMessageEvent {
  /** The matched trigger (lowercased, without the prefix). */
  command: string;
  /** Whitespace-separated tokens after the trigger. */
  args: string[];
  /** Everything after the trigger, trimmed. */
  argString: string;
}

/** Events plugins can subscribe to via `ctx.on(...)`. */
export interface BotEvents {
  chatMessage: ChatMessageEvent;
  streamOnline: StreamOnlineEvent;
  streamOffline: StreamOfflineEvent;
}

export type CommandHandler = (
  event: ChatCommandEvent,
  ctx: BotContext,
) => void | Promise<void>;

/** A command binding — the eggdrop "bind pub" equivalent. */
export interface CommandDefinition {
  /** Trigger word, without the command prefix (e.g. "pong"). */
  trigger: string;
  /** Roles permitted to invoke the command. Empty = nobody; include `everyone` for all. */
  allow: Role[];
  /** Optional human-readable description (for help/introspection). */
  description?: string;
  handler: CommandHandler;
}

/** Per-plugin configuration block from config.yaml (`plugins.config.<name>`). */
export type PluginConfig = Record<string, unknown>;

/** Sends a message to a channel; optionally as a reply to `replyToId`. */
export type MessageSender = (
  text: string,
  replyToId?: string,
  broadcasterId?: string,
) => Promise<void>;

/** A Twitch user summary returned by the Helix facade. */
export interface HelixUser {
  id: string;
  login: string;
  displayName: string;
  /** Last played category name. Null if the channel has no category set. */
  lastGame?: string | null;
}

/** Follow relationship details for a user in a channel. */
export interface FollowInfo {
  /** When the user followed the channel. */
  followedAt: Date;
}

/**
 * Narrow Helix API facade exposed to plugins via BotContext.
 * The real implementation lives in core/twitch.ts; tests inject a stub.
 */
export interface HelixClient {
  /** Resolve a login to a user, or null when it does not exist. */
  getUserByLogin(login: string): Promise<HelixUser | null>;
  /**
   * When `userId` follows `broadcasterId`, or null when not following.
   * `broadcasterId` must be a configured channel.
   */
  getFollowage(
    broadcasterId: string,
    userId: string,
  ): Promise<FollowInfo | null>;
  /**
   * Issue Twitch's native shoutout.
   * Requires moderator:manage:shoutouts scope on the broadcaster token.
   */
  sendShoutout(
    fromBroadcasterId: string,
    toBroadcasterId: string,
    moderatorId: string,
  ): Promise<void>;
}

/**
 * Narrow, transport-agnostic lookup surface backed by the platform API.
 * Kept minimal on purpose: plugins never see the underlying client.
 */
export interface HelixLookup {
  getUserByLogin(login: string): Promise<HelixUser | null>;
  /**
   * When `userId` follows `broadcasterId`, or null when not following.
   * `broadcasterId` must be a configured channel.
   */
  getFollowage(broadcasterId: string, userId: string): Promise<FollowInfo | null>;
}

/** The facade handed to each plugin's `init`. The only surface plugins touch. */
export interface BotContext {
  /** This plugin's config block (may be empty). */
  readonly config: PluginConfig;
  /** Logger scoped to this plugin. */
  readonly logger: Logger;
  /** Narrow Helix API client for plugins that need Twitch data lookups. */
  readonly helix: HelixClient;
  /** Post a message to a channel (optionally replying to a message id). */
  say(text: string, replyToId?: string, broadcasterId?: string): Promise<void>;
  /** Register a chat command. */
  command(def: CommandDefinition): void;
  /** Subscribe to a bot event. */
  on<E extends keyof BotEvents>(
    event: E,
    handler: (payload: BotEvents[E]) => void | Promise<void>,
  ): void;
}

/** A plugin module's default export. */
export interface Plugin {
  /** Unique plugin name; runs by default unless listed in `plugins.disabled`. */
  name: string;
  /** Semantic version string (informational). */
  version: string;
  /** Called once at startup to register bindings. */
  init(ctx: BotContext): void | Promise<void>;
}
