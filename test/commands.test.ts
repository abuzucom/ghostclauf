import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/core/commands.js';
import type { BotContext, ChatCommandEvent } from '../src/core/types.js';
import { makeMessage, testLogger } from './helpers.js';

const ctx = {} as BotContext; // handlers under test don't touch the context

describe('CommandRegistry', () => {
  it('ignores messages without the prefix', async () => {
    const reg = new CommandRegistry('!', testLogger);
    reg.register('p', { trigger: 'pong', allow: ['everyone'], handler: vi.fn() }, ctx);
    expect(await reg.handle(makeMessage('pong'))).toBe(false);
    expect(await reg.handle(makeMessage('hello world'))).toBe(false);
  });

  it('invokes an allowed command', async () => {
    const reg = new CommandRegistry('!', testLogger);
    const handler = vi.fn();
    reg.register('p', { trigger: 'pong', allow: ['everyone'], handler }, ctx);
    expect(await reg.handle(makeMessage('!pong'))).toBe(true);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('matches but denies when permission is not met', async () => {
    const reg = new CommandRegistry('!', testLogger);
    const handler = vi.fn();
    reg.register('p', { trigger: 'pong', allow: ['moderator'], handler }, ctx);
    // matched (returns true) but handler not run
    expect(await reg.handle(makeMessage('!pong', ['everyone']))).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is case-insensitive on the trigger', async () => {
    const reg = new CommandRegistry('!', testLogger);
    const handler = vi.fn();
    reg.register('p', { trigger: 'pong', allow: ['everyone'], handler }, ctx);
    await reg.handle(makeMessage('!PONG'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('parses args and argString', async () => {
    const reg = new CommandRegistry('!', testLogger);
    let captured: ChatCommandEvent | undefined;
    reg.register(
      'p',
      { trigger: 'say', allow: ['everyone'], handler: (event) => void (captured = event) },
      ctx,
    );
    await reg.handle(makeMessage('!say  hello   world '));
    expect(captured?.command).toBe('say');
    expect(captured?.args).toEqual(['hello', 'world']);
    expect(captured?.argString).toBe('hello   world');
  });

  it('rejects duplicate triggers', () => {
    const reg = new CommandRegistry('!', testLogger);
    reg.register('p', { trigger: 'x', allow: [], handler: vi.fn() }, ctx);
    expect(() =>
      reg.register('q', { trigger: 'x', allow: [], handler: vi.fn() }, ctx),
    ).toThrow(/already registered/);
  });

  it('does not swallow the message when no command matches', async () => {
    const reg = new CommandRegistry('!', testLogger);
    expect(await reg.handle(makeMessage('!unknown'))).toBe(false);
  });
});
