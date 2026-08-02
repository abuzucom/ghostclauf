// Liveness/readiness HTTP endpoints for external supervisors (systemd,
// Docker healthcheck, uptime monitors). Built on plain node:http the same
// way tools/authFlow.ts builds its one-time OAuth callback server - no new
// dependency. Reuses port 3000, which docker-compose.yml already opens only
// for the one-time OAuth flow (the bot is never running during that flow).

import { createServer, type Server } from 'node:http';
import type { Metrics } from './metrics.js';
import type { Logger } from './types.js';

export interface HealthServerOptions {
    port: number;
    logger: Logger;
    metrics: Metrics;
    /** True once the transport has started and no broadcaster is in a revoked state. */
    isReady: () => boolean;
}

export interface HealthServer {
    /** The actual listening port (useful when `port: 0` requests an ephemeral one). */
    port: number;
    close(): Promise<void>;
}

/** Starts listening immediately; /healthz is 200 as soon as this resolves. */
export function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
    const { port, logger, metrics, isReady } = opts;

    const server: Server = createServer((req, res) => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (path === '/healthz') {
            res.writeHead(200, { 'content-type': 'application/json' }).end(
                JSON.stringify({ status: 'ok' }),
            );
            return;
        }
        if (path === '/readyz') {
            const ready = isReady();
            res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' }).end(
                JSON.stringify({ ready, metrics: metrics.snapshot() }),
            );
            return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
            server.removeListener('error', reject);
            const actualPort = (server.address() as { port: number }).port;
            logger.info({ port: actualPort }, 'health server listening');
            resolve({
                port: actualPort,
                close: () =>
                    new Promise<void>((resolveClose, rejectClose) => {
                        server.close((err) => (err ? rejectClose(err) : resolveClose()));
                    }),
            });
        });
    });
}
