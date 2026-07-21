import type { CommandRegistry } from './commands.js';
import type { EventBus } from './eventBus.js';
import type {
  BotContext,
  HelixLookup,
  Logger,
  MessageSender,
  PluginConfig,
} from './types.js';

export interface ContextDeps {
  pluginName: string;
  config: PluginConfig;
  logger: Logger;
  bus: EventBus;
  registry: CommandRegistry;
  sender: MessageSender;
  helix: HelixLookup;
}

/**
 * Build the `BotContext` handed to a single plugin. Bindings the plugin creates
 * (commands, event subscriptions) are wired to the shared registry/bus but carry
 * this plugin's own config and logger.
 */
export function createContext(deps: ContextDeps): BotContext {
  const { pluginName, config, logger, bus, registry, sender, helix } = deps;

  const ctx: BotContext = {
    config,
    logger,
    helix,
    say: (text, replyToId, broadcasterId) => {
      if (broadcasterId !== undefined) return sender(text, replyToId, broadcasterId);
      if (replyToId !== undefined) return sender(text, replyToId);
      return sender(text);
    },
    command: (def) => registry.register(pluginName, def, ctx),
    on: (event, handler) => bus.on(event, handler),
  };

  return ctx;
}
