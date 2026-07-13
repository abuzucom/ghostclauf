import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/core/eventBus.js';
import { flush, makeMessage, makeSpyLogger } from './helpers.js';

describe('EventBus', () => {
  it('invokes all handlers registered for an event', async () => {
    const bus = new EventBus(makeSpyLogger().logger);
    const first = vi.fn();
    const second = vi.fn();
    bus.on('chatMessage', first);
    bus.on('chatMessage', second);

    const payload = makeMessage('hello');
    bus.emit('chatMessage', payload);
    await flush();

    expect(first).toHaveBeenCalledWith(payload);
    expect(second).toHaveBeenCalledWith(payload);
  });

  it('catches a handler that throws synchronously and logs it via the injected logger', async () => {
    const spy = makeSpyLogger();
    const bus = new EventBus(spy.logger);
    const spyHandler = vi.fn();
    bus.on('chatMessage', () => {
      throw new Error('sync boom');
    });
    bus.on('chatMessage', spyHandler);

    bus.emit('chatMessage', makeMessage('hello'));
    await flush();

    expect(spyHandler).toHaveBeenCalledOnce();
    expect(spy.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), event: 'chatMessage' }),
      'event handler threw',
    );
  });

  it('catches a handler that returns a rejected promise and logs it', async () => {
    const spy = makeSpyLogger();
    const bus = new EventBus(spy.logger);
    bus.on('chatMessage', () => Promise.reject(new Error('async boom')));

    bus.emit('chatMessage', makeMessage('hello'));
    await flush();

    expect(spy.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.objectContaining({ message: 'async boom' }),
        event: 'chatMessage',
      }),
      'event handler threw',
    );
  });

  it('does not let a throwing handler block a later handler on the same event', async () => {
    const bus = new EventBus(makeSpyLogger().logger);
    const first = vi.fn();
    const third = vi.fn();
    bus.on('chatMessage', first);
    bus.on('chatMessage', () => {
      throw new Error('middle boom');
    });
    bus.on('chatMessage', third);

    bus.emit('chatMessage', makeMessage('hello'));
    await flush();

    expect(first).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
  });

  it('emit with zero listeners does not throw', () => {
    const bus = new EventBus(makeSpyLogger().logger);
    expect(() => bus.emit('chatMessage', makeMessage('hello'))).not.toThrow();
  });
});
