// Attendance / watch-streak plugin. Viewers "check in" while the stream is live
// to build a streak of consecutive stream days attended. Only chat is used as
// the trigger for now; a future channel-point redeem can call the same
// StreakStore.checkIn path without changing this plugin's model.

import type { CheckinOutcome, StreakConfig, StreakMessages, StreakTriggers } from './types.js';
import type { BotContext, CommandHandler, Logger, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { parseLogin } from '../../core/logins.js';
import { StreakStore } from './store.js';
import {
  DEFAULT_DATA_PATH,
  DEFAULT_MESSAGES,
  DEFAULT_STREAM_SESSION_HOURS,
  DEFAULT_TIMEZONE,
  DEFAULT_TRIGGERS,
  isValidTimezone,
  renderMessage,
  resolveCheckinDay,
  streamDayKey,
} from './streak.js';

interface ResolvedConfig {
  dataPath: string;
  timezone: string;
  requireStreamDay: boolean;
  shareAcrossChannels: boolean;
  streamSessionHours: number;
  checkinCooldownSeconds: number;
  triggers: StreakTriggers;
  messages: StreakMessages;
}

/** Bound admin-set values to a sane range and reject non-numeric input. */
const STREAK_VALUE_PATTERN = /^\d{1,6}$/;
/** A key that can never collide with a real (numeric) Twitch broadcaster id. */
const SHARED_SCOPE_KEY = 'shared';
const MIN_SESSION_HOURS = 1;
const MAX_SESSION_HOURS = 72;
const DEFAULT_CHECKIN_COOLDOWN_SECONDS = 10;
const MAX_CHECKIN_COOLDOWN_SECONDS = 3600;
const MS_PER_SECOND = 1000;

/** Validate an optional integer config value within [min, max], else fall back. */
function resolveBoundedInt(
  configured: number | undefined,
  min: number,
  max: number,
  fallback: number,
  name: string,
  logger: Logger,
): number {
  if (configured === undefined) return fallback;
  if (Number.isInteger(configured) && configured >= min && configured <= max) return configured;
  logger.warn({ configured }, `invalid streak ${name}; falling back to default`);
  return fallback;
}

function resolveConfig(raw: StreakConfig, logger: Logger): ResolvedConfig {
  const configuredTz = raw.timezone ?? DEFAULT_TIMEZONE;
  const timezone = isValidTimezone(configuredTz) ? configuredTz : DEFAULT_TIMEZONE;
  if (timezone !== configuredTz) {
    logger.warn({ configuredTz }, 'invalid streak timezone; falling back to UTC');
  }
  return {
    dataPath: raw.dataPath ?? DEFAULT_DATA_PATH,
    timezone,
    requireStreamDay: raw.requireStreamDay ?? true,
    shareAcrossChannels: raw.shareAcrossChannels ?? true,
    streamSessionHours: resolveBoundedInt(
      raw.streamSessionHours,
      MIN_SESSION_HOURS,
      MAX_SESSION_HOURS,
      DEFAULT_STREAM_SESSION_HOURS,
      'streamSessionHours',
      logger,
    ),
    checkinCooldownSeconds: resolveBoundedInt(
      raw.checkinCooldownSeconds,
      0,
      MAX_CHECKIN_COOLDOWN_SECONDS,
      DEFAULT_CHECKIN_COOLDOWN_SECONDS,
      'checkinCooldownSeconds',
      logger,
    ),
    triggers: { ...DEFAULT_TRIGGERS, ...raw.triggers },
    messages: { ...DEFAULT_MESSAGES, ...raw.messages },
  };
}

/** Resolve the store scope key for a channel: pooled when sharing is on. */
function scopeKey(cfg: ResolvedConfig, broadcasterId: string): string {
  return cfg.shareAcrossChannels ? SHARED_SCOPE_KEY : broadcasterId;
}

function parseStreakValue(token: string | undefined): number | null {
  if (token === undefined || !STREAK_VALUE_PATTERN.test(token)) return null;
  return Number(token);
}

function pickCheckinTemplate(messages: StreakMessages, outcome: CheckinOutcome): string {
  if (outcome === 'extended') return messages.extended;
  if (outcome === 'already') return messages.already;
  return messages.started;
}

/** Ensure today counts as a stream day, honoring the requireStreamDay policy. */
async function ensureOpen(
  store: StreakStore,
  cfg: ResolvedConfig,
  scope: string,
  today: string,
  now: Date,
): Promise<boolean> {
  if (store.hasStreamDay(scope, today)) return true;
  if (cfg.requireStreamDay) return false;
  await store.recordStreamDay(scope, today, now);
  return true;
}

function checkinHandler(store: StreakStore, cfg: ResolvedConfig, now: () => Date): CommandHandler {
  // Throttled check-ins are dropped silently so the bot does not amplify a
  // chat flood into store writes and replies.
  const cooldown = new CooldownGate(cfg.checkinCooldownSeconds * MS_PER_SECOND);
  return async (event, ctx) => {
    const scope = scopeKey(cfg, event.broadcasterId);
    const nowInstant = now();
    const cooldownKey = `${scope}:${event.chatterId}`;
    if (cooldown.shouldThrottle(cooldownKey, nowInstant.getTime())) {
      return;
    }
    const activeStart = store.activeStreamStartedAt(scope);
    const today = resolveCheckinDay(nowInstant, activeStart, cfg.timezone, cfg.streamSessionHours);
    const open = await ensureOpen(store, cfg, scope, today, nowInstant);
    if (!open) {
      const text = renderMessage(cfg.messages.notOpen, { user: event.chatterDisplayName });
      await ctx.say(text, event.messageId, event.broadcasterId);
      return;
    }
    const { outcome, viewer } = await store.checkIn(
      scope,
      event.chatterId,
      event.chatterName,
      event.chatterDisplayName,
      today,
    );
    const text = renderMessage(pickCheckinTemplate(cfg.messages, outcome), {
      user: event.chatterDisplayName,
      streak: viewer.currentStreak,
      longest: viewer.longestStreak,
      day: today,
    });
    await ctx.say(text, event.messageId, event.broadcasterId);
  };
}

function lookupHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
  return async (event, ctx) => {
    const scope = scopeKey(cfg, event.broadcasterId);
    const login = parseLogin(event.args[0]);
    if (login) {
      const found = store.findViewerByName(scope, login);
      const text = found
        ? renderMessage(cfg.messages.lookupOther, {
            user: found.viewer.displayName,
            streak: found.viewer.currentStreak,
            longest: found.viewer.longestStreak,
          })
        : renderMessage(cfg.messages.lookupNone, { user: login });
      await ctx.say(text, event.messageId, event.broadcasterId);
      return;
    }
    const viewer = store.getViewer(scope, event.chatterId);
    const text = viewer
      ? renderMessage(cfg.messages.lookupSelf, {
          user: event.chatterDisplayName,
          streak: viewer.currentStreak,
          longest: viewer.longestStreak,
        })
      : renderMessage(cfg.messages.lookupNone, { user: event.chatterDisplayName });
    await ctx.say(text, event.messageId, event.broadcasterId);
  };
}

