import { describe, expect, it, vi } from 'vitest';
import followagePlugin from '../src/plugins/followage/index.js';
import type { ChatCommandEvent } from '../src/core/types.js';
import { makeHarness, makeMessage } from './helpers.js';

function makeFollowageEvent(
  chatterId: string,
  displayName: string,
  args: string[] = [],
  roles: string[] = ['everyone'],
): ChatCommandEvent {
  return {
    command: 'followage',
    args,
    argString: args.join(' '),
    messageId: 'msg-1',
    text: `!followage ${args.join(' ')}`.trim(),
    chatterId,
    chatterName: displayName.toLowerCase(),
    chatterDisplayName: displayName,
    badges: {},
    roles: new Set(roles as any),
    broadcasterId: 'b-1',
    broadcasterName: 'streamer',
  };
}

describe('followage plugin', () => {
  it('registers followage command', async () => {
    const { registry, ctx } = makeHarness('followage');
    await followagePlugin.init(ctx);
    expect(registry.match(makeMessage('!followage'))).not.toBeNull();
    expect(registry.size).toBe(1);
  });

  it('replies with follow age for a following user', async () => {
    const followedAt = new Date(Date.now() - 3600_000 * 24 * 10); // 10 days ago
    const getFollowAge = vi.fn().mockResolvedValue({ followedAt });
    const { registry, say, ctx } = makeHarness('followage', {}, { getFollowAge });

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('u-1', 'Alice'));

    expect(getFollowAge).toHaveBeenCalledWith('u-1', 'b-1');
    expect(say).toHaveBeenCalledWith(
      expect.stringMatching(/@Alice has been following for 10 days\./),
      'msg-1',
      'b-1',
    );
  });

  it('replies with not following if getFollowAge returns null', async () => {
    const getFollowAge = vi.fn().mockResolvedValue(null);
    const { registry, say, ctx } = makeHarness('followage', {}, { getFollowAge });

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('u-2', 'Bob'));

    expect(say).toHaveBeenCalledWith(
      '@Bob is not following this channel.',
      'msg-1',
      'b-1',
    );
  });

  it('allows mod to look up another user', async () => {
    const followedAt = new Date(Date.now() - 3600_000 * 48); // 2 days ago
    const getUserByLogin = vi.fn().mockResolvedValue({
      id: 'target-id',
      login: 'charlie',
      displayName: 'Charlie',
      lastGame: 'Just Chatting',
    });
    const getFollowAge = vi.fn().mockResolvedValue({ followedAt });

    const { registry, say, ctx } = makeHarness('followage', {}, { getUserByLogin, getFollowAge });

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('mod-1', 'ModUser', ['@charlie'], ['everyone', 'moderator']));

    expect(getUserByLogin).toHaveBeenCalledWith('charlie');
    expect(getFollowAge).toHaveBeenCalledWith('target-id', 'b-1');
    expect(say).toHaveBeenCalledWith(
      expect.stringMatching(/@Charlie has been following for 2 days\./),
      'msg-1',
      'b-1',
    );
  });

  it('denies third-party lookup for non-moderators', async () => {
    const { registry, say, ctx } = makeHarness('followage');

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('u-3', 'Dave', ['@charlie'], ['everyone']));

    expect(say).toHaveBeenCalledWith(
      'Only moderators can check followage for other viewers.',
      'msg-1',
      'b-1',
    );
  });

  it('handles target user not found', async () => {
    const getUserByLogin = vi.fn().mockResolvedValue(null);
    const { registry, say, ctx } = makeHarness('followage', {}, { getUserByLogin });

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('mod-1', 'ModUser', ['@unknown'], ['everyone', 'moderator']));

    expect(say).toHaveBeenCalledWith(
      'Could not find user @unknown.',
      'msg-1',
      'b-1',
    );
  });

  it('gracefully handles API errors', async () => {
    const getFollowAge = vi.fn().mockRejectedValue(new Error('Helix API down'));
    const { registry, say, ctx } = makeHarness('followage', {}, { getFollowAge });

    await followagePlugin.init(ctx);
    await registry.handle(makeFollowageEvent('u-4', 'Eve'));

    expect(say).toHaveBeenCalledWith(
      'Could not check follow age right now. Try again later.',
      'msg-1',
      'b-1',
    );
  });
});
