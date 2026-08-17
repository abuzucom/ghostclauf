// Shared shutdown helper for the two one-shot local HTTP servers in this
// codebase (src/core/healthServer.ts, src/tools/authFlow.ts). Both serve a
// handful of requests then need to exit promptly: healthServer.ts on
// process shutdown, authFlow.ts as soon as the OAuth redirect is handled so
// run.sh's while loop can move on to the next account.
//
// server.close() alone waits forever for a socket that connected without
// sending a complete request (e.g. a browser's speculative preconnect).
// Node drops genuinely idle keep-alives on its own, but that half-open case
// blocks close() past process.exit(), so both callers need this instead of
// a bare server.close().

import type { Server } from 'node:http';

/** Closes an HTTP server and force-closes any lingering connections. */
export function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
    });
}
