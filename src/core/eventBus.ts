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
    private readonly listenerCleanupByPlugin = new Map<string, Array<() => void>>();
    private registeringPlugin: string | undefined;

    constructor(private readonly logger: Logger) {
        // Plugins may register many listeners; don't warn.
        this.emitter.setMaxListeners(0);
    }

    on<E extends keyof BotEvents>(event: E, handler: EventHandler<E>): void {
        const listener = (payload: BotEvents[E]): void =>
            this.trackHandlerInvocation(event, handler, payload);
        this.emitter.on(event, listener);
        const pluginName = this.registeringPlugin;
        if (!pluginName) return;
        const cleanup = this.listenerCleanupByPlugin.get(pluginName) ?? [];
        cleanup.push(() => this.emitter.off(event, listener));
        this.listenerCleanupByPlugin.set(pluginName, cleanup);
    }

    /** Associate listeners created during one plugin's asynchronous initialization. */
    async withPluginRegistration<T>(
        pluginName: string,
        register: () => T | Promise<T>,
    ): Promise<T> {
        if (this.registeringPlugin) throw new Error('plugin listener registration already active');
        this.registeringPlugin = pluginName;
        try {
            return await register();
        } finally {
            this.registeringPlugin = undefined;
        }
    }

    /** Remove every listener owned by a plugin whose initialization failed. */
    removePlugin(pluginName: string): void {
        const cleanup = this.listenerCleanupByPlugin.get(pluginName) ?? [];
        for (const removeListener of cleanup) removeListener();
        this.listenerCleanupByPlugin.delete(pluginName);
    }

    emit<E extends keyof BotEvents>(event: E, payload: BotEvents[E]): void {
        this.emitter.emit(event, payload);
    }

    /** Resolve after all handlers accepted before or during the drain settle. */
    async drain(): Promise<void> {
        while (this.inflight.size > 0) {
            await Promise.allSettled([...this.inflight]);
        }
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
