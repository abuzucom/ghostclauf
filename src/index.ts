import 'dotenv/config';
import { createAuthProvider } from './core/auth.js';
import { CommandRegistry } from './core/commands.js';
import { loadConfig } from './core/config.js';
import { EventBus } from './core/eventBus.js';
import { createLogger } from './core/logger.js';
import { PluginManager } from './core/pluginManager.js';
import { createTwitchTransport } from './core/twitch.js';
import type { MessageSender } from './core/types.js';

async function main(): Promise<void> {
  const logger = createLogger();
  const { file, secrets } = loadConfig();

  // Auth: load the bot's persisted token and resolve its user id.
  const { authProvider, botUserId } = await createAuthProvider(secrets, logger);

  // Core services.
  const registry = new CommandRegistry(file.chat.commandPrefix, logger);
  const bus = new EventBus(logger);

  // The message sender comes from the transport, which is built after plugins.
  // Plugins only invoke it at runtime, so a late-bound reference is safe.
  let sender: MessageSender = async () => {
    throw new Error('message sender not ready yet');
  };
  const senderRef: MessageSender = (text, replyToId) => sender(text, replyToId);

  // Discover and initialize plugins (they register commands / event listeners).
  const plugins = new PluginManager({ file, logger, registry, bus, sender: senderRef });
  await plugins.loadAll();

  // Transport: one EventSub WS for chat + stream events, plus the sender.
  const transport = await createTwitchTransport({
    authProvider,
    botUserId,
    broadcasterLogin: file.broadcaster.login,
    logger,
    handlers: {
      onChatMessage: (event) => {
        bus.emit('chatMessage', event);
        void registry.handle(event);
      },
      onStreamOnline: (event) => {
        bus.emit('streamOnline', event);
      },
    },
  });
  sender = transport.sender;

  await transport.start();
  logger.info(
    { broadcaster: file.broadcaster.login, bot: file.bot.login, plugins: plugins.active },
    'ghostclauf is online',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    await transport.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  // Logger may not exist yet if config/auth failed; fall back to console.
  console.error('fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
