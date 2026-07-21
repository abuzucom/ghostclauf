import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';

export interface ShoutoutMessages {
  template: string;
  fallbackGame: string;
  not_found: string;
  no_target: string;
  error: string;
}

export interface ShoutoutConfig {
  template?: string;
  fallbackGame?: string;
  sendNativeShoutout?: boolean;
  messages?: Partial<ShoutoutMessages>;
}

const DEFAULT_TEMPLATE =
  'Go check out @{display} at twitch.tv/{channel}! They were last seen playing {game}.';
const DEFAULT_FALLBACK_GAME = 'something awesome';

const DEFAULT_MESSAGES: ShoutoutMessages = {
  template: DEFAULT_TEMPLATE,
  fallbackGame: DEFAULT_FALLBACK_GAME,
  not_found: 'Could not find Twitch user @{target}.',
  no_target: 'Usage: !so @channel',
  error: 'Shoutout failed. Try again.',
};

export function renderShoutoutMessage(
  template: string,
  tokens: { channel: string; display: string; game: string },
): string {
  return template
    .replaceAll('{channel}', tokens.channel)
    .replaceAll('{display}', tokens.display)
    .replaceAll('{game}', tokens.game);
}

const shoutoutPlugin: Plugin = {
  name: 'shoutout',
  version: '1.0.0',
  init(ctx: BotContext): void {
    const rawConfig = (ctx.config ?? {}) as ShoutoutConfig;
    const sendNativeShoutout = rawConfig.sendNativeShoutout ?? true;
    const fallbackGame = rawConfig.fallbackGame ?? DEFAULT_FALLBACK_GAME;

    const messages: ShoutoutMessages = {
      ...DEFAULT_MESSAGES,
      ...(rawConfig.messages ?? {}),
      template: rawConfig.template ?? rawConfig.messages?.template ?? DEFAULT_TEMPLATE,
      fallbackGame,
    };

    const handler = async (event: ChatCommandEvent) => {
      const isMod = event.roles.has('moderator') || event.roles.has('broadcaster');
      if (!isMod) {
        return; // Silently ignore non-mods for shoutout trigger
      }

      const targetInput = event.args[0]?.replace(/^@/, '').trim();
      if (!targetInput) {
        await ctx.say(messages.no_target, event.messageId, event.broadcasterId);
        return;
      }

      try {
        const targetUser = await ctx.helix.getUserByLogin(targetInput.toLowerCase());
        if (!targetUser) {
          await ctx.say(
            messages.not_found.replaceAll('{target}', targetInput),
            event.messageId,
            event.broadcasterId,
          );
          return;
        }

        const game = targetUser.lastGame || fallbackGame;
        const msg = renderShoutoutMessage(messages.template, {
          channel: targetUser.login,
          display: targetUser.displayName,
          game,
        });

        await ctx.say(msg, undefined, event.broadcasterId);

        if (sendNativeShoutout) {
          try {
            await ctx.helix.sendShoutout(
              event.broadcasterId,
              targetUser.id,
              event.broadcasterId,
            );
          } catch (nativeErr) {
            ctx.logger.warn(
              { err: nativeErr, targetId: targetUser.id, broadcasterId: event.broadcasterId },
              'Twitch native shoutout call failed or was rate limited',
            );
          }
        }
      } catch (err) {
        ctx.logger.error({ err, targetInput }, 'shoutout command failed');
        await ctx.say(messages.error, event.messageId, event.broadcasterId);
      }
    };

    ctx.command({
      trigger: 'so',
      allow: ['moderator', 'broadcaster'],
      description: 'Shoutout another streamer',
      handler,
    });

    ctx.command({
      trigger: 'shoutout',
      allow: ['moderator', 'broadcaster'],
      description: 'Shoutout another streamer (alias for !so)',
      handler,
    });
  },
};

export default shoutoutPlugin;
