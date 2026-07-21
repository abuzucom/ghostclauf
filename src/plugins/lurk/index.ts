import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';

export interface LurkMessages {
  lurk: string;
  already_lurking: string;
  unlurk: string;
  unlurk_unknown: string;
}

export interface LurkConfig {
  messages?: Partial<LurkMessages>;
}

const DEFAULT_MESSAGES: LurkMessages = {
  lurk: 'Thanks for the lurk, @{user}! We see you.',
  already_lurking: '@{user} is already lurking — we definitely see you.',
  unlurk: 'Welcome back, @{user}!',
  unlurk_unknown: 'Welcome, @{user}!',
};

export function renderLurkMessage(template: string, user: string): string {
  return template.replaceAll('{user}', user);
}

const lurkers = new Map<string, string>(); // chatterId -> chatterDisplayName

const lurkPlugin: Plugin = {
  name: 'lurk',
  version: '1.0.0',
  init(ctx: BotContext): void {
    const rawConfig = (ctx.config ?? {}) as LurkConfig;
    const messages: LurkMessages = {
      ...DEFAULT_MESSAGES,
      ...(rawConfig.messages ?? {}),
    };

    ctx.command({
      trigger: 'lurk',
      allow: ['everyone'],
      description: 'Announce that you are lurking in chat',
      handler: async (event: ChatCommandEvent) => {
        if (event.roles.has('broadcaster')) {
          return;
        }

        const isLurking = lurkers.has(event.chatterId);
        if (isLurking) {
          await ctx.say(
            renderLurkMessage(messages.already_lurking, event.chatterDisplayName),
            event.messageId,
            event.broadcasterId,
          );
          return;
        }

        lurkers.set(event.chatterId, event.chatterDisplayName);
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

        const wasLurking = lurkers.delete(event.chatterId);
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

export default lurkPlugin;
