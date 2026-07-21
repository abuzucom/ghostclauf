import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { parseLogin } from '../../core/logins.js';
import {
  formatFollowDuration as formatModernFollowDuration,
  LOOKUP_FAILED_MESSAGE,
  renderBroadcasterSelf,
  renderFollowage,
  renderNotFollowing,
  renderUnknownUser,
  USAGE_MESSAGE,
} from './followage.js';
import { formatFollowDuration as formatLegacyFollowDuration } from './duration.js';

const DEFAULT_COOLDOWN_SECONDS = 10;
const MAX_COOLDOWN_SECONDS = 3600;
const MS_PER_SECOND = 1000;

export interface FollowageMessages {
  following: string;
  not_following: string;
  lookup_following: string;
  lookup_not_following: string;
  lookup_not_found: string;
  lookup_denied: string;
  error: string;
}

export interface FollowageConfig {
  messages?: Partial<FollowageMessages>;
}

const DEFAULT_MESSAGES: FollowageMessages = {
  following: '@{user} has been following for {duration}.',
  not_following: '@{user} is not following this channel.',
  lookup_following: '@{target} has been following for {duration}.',
  lookup_not_following: '@{target} is not following this channel.',
  lookup_not_found: 'Could not find user @{target}.',
  lookup_denied: 'Only moderators can check followage for other viewers.',
  error: 'Could not check follow age right now. Try again later.',
};

export function renderFollowageMessage(
  template: string,
  tokens: { user?: string; target?: string; duration?: string },
): string {
  return template
    .replaceAll('{user}', tokens.user ?? '')
    .replaceAll('{target}', tokens.target ?? '')
    .replaceAll('{duration}', tokens.duration ?? '');
}

function resolveCooldownSeconds(configured: unknown, logger: BotContext['logger']): number {
  if (configured === undefined) return DEFAULT_COOLDOWN_SECONDS;
  if (
    typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured >= 0 &&
    configured <= MAX_COOLDOWN_SECONDS
  ) {
    return configured;
  }
  logger.warn({ configured }, 'invalid followage cooldownSeconds; falling back to default');
  return DEFAULT_COOLDOWN_SECONDS;
}

interface Target {
  id: string;
  displayName: string;
}

async function resolveTarget(event: ChatCommandEvent, ctx: BotContext): Promise<Target | null> {
  if (!event.args.length) {
    return { id: event.chatterId, displayName: event.chatterDisplayName };
  }
  const login = parseLogin(event.args[0]);
  if (!login) {
    await ctx.say(USAGE_MESSAGE, event.messageId, event.broadcasterId);
    return null;
  }
  const user = await ctx.helix.getUserByLogin(login);
  if (!user) {
    await ctx.say(renderUnknownUser(login), event.messageId, event.broadcasterId);
    return null;
  }
  return { id: user.id, displayName: user.displayName };
}

/** Build the current cooldown-aware followage implementation. */
export function createFollowagePlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'followage',
    version: '1.0.0',
    init(ctx): void {
      const cooldownSeconds = resolveCooldownSeconds(ctx.config.cooldownSeconds, ctx.logger);
      const cooldown = new CooldownGate(cooldownSeconds * MS_PER_SECOND);

      ctx.command({
        trigger: 'followage',
        allow: ['everyone'],
        description: 'Show how long you (or @user) have followed this channel.',
        handler: async (event) => {
          const cooldownKey = `${event.broadcasterId}:${event.chatterId}`;
          if (cooldown.shouldThrottle(cooldownKey, now().getTime())) return;
          try {
            const target = await resolveTarget(event, ctx);
            if (!target) return;
            if (target.id === event.broadcasterId) {
              await ctx.say(
                renderBroadcasterSelf(event.broadcasterName),
                event.messageId,
                event.broadcasterId,
              );
              return;
            }
            const getFollowage = ctx.helix.getFollowage;
            if (!getFollowage) throw new Error('followage lookup is not available');
            const follow = await getFollowage(event.broadcasterId, target.id);
            const text = follow
              ? renderFollowage(
                  target.displayName,
                  event.broadcasterName,
                  formatModernFollowDuration(follow.followedAt, now()),
                )
              : renderNotFollowing(target.displayName, event.broadcasterName);
            await ctx.say(text, event.messageId, event.broadcasterId);
          } catch (err) {
            ctx.logger.error({ err }, 'followage lookup failed');
            await ctx.say(LOOKUP_FAILED_MESSAGE, event.messageId, event.broadcasterId);
          }
        },
      });
    },
  };
}

