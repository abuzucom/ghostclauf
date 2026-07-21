import 'dotenv/config';
import { createAuthProvider } from './core/auth.js';
import { CommandRegistry } from './core/commands.js';
import { loadConfig } from './core/config.js';
import { EventBus } from './core/eventBus.js';
import { createLogger } from './core/logger.js';
import { PluginManager } from './core/pluginManager.js';
import { createTwitchTransport } from './core/twitch.js';
import type { HelixLookup, MessageSender } from './core/types.js';

async function main(): Promise<void> {
  const logger = createLogger();
  const { file, secrets } = loadConfig();

  // Auth: load the bot and broadcaster tokens and resolve their user ids.
  const { authProvider, botUserId, broadcasterUserIds } = await createAuthProvider(
    secrets,
    logger,
    file.broadcasters,
  );
  const broadcasterTargets = file.broadcasters.map((broadcaster, index) => ({
    login: broadcaster.login,
    userId: broadcasterUserIds[index],
  }));
  if (broadcasterTargets.some(({ userId }) => userId === undefined)) {
    throw new Error('missing resolved user ID for a configured broadcaster');
  }

  // Core services.
  const registry = new CommandRegistry(file.chat.commandPrefix, logger);
  const bus = new EventBus(logger);

  // The message sender comes from the transport, which is built after plugins.
  // Plugins only invoke it at runtime, so a late-bound reference is safe.
  let sender: MessageSender = async () => {
    throw new Error('message sender not ready yet');
  };
  const senderRef: MessageSender = (text, replyToId, broadcasterId) =>
    sender(text, replyToId, broadcasterId);

  // Same late-bind for Helix lookups; plugins only call them at runtime.
  let helix: HelixLookup = {
    getUserByLogin: async () => {
      throw new Error('helix lookup not ready yet');
    },
    getFollowage: async () => {
      throw new Error('helix lookup not ready yet');
    },
  };
  const helixRef: HelixLookup = {
    getUserByLogin: (login) => helix.getUserByLogin(login),
    getFollowage: (broadcasterId, userId) => helix.getFollowage(broadcasterId, userId),
  };

  // Discover and initialize plugins (they register commands / event listeners).
  const plugins = new PluginManager({
    file,
    logger,
    registry,
    bus,
    sender: senderRef,
    helix: helixRef,
  });
  await plugins.loadAll();

  // Transport: one EventSub WS for chat + stream events, plus the sender.
  const transport = await createTwitchTransport({
    authProvider,
    botUserId,
    botLogin: file.bot.login,
    broadcasters: broadcasterTargets.map((target) => ({
      login: target.login,
      userId: target.userId!,
    })),
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
  helix = transport.helix;

  await transport.start();
  logger.info(
    {
      broadcasters: file.broadcasters.map(({ login }) => login),
      bot: file.bot.login,
      plugins: plugins.active,
    },
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
