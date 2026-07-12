import type { Plugin } from '../../core/types.js';

/**
 * Replies "pong!" when a privileged chatter (broadcaster, moderator, VIP, or
 * subscriber) types `!ping`. Non-privileged viewers are ignored by the core's
 * permission gate.
 */
const plugin: Plugin = {
  name: 'ping',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'ping',
      allow: ['broadcaster', 'moderator', 'vip', 'subscriber'],
      description: 'Replies "pong!" to broadcaster/mods/VIPs/subscribers.',
      handler: async (event, ctx) => {
        await ctx.say('pong!', event.messageId);
      },
    });
  },
};

export default plugin;
