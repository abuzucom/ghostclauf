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

export function stubHelix(
  override: Partial<HelixClient> | HelixLookup = {},
): HelixClient {
  return {
    getFollowAge: vi.fn().mockResolvedValue(null),
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
  });
  return { registry, bus, say, ctx, helix };
}

/** Wait for queued microtasks/timers so async event handlers can run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

import { vi } from 'vitest';

export function spySender() {
  return vi.fn<(text: string, replyToId?: string) => Promise<void>>().mockResolvedValue(undefined);
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
