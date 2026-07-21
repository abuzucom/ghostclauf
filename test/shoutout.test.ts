import { describe, expect, it, vi } from 'vitest';
import shoutoutPlugin from '../src/plugins/shoutout/index.js';
import type { ChatCommandEvent } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

function makeSoEvent(
  chatterId: string,
  displayName: string,
  args: string[] = [],
  roles: string[] = ['everyone', 'moderator'],
): ChatCommandEvent {
  return {
    command: 'so',
    args,
    argString: args.join(' '),
    messageId: 'msg-1',
    text: `!so ${args.join(' ')}`.trim(),
    chatterId,
    chatterName: displayName.toLowerCase(),
    chatterDisplayName: displayName,
    badges: {},
    roles: new Set(roles as any),
    broadcasterId: 'b-1',
    broadcasterName: 'streamer',
  };
}

describe('shoutout plugin', () => {
  it('registers so and shoutout commands', async () => {
    const { registry, ctx } = makeHarness('shoutout');
    await shoutoutPlugin.init(ctx);
    expect(registry.match(makeMessage('!so'))).not.toBeNull();
    expect(registry.match(makeMessage('!shoutout'))).not.toBeNull();
    expect(registry.size).toBe(2);
  });

  it('shouts out a streamer with last game and fires native shoutout', async () => {
    const getUserByLogin = vi.fn().mockResolvedValue({
      id: 'target-123',
      login: 'dj1a2n',
      displayName: 'DJ1A2N',
      lastGame: 'Music',
    });
    const sendShoutout = vi.fn().mockResolvedValue(undefined);

    const { registry, say, ctx } = makeHarness('shoutout', {}, { getUserByLogin, sendShoutout });

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('m-1', 'Mod1', ['@dj1a2n']));

    expect(getUserByLogin).toHaveBeenCalledWith('dj1a2n');
    expect(say).toHaveBeenCalledWith(
      'Go check out @DJ1A2N at twitch.tv/dj1a2n! They were last seen playing Music.',
      undefined,
      'b-1',
    );
    expect(sendShoutout).toHaveBeenCalledWith('b-1', 'target-123', 'b-1');
  });

  it('uses fallback game if target lastGame is null', async () => {
    const getUserByLogin = vi.fn().mockResolvedValue({
      id: 'target-456',
      login: 'newstreamer',
      displayName: 'NewStreamer',
      lastGame: null,
    });
    const { registry, say, ctx } = makeHarness('shoutout', {}, { getUserByLogin });

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('m-1', 'Mod1', ['newstreamer']));

    expect(say).toHaveBeenCalledWith(
      'Go check out @NewStreamer at twitch.tv/newstreamer! They were last seen playing something awesome.',
      undefined,
      'b-1',
    );
  });

  it('replies with usage hint if no argument provided', async () => {
    const { registry, say, ctx } = makeHarness('shoutout');

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('m-1', 'Mod1', []));

    expect(say).toHaveBeenCalledWith('Usage: !so @channel', 'msg-1', 'b-1');
  });

  it('replies with not found if target streamer is not found', async () => {
    const getUserByLogin = vi.fn().mockResolvedValue(null);
    const { registry, say, ctx } = makeHarness('shoutout', {}, { getUserByLogin });

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('m-1', 'Mod1', ['@nonexistent']));

    expect(say).toHaveBeenCalledWith(
      'Could not find Twitch user @nonexistent.',
      'msg-1',
      'b-1',
    );
  });

  it('swallows error if native shoutout fails but chat message still succeeds', async () => {
    const getUserByLogin = vi.fn().mockResolvedValue({
      id: 'target-789',
      login: 'cooldownuser',
      displayName: 'CooldownUser',
      lastGame: 'VALORANT',
    });
    const sendShoutout = vi.fn().mockRejectedValue(new Error('Rate limited 429'));

    const { registry, say, ctx } = makeHarness('shoutout', {}, { getUserByLogin, sendShoutout });

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('m-1', 'Mod1', ['cooldownuser']));

    expect(say).toHaveBeenCalledWith(
      'Go check out @CooldownUser at twitch.tv/cooldownuser! They were last seen playing VALORANT.',
      undefined,
      'b-1',
    );
  });

  it('silently ignores non-moderator callers', async () => {
    const { registry, say, ctx } = makeHarness('shoutout');

    await shoutoutPlugin.init(ctx);
    await registry.handle(makeSoEvent('u-1', 'RegularUser', ['@someone'], ['everyone']));

    expect(say).not.toHaveBeenCalled();
  });
});
