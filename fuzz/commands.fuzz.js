import { CommandRegistry } from '../dist/core/commands.js';
import { fuzzLogger } from './helpers.js';

const registry = new CommandRegistry('!', fuzzLogger);

registry.register(
    'fuzz',
    {
        trigger: 'ping',
        allow: [],
        handler: async () => {},
    },
    // The handler is not invoked by this target; a minimal context is enough.
    {},
);

const baseMessage = {
    messageId: 'msg-1',
    chatterId: '100',
    chatterName: 'viewer',
    chatterDisplayName: 'Viewer',
    badges: {},
    roles: new Set(['everyone']),
    broadcasterId: '1',
    broadcasterName: 'streamer',
    timestamp: Date.now(),
};

export function fuzz(data) {
    registry.match({ ...baseMessage, text: Buffer.from(data).toString('utf8') });
}
