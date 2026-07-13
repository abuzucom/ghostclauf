export default {
  name: 'fixture-dup',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'fixture-dup-a',
      allow: ['everyone'],
      handler: async (event, ctx) => {
        await ctx.say('dup-a!');
      },
    });
  },
};
