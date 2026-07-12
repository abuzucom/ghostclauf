import { describe, expect, it } from 'vitest';
import pong from '../src/plugins/pong/index.js';
import type { Role } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

function setup() {
  const h = makeHarness('pong');
  pong.init(h.ctx);
  return h;
}

describe('pong plugin', () => {
  it('registers exactly one command', () => {
    const { registry } = setup();
    expect(registry.size).toBe(1);
  });

  it('replies "ping!" as a reply to the message for privileged chatters', async () => {
    for (const role of ['broadcaster', 'moderator', 'vip', 'subscriber'] as Role[]) {
      const { registry, say } = setup();
      await registry.handle(makeMessage('!pong', ['everyone', role]));
      expect(say).toHaveBeenCalledWith('ping!', 'msg-1');
    }
  });

  it('ignores a plain viewer', async () => {
    const { registry, say } = setup();
    await registry.handle(makeMessage('!pong', ['everyone']));
    expect(say).not.toHaveBeenCalled();
  });

  it('does not respond to other messages', async () => {
    const { registry, say } = setup();
    await registry.handle(makeMessage('pong', ['everyone', 'broadcaster']));
    await registry.handle(makeMessage('!ping', ['everyone', 'broadcaster']));
    expect(say).not.toHaveBeenCalled();
  });
});
