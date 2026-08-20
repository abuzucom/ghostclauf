export default {
  name: 'fixture-throws-init',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'partial-command',
      allow: ['everyone'],
      handler() {},
    });
    ctx.on('chatMessage', () => {
      ctx.command({
        trigger: 'partial-listener-command',
        allow: ['everyone'],
        handler() {},
      });
    });
    throw new Error('init boom');
  },
};
