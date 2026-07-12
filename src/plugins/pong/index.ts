import type { Plugin } from '../../core/types.js';

/**
 * Replies "ping!" when a privileged chatter (broadcaster, moderator, VIP, or
 * subscriber) types `!pong`. Non-privileged viewers are ignored by the core's
 * permission gate.
 */
const plugin: Plugin = {
  name: 'pong',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'pong',
      allow: ['broadcaster', 'moderator', 'vip', 'subscriber'],
      description: 'Replies "ping!" to broadcaster/mods/VIPs/subscribers.',
      handler: async (event, ctx) => {
        await ctx.say('ping!', event.messageId);
      },
    });
  },
};

export default plugin;
