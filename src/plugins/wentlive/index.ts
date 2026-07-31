import { DateTime } from 'luxon';
import type { Plugin } from '../../core/types.js';

type TimestampFormat = 'iso' | 'utc';

interface WentLiveConfig {
    /** Message template; {streamer} and {timestamp} are substituted. */
    template?: string;
    /** UTC rendering: "iso" (2026-07-12T18:04:05.000Z) or "utc" (RFC 1123). */
    timestampFormat?: TimestampFormat;
}

const DEFAULT_TEMPLATE = '{streamer} has gone live at {timestamp}';

export function formatTimestamp(date: Date, format: TimestampFormat): string {
    const dt = DateTime.fromJSDate(date).toUTC();
    // Luxon returns null for an invalid DateTime. Fail loudly rather than
    // letting the string "null" reach a live announcement.
    const formatted = format === 'utc' ? dt.toHTTP() : dt.toISO();
    if (formatted === null) {
        throw new Error(`invalid stream start timestamp: ${String(date)}`);
    }
    return formatted;
}

export function renderAnnouncement(
    template: string,
    streamer: string,
    startedAt: Date,
    format: TimestampFormat,
): string {
    return template
        .replaceAll('{streamer}', streamer)
        .replaceAll('{timestamp}', formatTimestamp(startedAt, format));
}

/**
 * Posts an announcement to chat when the stream goes live, e.g.
 * "SomeStreamer has gone live at 2026-07-12T18:04:05.000Z".
 */
const plugin: Plugin = {
    name: 'wentlive',
    version: '1.0.0',
    init(ctx) {
        const cfg = ctx.config as WentLiveConfig;
        const template = cfg.template ?? DEFAULT_TEMPLATE;
        const format: TimestampFormat = cfg.timestampFormat === 'utc' ? 'utc' : 'iso';

        ctx.on('streamOnline', async (event) => {
            if (event.recovered) {
                ctx.logger.info(
                    { broadcasterId: event.broadcasterId },
                    'stream already live during recovery',
                );
                return;
            }
            const message = renderAnnouncement(
                template,
                event.broadcasterDisplayName,
                event.startedAt,
                format,
            );
            ctx.logger.info({ message }, 'stream went live, announcing');
            await ctx.say(message, undefined, event.broadcasterId);
        });
    },
};

export default plugin;
