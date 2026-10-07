import {
    formatForChat,
    renderCheer,
    renderRaid,
    renderSubscribe,
    sanitizeChatterText,
} from '../dist/plugins/announce/index.js';
import { dataToString } from './helpers.js';

export function fuzz(data) {
    const input = dataToString(data);
    sanitizeChatterText(input);
    formatForChat(input, '!');
    const event = {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        raidingBroadcasterId: '2',
        raidingBroadcasterName: 'raider',
        raidingBroadcasterDisplayName: 'Raider',
        viewers: 42,
    };
    renderRaid(input, event);
    renderSubscribe(input, {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        userId: '100',
        userName: 'viewer',
        userDisplayName: 'Viewer',
        tier: '1000',
        isGift: false,
    });
    renderCheer(input, {
        broadcasterId: '1',
        broadcasterName: 'streamer',
        userId: '100',
        userName: 'viewer',
        userDisplayName: 'Viewer',
        bits: 100,
        message: input,
    });
}
