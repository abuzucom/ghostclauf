import 'dotenv/config';
import { createAuthProvider } from './core/auth.js';
import { CommandRegistry } from './core/commands.js';
import { loadConfig } from './core/config.js';
import { EventBus } from './core/eventBus.js';
import { startHealthServer, type HealthServer } from './core/healthServer.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './core/metrics.js';
import { PluginManager } from './core/pluginManager.js';
import { createTwitchTransport } from './core/twitch.js';
import type { HelixClient, MessageSender } from './core/types.js';

async function main(): Promise<void> {
    const logger = createLogger();
    const { file, secrets } = loadConfig();
    const metrics = createMetrics();

    // Auth: load the bot and broadcaster tokens and resolve their user ids.
    const { authProvider, botUserId, broadcasterUserIds } = await createAuthProvider(
        secrets,
        logger,
        file.broadcasters,
        metrics,
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

    // The message sender and Helix client come from the transport, which is built
    // after plugins. Plugins only invoke them at runtime, so late-bound references
    // are safe - same pattern already used for the sender.
    let sender: MessageSender = () => {
        return Promise.reject(new Error('message sender not ready yet'));
    };
    const senderRef: MessageSender = (text, replyToId, broadcasterId) =>
        sender(text, replyToId, broadcasterId);

    // eslint-disable-next-line prefer-const
    let helixImpl: HelixClient | undefined;
    const requireHelix = (): HelixClient => {
        if (!helixImpl) throw new Error('helix client not ready yet');
        return helixImpl;
    };
    const helixRef: HelixClient = {
        getFollowage: (...args) => requireHelix().getFollowage(...args),
        getUserByLogin: (...args) => requireHelix().getUserByLogin(...args),
        sendShoutout: (...args) => requireHelix().sendShoutout(...args),
    };

    // Discover and initialize plugins (they register commands / event listeners).
    const plugins = new PluginManager({
        file,
        logger,
        registry,
        bus,
        sender: senderRef,
        helix: helixRef,
        broadcasters: broadcasterTargets.map((target) => ({
            id: target.userId!,
            login: target.login,
        })),
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
        metrics,
        handlers: {
            onChatMessage: (event) => {
                bus.emit('chatMessage', event);
                void registry.handle(event);
            },
            onStreamOnline: (event) => {
                bus.emit('streamOnline', event);
            },
            onStreamOffline: (event) => {
                bus.emit('streamOffline', event);
            },
            onStreamOfflinePending: (event) => {
                bus.emit('streamOfflinePending', event);
            },
        },
    });
    sender = transport.sender;
    helixImpl = transport.helix;

    await transport.start();
    logger.info(
        {
            broadcasters: file.broadcasters.map(({ login }) => login),
            bot: file.bot.login,
            plugins: plugins.active,
        },
        'ghostclauf is online',
    );

    // Reuses the OAuth callback's port; the two never run at the same time.
    const healthPort = Number(new URL(secrets.redirectUri).port || '3000');
    let healthServer: HealthServer | undefined;
    try {
        healthServer = await startHealthServer({
            port: healthPort,
            logger,
            metrics,
            isReady: () => transport.isReady(),
        });
    } catch (error) {
        logger.warn({ err: error, port: healthPort }, 'could not start health server');
    }

    const shutdown = async (signal: string): Promise<void> => {
        logger.info({ signal }, 'shutting down');
        await plugins.disposeAll();
        await transport.stop();
        await healthServer?.close();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
    // Logger may not exist yet if config/auth failed; fall back to console.
    console.error('fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
});
