// Liveness/readiness HTTP endpoints for external supervisors (systemd,
// Docker healthcheck, uptime monitors). Built on plain node:http the same
// way tools/authFlow.ts builds its one-time OAuth callback server - no new
// dependency. Reuses port 3000, which docker-compose.yml already opens only
// for the one-time OAuth flow (the bot is never running during that flow).

import { createServer, type Server } from 'node:http';
import { closeServer } from './httpServer.js';
import type { Metrics } from './metrics.js';
import type { Logger } from './types.js';

/**
 * Binds loopback-only by default. `/readyz` exposes an operational metrics
 * snapshot, so it must not be reachable off-box just because Docker publishes
 * the port; a Docker `HEALTHCHECK`/systemd probe runs on the same host and
 * reaches loopback fine. Pass '0.0.0.0' explicitly to expose it externally.
 */
const DEFAULT_HOST = '127.0.0.1';

export interface HealthServerOptions {
    port: number;
    /** Bind address. Defaults to loopback-only; see DEFAULT_HOST above. */
    host?: string;
    logger: Logger;
    metrics: Metrics;
    /** True once the transport has started and no broadcaster is in a revoked state. */
    isReady: () => boolean;
}

export interface HealthServer {
    /** The actual listening port (useful when `port: 0` requests an ephemeral one). */
    port: number;
    /** The bind address actually used (see `host` above). */
    host: string;
    close(): Promise<void>;
}

/** Resolve a request's path, or null when the request target cannot be parsed. */
export function resolveRequestPath(url: string | undefined): string | null {
    try {
        return new URL(url ?? '/', 'http://localhost').pathname;
    } catch {
        return null;
    }
}

/** Starts listening immediately; /healthz is 200 as soon as this resolves. */
export function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
    const { port, host = DEFAULT_HOST, logger, metrics, isReady } = opts;

    const server: Server = createServer((req, res) => {
        const path = resolveRequestPath(req.url);
        if (path === null) {
            res.writeHead(400, { 'content-type': 'text/plain' }).end('Bad request');
            return;
        }
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
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            const actualPort = (server.address() as { port: number }).port;
            logger.info({ port: actualPort, host }, 'health server listening');
            resolve({
                port: actualPort,
                host,
                // Both endpoints answer immediately, so no in-flight response is
                // worth waiting for; closeServer() also force-closes a socket that
                // connected without sending a complete request (see httpServer.ts).
                close: () => closeServer(server),
            });
        });
    });
}
