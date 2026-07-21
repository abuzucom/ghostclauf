// Lurk plugin: !lurk / !unlurk chat acknowledgements. State is per plugin
// instance and per channel, so lurking in one configured channel never leaks
// into another.

import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';

export interface LurkMessages {
  lurk: string;
  already_lurking: string;
  unlurk: string;
  unlurk_unknown: string;
}

export interface LurkConfig {
  cooldownSeconds?: number;
  messages?: Partial<LurkMessages>;
}

const DEFAULT_MESSAGES: LurkMessages = {
  lurk: 'Thanks for the lurk, @{user}! We see you.',
  already_lurking: '@{user} is already lurking — we definitely see you.',
  unlurk: 'Welcome back, @{user}!',
  unlurk_unknown: 'Welcome, @{user}!',
};

const DEFAULT_COOLDOWN_SECONDS = 10;
const MAX_COOLDOWN_SECONDS = 3600;
const MS_PER_SECOND = 1000;
/** Bound on tracked lurkers before the oldest entries are evicted. */
const LURKER_ENTRY_LIMIT = 10_000;

export function renderLurkMessage(template: string, user: string): string {
  return template.replaceAll('{user}', user);
}

/** Resolve the shared reply cooldown, bounding invalid config to the default. */
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
  logger.warn({ configured }, 'invalid lurk cooldownSeconds; falling back to default');
  return DEFAULT_COOLDOWN_SECONDS;
}

/** Evict oldest insertions so the lurker map stays bounded under churn. */
function capLurkers(lurkers: Map<string, string>): void {
  while (lurkers.size > LURKER_ENTRY_LIMIT) {
    const oldest = lurkers.keys().next().value;
    if (oldest === undefined) return;
    lurkers.delete(oldest);
  }
}

/**
 * Build the lurk plugin. `now` is injectable so cooldown timing is
 * deterministically testable; production use relies on the real clock.
 */
export function createLurkPlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'lurk',
    version: '1.0.0',
    init(ctx: BotContext): void {
      const rawConfig = (ctx.config ?? {}) as LurkConfig;
      const messages: LurkMessages = {
        ...DEFAULT_MESSAGES,
        ...(rawConfig.messages ?? {}),
      };
      const cooldownSeconds = resolveCooldownSeconds(rawConfig.cooldownSeconds, ctx.logger);
      // Keyed per command so a quick lurk-then-unlurk still works; repeats of
      // the same command are dropped silently so a chat flood cannot be
      // amplified with a reply per spam message.
      const cooldown = new CooldownGate(cooldownSeconds * MS_PER_SECOND);
      // "<broadcasterId>:<chatterId>" -> chatterDisplayName
      const lurkers = new Map<string, string>();

      ctx.command({
        trigger: 'lurk',
        allow: ['everyone'],
        description: 'Announce that you are lurking in chat',
        handler: async (event: ChatCommandEvent) => {
          if (event.roles.has('broadcaster')) {
            return;
          }
          const key = `${event.broadcasterId}:${event.chatterId}`;
          if (cooldown.shouldThrottle(`lurk:${key}`, now().getTime())) return;

          if (lurkers.has(key)) {
            await ctx.say(
              renderLurkMessage(messages.already_lurking, event.chatterDisplayName),
              event.messageId,
              event.broadcasterId,
            );
            return;
          }

          lurkers.set(key, event.chatterDisplayName);
          capLurkers(lurkers);
          await ctx.say(
            renderLurkMessage(messages.lurk, event.chatterDisplayName),
            event.messageId,
            event.broadcasterId,
          );
        },
      });

      ctx.command({
        trigger: 'unlurk',
        allow: ['everyone'],
        description: 'Announce that you have returned from lurking',
        handler: async (event: ChatCommandEvent) => {
          if (event.roles.has('broadcaster')) {
            return;
          }
          const key = `${event.broadcasterId}:${event.chatterId}`;
          if (cooldown.shouldThrottle(`unlurk:${key}`, now().getTime())) return;

          const wasLurking = lurkers.delete(key);
          const template = wasLurking ? messages.unlurk : messages.unlurk_unknown;
          await ctx.say(
            renderLurkMessage(template, event.chatterDisplayName),
            event.messageId,
            event.broadcasterId,
          );
        },
      });
    },
  };
}

const plugin = createLurkPlugin();
export default plugin;
