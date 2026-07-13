export default {
  name: 'fixture-good-a',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'fixture-a',
      allow: ['everyone'],
      handler: async (event, ctx) => {
        await ctx.say('a!');
      },
    });
  },
};
