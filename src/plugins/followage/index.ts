// Followage plugin: !followage [@user] reports how long a viewer has been
// following the channel the command was typed in. Multi-channel aware: the
// broadcaster is taken from the invoking chat's event, so each channel
// answers for its own follower list.

import type { ChatCommandEvent, Plugin } from '../../core/types.js';
import {
  formatFollowDuration,
  LOOKUP_FAILED_MESSAGE,
  renderBroadcasterSelf,
  renderFollowage,
  renderNotFollowing,
  renderUnknownUser,
  USAGE_MESSAGE,
} from './followage.js';

/** Twitch logins are 1-25 chars of letters, digits, and underscores. */
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;

/** Parse an optional "@login" argument into a validated lowercase login. */
function parseLogin(token: string | undefined): string | null {
  if (!token) return null;
  const login = token.replace(/^@/, '').toLowerCase();
  return LOGIN_PATTERN.test(login) ? login : null;
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
 * Build the followage plugin. `now` is injectable so duration formatting is
 * deterministically testable; production use relies on the real clock.
 */
export function createFollowagePlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'followage',
    version: '1.0.0',
    init(ctx) {
      ctx.command({
        trigger: 'followage',
        allow: ['everyone'],
        description: "Show how long you (or @user) have followed this channel.",
        handler: async (event) => {
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
