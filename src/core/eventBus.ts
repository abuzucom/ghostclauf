import { EventEmitter } from 'node:events';
import type { BotEvents, Logger } from './types.js';

export type EventHandler<E extends keyof BotEvents> = (
  payload: BotEvents[E],
) => void | Promise<void>;

/**
 * A small typed event bus. The transport emits normalized events onto it and
 * plugins subscribe via `ctx.on(...)`. Handler errors are caught and logged so
 * one misbehaving plugin never takes down the bot.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: Logger) {
    // Plugins may register many listeners; don't warn.
    this.emitter.setMaxListeners(0);
  }

  on<E extends keyof BotEvents>(event: E, handler: EventHandler<E>): void {
    this.emitter.on(event, (payload: BotEvents[E]) => {
      Promise.resolve()
        .then(() => handler(payload))
        .catch((err: unknown) => {
          this.logger.error({ err, event }, 'event handler threw');
        });
    });
  }

  emit<E extends keyof BotEvents>(event: E, payload: BotEvents[E]): void {
    this.emitter.emit(event, payload);
  }
}
