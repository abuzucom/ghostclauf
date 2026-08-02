import { afterEach, describe, expect, it } from 'vitest';
import { createMetrics } from '../src/core/metrics.js';
import { startHealthServer, type HealthServer } from '../src/core/healthServer.js';
import { testLogger } from './helpers.js';

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
});
