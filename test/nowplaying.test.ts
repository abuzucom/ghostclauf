import { describe, expect, it, vi } from 'vitest';
import { createNowPlayingPlugin } from '../src/plugins/nowplaying/index.js';
import { makeHarness, makeMessage, makeSpyLogger, spySender, stubHelix, testLogger } from './helpers.js';
import { createContext } from '../src/core/context.js';
import { CommandRegistry } from '../src/core/commands.js';
import { EventBus } from '../src/core/eventBus.js';

const NOW = new Date('2026-07-21T12:00:00Z');

function deck(overrides: Record<string, unknown> = {}) {
  return { onAir: false, track: null, ...overrides };
}

function stateBody(decks: Partial<Record<'A' | 'B' | 'C' | 'D', unknown>> = {}) {
  return {
    decks: {
      A: deck(),
      B: deck(),
      C: deck(),
      D: deck(),
      ...decks,
    },
  };
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as unknown as Response;
}

function fakeFetch(impl: typeof fetch) {
  return vi.fn(impl) as unknown as typeof fetch;
}

function setup(config: Record<string, unknown> = {}, fetchImpl: typeof fetch) {
  const h = makeHarness('nowplaying', config);
  const plugin = createNowPlayingPlugin(() => NOW, fetchImpl);
  return { ...h, plugin };
}

describe('nowplaying plugin', () => {
  it('registers exactly one command', () => {
    const { registry, ctx } = makeHarness('nowplaying');
    createNowPlayingPlugin().init(ctx);
    expect(registry.size).toBe(1);
  });

  it('reports a single on-air deck as "Artist - Title"', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(stateBody({ A: deck({ onAir: true, track: { title: 'Night Drive', artist: 'DJ Rae' } }) })),
    );
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    expect(say).toHaveBeenCalledWith('Now playing: DJ Rae - Night Drive', 'msg-1', '1');
  });

  it('joins multiple on-air decks', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(
        stateBody({
          A: deck({ onAir: true, track: { title: 'Track A', artist: 'Artist A' } }),
          C: deck({ onAir: true, track: { title: 'Track C', artist: '' } }),
        }),
      ),
    );
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    expect(say).toHaveBeenCalledWith('Now playing: Artist A - Track A / Track C', 'msg-1', '1');
  });

  it('stays silent when nothing is on air', async () => {
    const fetchImpl = fakeFetch(async () => okResponse(stateBody()));
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    expect(say).not.toHaveBeenCalled();
  });

  it('stays silent and logs a warning when the request fails', async () => {
    const fetchImpl = fakeFetch(async () => {
      throw new Error('ECONNREFUSED');
    });
    const spy = makeSpyLogger();
    const registry = new CommandRegistry('!', testLogger);
    const bus = new EventBus(testLogger);
    const say = spySender();
    const ctx = createContext({
      pluginName: 'nowplaying',
      config: {},
      logger: spy.logger,
      bus,
      registry,
      sender: say,
      helix: stubHelix(),
    });
    const plugin = createNowPlayingPlugin(() => NOW, fetchImpl);
    await plugin.init(ctx);

    await expect(registry.handle(makeMessage('!nowplaying'))).resolves.toBe(true);
    expect(say).not.toHaveBeenCalled();
    expect(spy.warn).toHaveBeenCalled();
  });

  it('stays silent when the server responds with a non-2xx status', async () => {
    const fetchImpl = fakeFetch(async () => errorResponse(503));
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    expect(say).not.toHaveBeenCalled();
  });

  it('stays silent when the response body has an unexpected shape', async () => {
    const fetchImpl = fakeFetch(async () => okResponse({ unexpected: true }));
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    expect(say).not.toHaveBeenCalled();
  });

  it('throttles a plain viewer to one reply per 3 minutes', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(stateBody({ A: deck({ onAir: true, track: { title: 'Night Drive', artist: 'DJ Rae' } }) })),
    );
    let now = NOW;
    const h = makeHarness('nowplaying');
    const plugin = createNowPlayingPlugin(() => now, fetchImpl);
    await plugin.init(h.ctx);

    await h.registry.handle(makeMessage('!nowplaying'));
    now = new Date(now.getTime() + 60 * 1000);
    await h.registry.handle(makeMessage('!nowplaying'));
    expect(h.say).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = new Date(now.getTime() + 2 * 60 * 1000 + 1);
    await h.registry.handle(makeMessage('!nowplaying'));
    expect(h.say).toHaveBeenCalledTimes(2);
  });

  it('cooldowns are per chatter and per channel', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(stateBody({ A: deck({ onAir: true, track: { title: 'Night Drive', artist: 'DJ Rae' } }) })),
    );
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying'));
    await registry.handle(makeMessage('!nowplaying', ['everyone'], { chatterId: '300' }));
    await registry.handle(makeMessage('!nowplaying', ['everyone'], { broadcasterId: '2' }));
    expect(say).toHaveBeenCalledTimes(3);
  });

  it('never throttles the broadcaster', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(stateBody({ A: deck({ onAir: true, track: { title: 'Night Drive', artist: 'DJ Rae' } }) })),
    );
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying', ['everyone', 'broadcaster']));
    await registry.handle(makeMessage('!nowplaying', ['everyone', 'broadcaster']));
    expect(say).toHaveBeenCalledTimes(2);
  });

  it('never throttles a moderator', async () => {
    const fetchImpl = fakeFetch(async () =>
      okResponse(stateBody({ A: deck({ onAir: true, track: { title: 'Night Drive', artist: 'DJ Rae' } }) })),
    );
    const { ctx, registry, say, plugin } = setup({}, fetchImpl);
    await plugin.init(ctx);

    await registry.handle(makeMessage('!nowplaying', ['everyone', 'moderator']));
    await registry.handle(makeMessage('!nowplaying', ['everyone', 'moderator']));
    expect(say).toHaveBeenCalledTimes(2);
  });

  it('never throws on an invalid baseUrl, and logs a warning instead', async () => {
    const fetchImpl = fakeFetch(async () => okResponse(stateBody()));
    const spy = makeSpyLogger();
    const registry = new CommandRegistry('!', testLogger);
    const bus = new EventBus(testLogger);
    const say = spySender();
    const ctx = createContext({
      pluginName: 'nowplaying',
      config: { baseUrl: 'not a url' },
      logger: spy.logger,
      bus,
      registry,
      sender: say,
      helix: stubHelix(),
    });
    const plugin = createNowPlayingPlugin(() => NOW, fetchImpl);
    await plugin.init(ctx);

    await expect(registry.handle(makeMessage('!nowplaying'))).resolves.toBe(true);
    expect(say).not.toHaveBeenCalled();
    expect(spy.warn).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
