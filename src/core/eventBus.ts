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
    // Tracks every in-flight handler promise so drain() can await them all.
    private readonly inflight = new Set<Promise<void>>();

    constructor(private readonly logger: Logger) {
        // Plugins may register many listeners; don't warn.
        this.emitter.setMaxListeners(0);
    }

    on<E extends keyof BotEvents>(event: E, handler: EventHandler<E>): void {
        this.emitter.on(event, (payload: BotEvents[E]) =>
            this.trackHandlerInvocation(event, handler, payload),
        );
    }

    emit<E extends keyof BotEvents>(event: E, payload: BotEvents[E]): void {
        this.emitter.emit(event, payload);
    }

    /**
     * Resolve once every in-flight handler that was running at call time has
     * settled. Use before flushing stores so no pending write is orphaned.
     */
    async drain(): Promise<void> {
        await Promise.allSettled([...this.inflight]);
    }

    /**
     * Invoke one plugin handler without allowing its failure to affect other
     * listeners. Add the promise before it settles so drain() includes writes
     * already started when shutdown begins.
     */
    private trackHandlerInvocation<E extends keyof BotEvents>(
        event: E,
        handler: EventHandler<E>,
        payload: BotEvents[E],
    ): void {
        const invocation: Promise<void> = Promise.resolve()
            .then(() => handler(payload))
            .catch((error: unknown) => {
                this.logger.error({ err: error, event }, 'event handler threw');
            })
            .finally(() => {
                this.inflight.delete(invocation);
            });
        this.inflight.add(invocation);
    }
}
