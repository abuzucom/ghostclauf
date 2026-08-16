import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { closeServer } from '../src/core/httpServer.js';

describe('closeServer', () => {
    it('does not hang on a connection that never completes a request', async () => {
        const server = createServer((_req, res) => res.writeHead(200).end('ok'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;

        // A client can open a socket and send nothing, e.g. a browser's
        // speculative preconnect. Node's close() waits on such a connection
        // forever; closeServer() must force it shut instead.
        const socket = netConnect(port, '127.0.0.1');
        await new Promise<void>((resolve, reject) => {
            socket.on('connect', () => resolve());
            socket.on('error', reject);
        });

        const timedOut = Symbol('timed out');
        const outcome = await Promise.race([
            closeServer(server).then(() => 'closed'),
            new Promise((resolve) => setTimeout(() => resolve(timedOut), 1000)),
        ]);
        socket.destroy();

        expect(outcome).toBe('closed');
    });

    it('resolves normally when there are no open connections', async () => {
        const server = createServer((_req, res) => res.writeHead(200).end('ok'));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

        await expect(closeServer(server)).resolves.toBeUndefined();
    });
});
