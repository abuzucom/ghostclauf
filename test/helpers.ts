import { vi } from 'vitest';
import { createContext } from '../src/core/context.js';
import { CommandRegistry } from '../src/core/commands.js';
import { EventBus } from '../src/core/eventBus.js';
import { createLogger } from '../src/core/logger.js';
import type {
    BotContext,
    ChatMessageEvent,
    HelixClient,
    HelixLookup,
    PluginConfig,
    Role,
    BroadcasterIdentity,
} from '../src/core/types.js';

/** Silent logger for tests. */
export const testLogger = createLogger('silent');

/** Build a normalized chat message with the given text and roles. */
export function makeMessage(
    text: string,
    roles: Role[] = ['everyone'],
    extra: Partial<ChatMessageEvent> = {},
): ChatMessageEvent {
    return {
        messageId: 'msg-1',
        text,
        chatterId: '100',
        chatterName: 'viewer',
        chatterDisplayName: 'Viewer',
        badges: {},
        roles: new Set(roles),
        broadcasterId: '1',
        broadcasterName: 'streamer',
        ...extra,
    };
}

export function stubHelix(override: Partial<HelixClient> | HelixLookup = {}): HelixClient {
    return {
        getFollowage: vi.fn().mockResolvedValue(null),
        getUserByLogin: vi.fn().mockResolvedValue(null),
        sendShoutout: vi.fn().mockResolvedValue(undefined),
        ...override,
    };
}

/** A registry + bus + spy sender + a context, wired like the real app. */
export function makeHarness(
    pluginName: string,
    config: PluginConfig = {},
    helixOverride: Partial<HelixClient> | HelixClient | HelixLookup = {},
    broadcasters: readonly BroadcasterIdentity[] = [
        { id: '1', login: 'streamer' },
        { id: '2', login: 'streamer2' },
    ],
): {
    registry: CommandRegistry;
    bus: EventBus;
    say: ReturnType<typeof spySender>;
    ctx: BotContext;
    helix: HelixClient;
} {
    const registry = new CommandRegistry('!', testLogger);
    const bus = new EventBus(testLogger);
    const say = spySender();
    const helix = stubHelix(helixOverride);
    const ctx = createContext({
        pluginName,
        config,
        logger: testLogger,
        bus,
        registry,
        sender: say,
        helix,
        broadcasters,
    });
    return { registry, bus, say, ctx, helix };
}

/**
 * Window given to real timers (e.g. streak's offline confirmation) to fire.
 * Kept at the value the delay-only flush used, so timing-dependent tests see
 * at least the settling time they saw before.
 */
const FLUSH_DELAY_MS = 10;

/** Rounds of drain, enough for handlers that emit further events. */
const DRAIN_ROUNDS = 5;

/**
 * `drain()` awaits a snapshot of the in-flight set, so a handler that emits
 * another event registers work the first pass cannot see. Yielding a
 * macrotask between rounds lets those land and be awaited in turn.
 */
async function drainRepeatedly(bus: EventBus): Promise<void> {
    for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
        await bus.drain();
        await new Promise((resolve) => setImmediate(resolve));
    }
}

/**
 * Settle async event handlers before asserting.
 *
 * Pass the harness bus wherever possible: `EventBus` tracks every in-flight
 * handler promise, so draining it is deterministic. Without a bus this can
 * only wait a fixed delay and hope the work finished, which fails on a loaded
 * machine as a wrong assertion rather than a timeout - a handler that has not
 * finished writing leaves stale state for the next assertion to read.
 */
export async function flush(bus?: EventBus): Promise<void> {
    if (!bus) {
        await new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS));
        return;
    }
    await drainRepeatedly(bus);
    await new Promise((resolve) => setTimeout(resolve, FLUSH_DELAY_MS));
    await drainRepeatedly(bus);
}

export function spySender() {
    return vi
        .fn<(text: string, replyToId?: string) => Promise<void>>()
        .mockResolvedValue(undefined);
}

/** A fresh silent logger with spies on each level, for asserting log calls. */
export function makeSpyLogger() {
    const logger = createLogger('silent');
    return {
        logger,
        error: vi.spyOn(logger, 'error'),
        warn: vi.spyOn(logger, 'warn'),
        debug: vi.spyOn(logger, 'debug'),
        info: vi.spyOn(logger, 'info'),
    };
}
