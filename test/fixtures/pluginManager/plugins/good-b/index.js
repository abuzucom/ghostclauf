export default {
  name: 'fixture-good-b',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'fixture-b',
      allow: ['everyone'],
      handler: async (event, ctx) => {
        await ctx.say('b!');
      },
    });
  },
};
