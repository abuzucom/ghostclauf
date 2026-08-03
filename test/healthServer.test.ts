import { connect as netConnect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics } from '../src/core/metrics.js';
import {
    resolveRequestPath,
    startHealthServer,
    type HealthServer,
} from '../src/core/healthServer.js';
import { testLogger } from './helpers.js';

describe('resolveRequestPath', () => {
    it('resolves an ordinary request path', () => {
        expect(resolveRequestPath('/healthz')).toBe('/healthz');
    });

    it('treats a missing url as the root path', () => {
        expect(resolveRequestPath(undefined)).toBe('/');
    });

    it('returns null instead of throwing on a malformed request target', () => {
        expect(resolveRequestPath('http://[::1')).toBeNull();
        expect(resolveRequestPath('http://exa mple.com')).toBeNull();
    });
});

describe('health server', () => {
    let server: HealthServer | undefined;

    afterEach(async () => {
        await server?.close();
        server = undefined;
    });

    async function start(isReady: () => boolean) {
        const metrics = createMetrics();
        server = await startHealthServer({ port: 0, logger: testLogger, metrics, isReady });
        return { metrics, server };
    }

    it('serves /healthz as 200 once listening', async () => {
        const { server: srv } = await start(() => true);
        const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'ok' });
    });

    it('serves /readyz as 200 with a metrics snapshot when ready', async () => {
        const { metrics, server: srv } = await start(() => true);
        metrics.increment('eventsub_reconnects');

        const res = await fetch(`http://127.0.0.1:${srv.port}/readyz`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ready: true, metrics: { eventsub_reconnects: 1 } });
    });

    it('serves /readyz as 503 when not ready', async () => {
        const { server: srv } = await start(() => false);

        const res = await fetch(`http://127.0.0.1:${srv.port}/readyz`);
        expect(res.status).toBe(503);
        expect((await res.json()).ready).toBe(false);
    });

    it('returns 404 for unknown paths', async () => {
        const { server: srv } = await start(() => true);

        const res = await fetch(`http://127.0.0.1:${srv.port}/unknown`);
        expect(res.status).toBe(404);
    });

    it('binds loopback-only by default', async () => {
        const { server: srv } = await start(() => true);
        // Confirms the fix for accidental exposure via a published container
        // port: without an explicit host, the server only listens on 127.0.0.1.
        expect(srv.host).toBe('127.0.0.1');
    });

    it('honors an explicit host override', async () => {
        const metrics = createMetrics();
        server = await startHealthServer({
            port: 0,
            host: '0.0.0.0',
            logger: testLogger,
            metrics,
            isReady: () => true,
        });
        expect(server.host).toBe('0.0.0.0');
        const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
        expect(res.status).toBe(200);
    });

    it('responds 400 instead of crashing on a request target the URL parser rejects', async () => {
        const { server: srv } = await start(() => true);
        // "//[::1" is valid HTTP request-line syntax but throws when parsed as
        // a URL (unterminated IPv6 host) - confirms the server survives it.
        const response = await new Promise<string>((resolve, reject) => {
            const socket = netConnect(srv.port, '127.0.0.1', () => {
                socket.write('GET //[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
            });
            let data = '';
            socket.on('data', (chunk) => (data += chunk.toString()));
            socket.on('close', () => resolve(data));
            socket.on('error', reject);
        });
        expect(response.startsWith('HTTP/1.1 400')).toBe(true);

        // The server itself is still alive and answering normal requests.
        const res = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
        expect(res.status).toBe(200);
    });
});
