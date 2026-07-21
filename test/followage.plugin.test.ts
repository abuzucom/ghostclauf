import { describe, expect, it, vi } from 'vitest';
import { createFollowagePlugin } from '../src/plugins/followage/index.js';
import type { HelixLookup } from '../src/core/types.js';
import { makeHarness, makeMessage, makeSpyLogger } from './helpers.js';
import { createContext } from '../src/core/context.js';
import { CommandRegistry } from '../src/core/commands.js';
import { EventBus } from '../src/core/eventBus.js';
import { spySender, testLogger } from './helpers.js';

const NOW = new Date('2026-07-21T12:00:00Z');
const FOLLOWED_AT = new Date('2023-05-10T12:00:00Z');

function fakeHelix(overrides: Partial<HelixLookup> = {}): HelixLookup {
  return {
    getUserByLogin: vi.fn(async () => ({ id: '200', displayName: 'OtherViewer' })),
    getFollowage: vi.fn(async () => ({ followedAt: FOLLOWED_AT })),
    ...overrides,
  };
}

function setup(helix: HelixLookup) {
  const h = makeHarness('followage', {}, helix);
  const plugin = createFollowagePlugin(() => NOW);
  return { ...h, plugin };
}

describe('followage plugin', () => {
  it('reports the caller followage in the channel it was asked in', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage'));
    expect(helix.getFollowage).toHaveBeenCalledWith('1', '100');
    expect(say).toHaveBeenCalledWith(
      'Viewer has been following streamer for 3 years, 2 months.',
      'msg-1',
      '1',
    );
  });

  it('answers per-channel using the broadcaster of the invoking chat', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(
      makeMessage('!followage', ['everyone'], {
        broadcasterId: '2',
        broadcasterName: 'dj1a2n',
      }),
    );
    expect(helix.getFollowage).toHaveBeenCalledWith('2', '100');
    expect(say).toHaveBeenCalledWith(
      'Viewer has been following dj1a2n for 3 years, 2 months.',
      'msg-1',
      '2',
    );
  });

  it('looks up another user by @mention', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage @OtherViewer'));
    expect(helix.getUserByLogin).toHaveBeenCalledWith('otherviewer');
    expect(helix.getFollowage).toHaveBeenCalledWith('1', '200');
    expect(say).toHaveBeenCalledWith(
      'OtherViewer has been following streamer for 3 years, 2 months.',
      'msg-1',
      '1',
    );
  });

  it('reports when the target is not following', async () => {
    const helix = fakeHelix({ getFollowage: vi.fn(async () => null) });
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage'));
    expect(say).toHaveBeenCalledWith('Viewer is not following streamer.', 'msg-1', '1');
  });

  it('reports an unknown @user without calling the follow lookup', async () => {
    const helix = fakeHelix({ getUserByLogin: vi.fn(async () => null) });
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage @ghost_404'));
    expect(say).toHaveBeenCalledWith(
      'No Twitch user named "ghost_404" was found.',
      'msg-1',
      '1',
    );
    expect(helix.getFollowage).not.toHaveBeenCalled();
  });

  it('rejects an invalid login argument with usage', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage @not/valid!'));
    expect(say).toHaveBeenCalledWith('Usage: !followage [@user]', 'msg-1', '1');
    expect(helix.getUserByLogin).not.toHaveBeenCalled();
  });

  it('short-circuits when the broadcaster asks about themselves', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(
      makeMessage('!followage', ['everyone', 'broadcaster'], {
        chatterId: '1',
        chatterName: 'streamer',
        chatterDisplayName: 'Streamer',
      }),
    );
    expect(say).toHaveBeenCalledWith(
      "streamer can't follow their own channel.",
      'msg-1',
      '1',
    );
    expect(helix.getFollowage).not.toHaveBeenCalled();
  });

  it('short-circuits when the @mention targets the broadcaster', async () => {
    const helix = fakeHelix({
      getUserByLogin: vi.fn(async () => ({ id: '1', displayName: 'Streamer' })),
    });
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage @streamer'));
    expect(say).toHaveBeenCalledWith(
      "streamer can't follow their own channel.",
      'msg-1',
      '1',
    );
    expect(helix.getFollowage).not.toHaveBeenCalled();
  });

  it('silently drops repeat invocations inside the cooldown window', async () => {
    const helix = fakeHelix();
    let now = NOW;
    const h = makeHarness('followage', {}, helix);
    const plugin = createFollowagePlugin(() => now);
    await plugin.init(h.ctx);

    await h.registry.handle(makeMessage('!followage'));
    await h.registry.handle(makeMessage('!followage'));
    expect(h.say).toHaveBeenCalledTimes(1);
    expect(helix.getFollowage).toHaveBeenCalledTimes(1);

    now = new Date(NOW.getTime() + 10_000);
    await h.registry.handle(makeMessage('!followage'));
    expect(h.say).toHaveBeenCalledTimes(2);
  });

  it('cooldowns are per chatter and per channel', async () => {
    const helix = fakeHelix();
    const { ctx, registry, say, plugin } = setup(helix);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage'));
    await registry.handle(makeMessage('!followage', ['everyone'], { chatterId: '300' }));
    await registry.handle(makeMessage('!followage', ['everyone'], { broadcasterId: '2' }));
    expect(say).toHaveBeenCalledTimes(3);
  });

  it('disables the cooldown when configured to zero', async () => {
    const helix = fakeHelix();
    const h = makeHarness('followage', { cooldownSeconds: 0 }, helix);
    const plugin = createFollowagePlugin(() => NOW);
    await plugin.init(h.ctx);

    await h.registry.handle(makeMessage('!followage'));
    await h.registry.handle(makeMessage('!followage'));
    expect(h.say).toHaveBeenCalledTimes(2);
  });

  it('logs and replies gracefully when the Helix lookup fails', async () => {
    const helix = fakeHelix({
      getFollowage: vi.fn(async () => {
        throw new Error('helix down');
      }),
    });
    const spy = makeSpyLogger();
    const registry = new CommandRegistry('!', testLogger);
    const bus = new EventBus(testLogger);
    const say = spySender();
    const ctx = createContext({
      pluginName: 'followage',
      config: {},
      logger: spy.logger,
      bus,
      registry,
      sender: say,
      helix,
    });
    const plugin = createFollowagePlugin(() => NOW);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!followage'));
    expect(spy.error).toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(
      "Couldn't look up followage right now.",
      'msg-1',
      '1',
    );
  });
});