function createLegacyFollowagePlugin(): Plugin {
  return {
    name: 'followage',
    version: '1.0.0',
    init(ctx: BotContext): void {
      const rawConfig = (ctx.config ?? {}) as FollowageConfig;
      const messages: FollowageMessages = {
        ...DEFAULT_MESSAGES,
        ...(rawConfig.messages ?? {}),
      };

      ctx.command({
        trigger: 'followage',
        allow: ['everyone'],
        description: 'Check how long you (or another user) have been following the channel',
        handler: async (event: ChatCommandEvent) => {
          const targetInput = event.args[0]?.replace(/^@/, '').trim();
          const getFollowAge = ctx.helix.getFollowAge;
          if (!getFollowAge) {
            await ctx.say(messages.error, event.messageId, event.broadcasterId);
            return;
          }

          if (!targetInput) {
            try {
              const followInfo = await getFollowAge(event.chatterId, event.broadcasterId);
              if (!followInfo) {
                await ctx.say(
                  renderFollowageMessage(messages.not_following, {
                    user: event.chatterDisplayName,
                  }),
                  event.messageId,
                  event.broadcasterId,
                );
                return;
              }
              await ctx.say(
                renderFollowageMessage(messages.following, {
                  user: event.chatterDisplayName,
                  duration: formatLegacyFollowDuration(followInfo.followedAt),
                }),
                event.messageId,
                event.broadcasterId,
              );
            } catch (err) {
              ctx.logger.error({ err, chatterId: event.chatterId }, 'followage lookup failed');
              await ctx.say(messages.error, event.messageId, event.broadcasterId);
            }
            return;
          }

          const isMod = event.roles.has('moderator') || event.roles.has('broadcaster');
          if (!isMod) {
            await ctx.say(messages.lookup_denied, event.messageId, event.broadcasterId);
            return;
          }

          try {
            const targetUser = await ctx.helix.getUserByLogin(targetInput.toLowerCase());
            if (!targetUser) {
              await ctx.say(
                renderFollowageMessage(messages.lookup_not_found, { target: targetInput }),
                event.messageId,
                event.broadcasterId,
              );
              return;
            }
            const followInfo = await getFollowAge(targetUser.id, event.broadcasterId);
            if (!followInfo) {
              await ctx.say(
                renderFollowageMessage(messages.lookup_not_following, {
                  target: targetUser.displayName,
                }),
                event.messageId,
                event.broadcasterId,
              );
              return;
            }
            await ctx.say(
              renderFollowageMessage(messages.lookup_following, {
                target: targetUser.displayName,
                duration: formatLegacyFollowDuration(followInfo.followedAt),
              }),
              event.messageId,
              event.broadcasterId,
            );
          } catch (err) {
            ctx.logger.error({ err, targetInput }, 'followage lookup for target failed');
            await ctx.say(messages.error, event.messageId, event.broadcasterId);
          }
        },
      });
    },
  };
}

const followagePlugin: Plugin = {
  name: 'followage',
  version: '1.0.0',
  init(ctx): void | Promise<void> {
    if (ctx.helix.getFollowage) return createFollowagePlugin().init(ctx);
    return createLegacyFollowagePlugin().init(ctx);
  },
};

export default followagePlugin;
