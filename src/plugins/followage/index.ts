// Followage plugin: !followage [@user] reports how long a viewer has been
// following the channel the command was typed in. Multi-channel aware: the
// broadcaster is taken from the invoking chat's event, so each channel
// answers for its own follower list.

import type { ChatCommandEvent, Logger, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { parseLogin } from '../../core/logins.js';
import {
  formatFollowDuration,
  LOOKUP_FAILED_MESSAGE,
  renderBroadcasterSelf,
  renderFollowage,
  renderNotFollowing,
  renderUnknownUser,
  USAGE_MESSAGE,
} from './followage.js';

const DEFAULT_COOLDOWN_SECONDS = 10;
const MAX_COOLDOWN_SECONDS = 3600;
const MS_PER_SECOND = 1000;

/** Resolve the per-chatter cooldown, bounding invalid config to the default. */
function resolveCooldownSeconds(configured: unknown, logger: Logger): number {
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

/**
 * Resolve who the lookup is about. Replies and returns null when the argument
 * is invalid or names an unknown user.
 */
async function resolveTarget(
  event: ChatCommandEvent,
  ctx: Parameters<Plugin['init']>[0],
): Promise<Target | null> {
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
  return user;
}

/**
 * Build the followage plugin. `now` is injectable so duration formatting and
 * cooldown timing are deterministically testable; production use relies on
 * the real clock.
 */
export function createFollowagePlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'followage',
    version: '1.0.0',
    init(ctx) {
      const cooldownSeconds = resolveCooldownSeconds(ctx.config.cooldownSeconds, ctx.logger);
      // Throttled repeats are dropped silently so a chat flood cannot burn
      // the shared Helix rate budget or be amplified with a reply per spam.
      const cooldown = new CooldownGate(cooldownSeconds * MS_PER_SECOND);

      ctx.command({
        trigger: 'followage',
        allow: ['everyone'],
        description: "Show how long you (or @user) have followed this channel.",
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
            const follow = await ctx.helix.getFollowage(event.broadcasterId, target.id);
            const text = follow
              ? renderFollowage(
                  target.displayName,
                  event.broadcasterName,
                  formatFollowDuration(follow.followedAt, now()),
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

const plugin = createFollowagePlugin();
export default plugin;
