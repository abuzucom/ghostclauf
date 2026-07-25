// Ping plugin: !ping replies "pong!" for everyone, but throttled per chatter
// per channel so the command cannot be spammed. Broadcasters (and configured
// cross-channel moderators, see below) are exempt from the cooldown.

import type { BotContext, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { LOGIN_PATTERN } from '../../core/logins.js';

const MODERATOR_COOLDOWN_MS = 5 * 60 * 1000;
const VIEWER_COOLDOWN_MS = 15 * 60 * 1000;

export interface PingConfig {
  /**
   * Broadcaster login (any case) -> chatter logins (any case) to treat as
   * broadcaster-tier (unlimited !ping, no cooldown) on that channel, despite
   * their actual Twitch role there. For streamers who moderate each other's
   * channels.
   */
  treatAsBroadcaster?: Record<string, string[]>;
}

/**
 * Build the lookup table for the cross-channel broadcaster exception. Keys
 * and values are lowercased Twitch logins; `Map`/`Set` are used instead of a
 * plain object so a chatter or channel login can never be interpreted as an
 * inherited `Object.prototype` member (e.g. "constructor").
 */
function buildElevationMap(config: PingConfig): Map<string, Set<string>> {
  const entries = Object.entries(config.treatAsBroadcaster ?? {});
  return new Map(
    entries.map(([broadcasterLogin, chatterLogins]) => [
      broadcasterLogin.toLowerCase(),
      new Set(chatterLogins.map((login) => login.toLowerCase())),
    ]),
  );
}

function isElevated(
  elevationMap: Map<string, Set<string>>,
  broadcasterName: string,
  chatterName: string,
): boolean {
  if (!LOGIN_PATTERN.test(broadcasterName) || !LOGIN_PATTERN.test(chatterName)) return false;
  return elevationMap.get(broadcasterName)?.has(chatterName) ?? false;
}

/**
 * Build the ping plugin. `now` is injectable so cooldown timing is
 * deterministically testable; production use relies on the real clock.
 */
export function createPingPlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'ping',
    version: '2.0.0',
    init(ctx: BotContext): void {
      const config = (ctx.config ?? {}) as PingConfig;
      const elevationMap = buildElevationMap(config);
      const moderatorCooldown = new CooldownGate(MODERATOR_COOLDOWN_MS);
      const viewerCooldown = new CooldownGate(VIEWER_COOLDOWN_MS);

      ctx.command({
        trigger: 'ping',
        allow: ['everyone'],
        description: 'Replies "pong!" (rate-limited for non-broadcasters).',
        handler: async (event, ctx) => {
          const elevated = isElevated(elevationMap, event.broadcasterName, event.chatterName);
          if (!event.roles.has('broadcaster') && !elevated) {
            const key = `${event.broadcasterId}:${event.chatterId}`;
            const cooldown = event.roles.has('moderator') ? moderatorCooldown : viewerCooldown;
            if (cooldown.shouldThrottle(key, now().getTime())) return;
          }
          await ctx.say('pong!', event.messageId, event.broadcasterId);
        },
      });
    },
  };
}

const plugin = createPingPlugin();
export default plugin;