/** Resolve an admin command's target viewer, replying with usage/not-found. */
async function resolveAdminTarget(
  store: StreakStore,
  cfg: ResolvedConfig,
  event: Parameters<CommandHandler>[0],
  ctx: BotContext,
  usage: string,
): Promise<{ chatterId: string; viewer: { displayName: string } } | null> {
  const scope = scopeKey(cfg, event.broadcasterId);
  const login = parseLogin(event.args[0]);
  if (!login) {
    await ctx.say(renderMessage(cfg.messages.adminUsage, { user: usage }), event.messageId, event.broadcasterId);
    return null;
  }
  const found = store.findViewerByName(scope, login);
  if (!found) {
    await ctx.say(
      renderMessage(cfg.messages.adminNotFound, { user: login }),
      event.messageId,
      event.broadcasterId,
    );
    return null;
  }
  return found;
}

function resetHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
  return async (event, ctx) => {
    const found = await resolveAdminTarget(store, cfg, event, ctx, `!${cfg.triggers.reset} @user`);
    if (!found) return;
    const scope = scopeKey(cfg, event.broadcasterId);
    await store.resetViewer(scope, found.chatterId);
    const text = renderMessage(cfg.messages.reset, { user: found.viewer.displayName });
    await ctx.say(text, event.messageId, event.broadcasterId);
  };
}

function setHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
  return async (event, ctx) => {
    const value = parseStreakValue(event.args[1]);
    if (value === null) {
      const usage = renderMessage(cfg.messages.adminUsage, { user: `!${cfg.triggers.set} @user <number>` });
      await ctx.say(usage, event.messageId, event.broadcasterId);
      return;
    }
    const found = await resolveAdminTarget(store, cfg, event, ctx, `!${cfg.triggers.set} @user <number>`);
    if (!found) return;
    const scope = scopeKey(cfg, event.broadcasterId);
    await store.setViewerStreak(scope, found.chatterId, value);
    const text = renderMessage(cfg.messages.setDone, { user: found.viewer.displayName, streak: value });
    await ctx.say(text, event.messageId, event.broadcasterId);
  };
}

function openHandler(store: StreakStore, cfg: ResolvedConfig, now: () => Date): CommandHandler {
  return async (event, ctx) => {
    const nowInstant = now();
    const scope = scopeKey(cfg, event.broadcasterId);
    const today = streamDayKey(nowInstant, cfg.timezone);
    await store.recordStreamDay(scope, today, nowInstant);
    await ctx.say(renderMessage(cfg.messages.opened, { day: today }), event.messageId, event.broadcasterId);
  };
}

/**
 * Build the streak plugin. `now` is injectable so check-in day resolution is
 * deterministically testable (the codebase has no fake-timer precedent);
 * production use relies on the default real clock.
 */
export function createStreakPlugin(now: () => Date = () => new Date()): Plugin {
  return {
    name: 'streak',
    version: '1.0.0',
    async init(ctx) {
      const cfg = resolveConfig(ctx.config as StreakConfig, ctx.logger);
      const store = new StreakStore(cfg.dataPath, ctx.logger);
      await store.load();

      ctx.command({
        trigger: cfg.triggers.checkin,
        allow: ['everyone'],
        description: 'Check in while live to build your attendance streak.',
        handler: checkinHandler(store, cfg, now),
      });
      ctx.command({
        trigger: cfg.triggers.streak,
        allow: ['everyone'],
        description: "Show your streak, or another viewer's with @user.",
        handler: lookupHandler(store, cfg),
      });
      ctx.command({
        trigger: cfg.triggers.reset,
        allow: ['broadcaster'],
        description: "Reset a viewer's streak to 0. Broadcaster only.",
        handler: resetHandler(store, cfg),
      });
      ctx.command({
        trigger: cfg.triggers.set,
        allow: ['broadcaster'],
        description: "Set a viewer's streak to a specific value. Broadcaster only.",
        handler: setHandler(store, cfg),
      });
      ctx.command({
        trigger: cfg.triggers.open,
        allow: ['broadcaster', 'moderator'],
        description: 'Open check-in for today if the stream-live event was missed.',
        handler: openHandler(store, cfg, now),
      });

      ctx.on('streamOnline', async (event) => {
        const scope = scopeKey(cfg, event.broadcasterId);
        const day = streamDayKey(event.startedAt, cfg.timezone);
        const added = await store.recordStreamDay(scope, day, event.startedAt);
        if (added) {
          ctx.logger.info({ broadcasterId: event.broadcasterId, day }, 'recorded stream day');
        }
      });
    },
  };
}

const plugin = createStreakPlugin();
export default plugin;
