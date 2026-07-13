export default {
  name: 'fixture-dup',
  version: '2.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'fixture-dup-b',
      allow: ['everyone'],
      handler: async (event, ctx) => {
        await ctx.say('dup-b!');
      },
    });
  },
};
