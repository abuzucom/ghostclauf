import { describe, expect, it } from 'vitest';
import lurkPlugin from '../src/plugins/lurk/index.js';
import type { ChatCommandEvent } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

function makeEvent(
  chatterId: string,
  displayName: string,
  roles: string[] = ['everyone'],
): ChatCommandEvent {
  return {
    command: 'lurk',
    args: [],
    argString: '',
    messageId: 'msg-1',
    text: '!lurk',
    chatterId,
    chatterName: displayName.toLowerCase(),
    chatterDisplayName: displayName,
    badges: {},
    roles: new Set(roles as any),
    broadcasterId: 'b-1',
    broadcasterName: 'streamer',
  };
}

describe('lurk plugin', () => {
  it('registers lurk and unlurk commands', async () => {
    const { registry, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);
    expect(registry.match(makeMessage('!lurk'))).not.toBeNull();
    expect(registry.match(makeMessage('!unlurk'))).not.toBeNull();
    expect(registry.size).toBe(2);
  });

  it('acknowledges lurk and stores viewer', async () => {
    const { registry, say, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);

    await registry.handle(makeEvent('u-1', 'Alice'));

    expect(say).toHaveBeenCalledWith(
      'Thanks for the lurk, @Alice! We see you.',
      'msg-1',
      'b-1',
    );
  });

  it('warns on second lurk attempt', async () => {
    const { registry, say, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);

    await registry.handle(makeEvent('u-2', 'Bob'));
    await registry.handle(makeEvent('u-2', 'Bob'));

    expect(say).toHaveBeenLastCalledWith(
      '@Bob is already lurking — we definitely see you.',
      'msg-1',
      'b-1',
    );
  });

  it('welcomes back on unlurk after lurk', async () => {
    const { registry, say, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);

    await registry.handle(makeEvent('u-3', 'Charlie'));
    const unlurkEvt = { ...makeEvent('u-3', 'Charlie'), command: 'unlurk', text: '!unlurk' };
    await registry.handle(unlurkEvt);

    expect(say).toHaveBeenLastCalledWith(
      'Welcome back, @Charlie!',
      'msg-1',
      'b-1',
    );
  });

  it('welcomes viewer even if they never typed !lurk', async () => {
    const { registry, say, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);

    const unlurkEvt = { ...makeEvent('u-4', 'Dave'), command: 'unlurk', text: '!unlurk' };
    await registry.handle(unlurkEvt);

    expect(say).toHaveBeenCalledWith(
      'Welcome, @Dave!',
      'msg-1',
      'b-1',
    );
  });

  it('suppresses lurk and unlurk for broadcaster', async () => {
    const { registry, say, ctx } = makeHarness('lurk');
    await lurkPlugin.init(ctx);

    const broadEvtLurk = makeEvent('b-1', 'Streamer', ['everyone', 'broadcaster']);
    await registry.handle(broadEvtLurk);
    expect(say).not.toHaveBeenCalled();

    const broadEvtUnlurk = {
      ...makeEvent('b-1', 'Streamer', ['everyone', 'broadcaster']),
      command: 'unlurk',
      text: '!unlurk',
    };
    await registry.handle(broadEvtUnlurk);
    expect(say).not.toHaveBeenCalled();
  });
});
