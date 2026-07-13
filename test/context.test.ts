import { describe, expect, it, vi } from 'vitest';
import type { CommandDefinition } from '../src/core/types.js';
import { makeHarness, testLogger } from './helpers.js';

describe('createContext', () => {
  it('say(text) calls the sender with only the text argument', async () => {
    const { ctx, say } = makeHarness('p');
    await ctx.say('hi');
    expect(say).toHaveBeenCalledWith('hi');
  });

  it('say(text, replyToId) calls the sender with both arguments', async () => {
    const { ctx, say } = makeHarness('p');
    await ctx.say('hi', 'msg-42');
    expect(say).toHaveBeenCalledWith('hi', 'msg-42');
  });

  it('command(def) registers under the plugin name, passing the context itself', () => {
    const { ctx, registry } = makeHarness('my-plugin');
    const registerSpy = vi.spyOn(registry, 'register');
    const def: CommandDefinition = { trigger: 'x', allow: ['everyone'], handler: vi.fn() };

    ctx.command(def);

    expect(registerSpy).toHaveBeenCalledWith('my-plugin', def, ctx);
  });

  it('on(event, handler) delegates to bus.on with the same event and handler', () => {
    const { ctx, bus } = makeHarness('p');
    const onSpy = vi.spyOn(bus, 'on');
    const handler = vi.fn();

    ctx.on('streamOnline', handler);

    expect(onSpy).toHaveBeenCalledWith('streamOnline', handler);
  });

  it('exposes the config and logger passed at construction unchanged', () => {
    const config = { foo: 'bar' };
    const { ctx } = makeHarness('p', config);
    expect(ctx.config).toBe(config);
    expect(ctx.logger).toBe(testLogger);
  });
});
