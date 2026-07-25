// Nowplaying plugin: !nowplaying reports the track(s) currently on air on a
// local 1a2n-track-id overlay server (Traktor Pro 4 deck/track tracker for
// DJ streams). Polls its read-only GET /state endpoint on demand — never
// holds a persistent connection, so it cannot interfere with that server's
// own auto-shutdown (which only tracks its WebSocket/overlay clients).

import type { BotContext, Logger, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { formatNowPlaying, parseState } from './nowplaying.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_REQUEST_TIMEOUT_MS = 1500;
const MAX_REQUEST_TIMEOUT_MS = 10_000;
// Broadcasters and moderators are unlimited, any time. Everyone else is
// limited to one !nowplaying per three minutes. Fixed policy, not
// configurable, matching the same role-tiered approach used by !ping.
const VIEWER_COOLDOWN_MS = 3 * 60 * 1000;

export interface NowPlayingConfig {
  /** Base URL of the 1a2n-track-id server. Default: http://127.0.0.1:8080 */
  baseUrl?: string;
  /** Timeout for the /state request, in milliseconds. Default: 1500 */
  requestTimeoutMs?: number;
}

function resolveBaseUrl(configured: unknown, logger: Logger): string {
  if (configured === undefined) return DEFAULT_BASE_URL;
  if (typeof configured === 'string' && configured.length > 0) return configured;
  logger.warn({ configured }, 'invalid nowplaying baseUrl; falling back to default');
  return DEFAULT_BASE_URL;
}

function resolveRequestTimeoutMs(configured: unknown, logger: Logger): number {
  if (configured === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    typeof configured === 'number' &&
    Number.isInteger(configured) &&
    configured > 0 &&
    configured <= MAX_REQUEST_TIMEOUT_MS
  ) {
    return configured;
  }
  logger.warn({ configured }, 'invalid nowplaying requestTimeoutMs; falling back to default');
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

/**
 * Fetch and parse the overlay server's /state snapshot. Every failure path
 * (malformed baseUrl, network error, timeout, non-2xx, invalid JSON, schema
 * mismatch) converges on returning null and logging a warning — never
 * throws. An offline DJ overlay is an expected, common state, not a bot
 * fault, so failures are logged at warn rather than error.
 */
async function fetchState(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<ReturnType<typeof parseState> | null> {
  let url: URL;
  try {
    url = new URL('/state', baseUrl);
  } catch (err) {
    logger.warn({ err, baseUrl }, 'nowplaying: invalid baseUrl');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) {
      logger.warn({ status: res.status, url: url.toString() }, 'nowplaying: /state request failed');
      return null;
    }
    const body: unknown = await res.json();
    const tracks = parseState(body);
    if (!tracks) logger.warn({ url: url.toString() }, 'nowplaying: /state response had unexpected shape');
    return tracks;
  } catch (err) {
    logger.warn({ err, url: url.toString() }, 'nowplaying: /state request errored');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the nowplaying plugin. `now` is injectable so cooldown timing is
 * deterministically testable; `fetchImpl` is injectable so tests never make
 * a real network call. Production use relies on the real clock and global
 * `fetch`.
 */
export function createNowPlayingPlugin(
  now: () => Date = () => new Date(),
  fetchImpl: typeof fetch = fetch,
): Plugin {
  return {
    name: 'nowplaying',
    version: '1.0.0',
    init(ctx: BotContext): void {
      const config = (ctx.config ?? {}) as NowPlayingConfig;
      const baseUrl = resolveBaseUrl(config.baseUrl, ctx.logger);
      const requestTimeoutMs = resolveRequestTimeoutMs(config.requestTimeoutMs, ctx.logger);
      // Throttled repeats are dropped silently, before the fetch, so a chat
      // flood cannot be amplified into a flood of localhost requests either.
      const viewerCooldown = new CooldownGate(VIEWER_COOLDOWN_MS);

      ctx.command({
        trigger: 'nowplaying',
        allow: ['everyone'],
        description: 'Reports the track(s) currently on air on the DJ overlay.',
        handler: async (event, ctx) => {
          const isUnlimited = event.roles.has('broadcaster') || event.roles.has('moderator');
          if (!isUnlimited) {
            const cooldownKey = `${event.broadcasterId}:${event.chatterId}`;
            if (viewerCooldown.shouldThrottle(cooldownKey, now().getTime())) return;
          }

          const tracks = await fetchState(baseUrl, requestTimeoutMs, fetchImpl, ctx.logger);
          // No reply when nothing is on air, or the overlay isn't reachable.
          if (!tracks || tracks.length === 0) return;
          await ctx.say(
            `Now playing: ${formatNowPlaying(tracks)}`,
            event.messageId,
            event.broadcasterId,
          );
        },
      });
    },
  };
}

const plugin = createNowPlayingPlugin();
export default plugin;
