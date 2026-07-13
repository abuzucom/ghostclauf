export default {
  name: 'fixture-throws-init',
  version: '1.0.0',
  init() {
    throw new Error('init boom');
  },
};
