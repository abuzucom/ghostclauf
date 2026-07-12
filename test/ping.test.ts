import { describe, expect, it } from 'vitest';
import ping from '../src/plugins/ping/index.js';
import type { Role } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

function setup() {
  const h = makeHarness('ping');
  ping.init(h.ctx);
  return h;
}

describe('ping plugin', () => {
  it('registers exactly one command', () => {
    const { registry } = setup();
    expect(registry.size).toBe(1);
  });

  it('replies "pong!" as a reply to the message for privileged chatters', async () => {
    for (const role of ['broadcaster', 'moderator', 'vip', 'subscriber'] as Role[]) {
      const { registry, say } = setup();
      await registry.handle(makeMessage('!ping', ['everyone', role]));
      expect(say).toHaveBeenCalledWith('pong!', 'msg-1');
    }
  });

  it('ignores a plain viewer', async () => {
    const { registry, say } = setup();
    await registry.handle(makeMessage('!ping', ['everyone']));
    expect(say).not.toHaveBeenCalled();
  });

  it('does not respond to other messages', async () => {
    const { registry, say } = setup();
    await registry.handle(makeMessage('ping', ['everyone', 'broadcaster']));
    await registry.handle(makeMessage('!pong', ['everyone', 'broadcaster']));
    expect(say).not.toHaveBeenCalled();
  });
});
