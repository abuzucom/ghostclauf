// Attendance / watch-streak plugin. Viewers "check in" while the stream is live
// to build a streak of consecutive stream days attended. Only chat is used as
// the trigger for now; a future channel-point redeem can call the same
// StreakStore.checkIn path without changing this plugin's model.

import type { CheckinOutcome, StreakConfig, StreakMessages, StreakTriggers } from './types.js';
import type { BotContext, CommandHandler, Logger, Plugin } from '../../core/types.js';
import { StreakStore } from './store.js';
import {
  DEFAULT_DATA_PATH,
  DEFAULT_MESSAGES,
  DEFAULT_TIMEZONE,
  DEFAULT_TRIGGERS,
  isValidTimezone,
  renderMessage,
  streamDayKey,
} from './streak.js';

interface ResolvedConfig {
  dataPath: string;
  timezone: string;
  requireStreamDay: boolean;
  triggers: StreakTriggers;
  messages: StreakMessages;
}

/** Twitch logins are 1-25 chars of letters, digits, and underscores. */
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
/** Bound admin-set values to a sane range and reject non-numeric input. */
const STREAK_VALUE_PATTERN = /^\d{1,6}$/;

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
    triggers: { ...DEFAULT_TRIGGERS, ...raw.triggers },
    messages: { ...DEFAULT_MESSAGES, ...raw.messages },
  };
}

/** Parse an optional "@login" argument into a validated lowercase login. */
function parseLogin(token: string | undefined): string | null {
  if (!token) return null;
  const login = token.replace(/^@/, '').toLowerCase();
  return LOGIN_PATTERN.test(login) ? login : null;
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
  broadcasterId: string,
  today: string,
): Promise<boolean> {
  if (store.hasStreamDay(broadcasterId, today)) return true;
  if (cfg.requireStreamDay) return false;
  await store.recordStreamDay(broadcasterId, today);
  return true;
}

function checkinHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
  return async (event, ctx) => {
    const today = streamDayKey(new Date(), cfg.timezone);
    const open = await ensureOpen(store, cfg, event.broadcasterId, today);
    if (!open) {
      const text = renderMessage(cfg.messages.notOpen, { user: event.chatterDisplayName });
      await ctx.say(text, event.messageId, event.broadcasterId);
      return;
    }
    const { outcome, viewer } = await store.checkIn(
      event.broadcasterId,
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
    const login = parseLogin(event.args[0]);
    if (login) {
      const found = store.findViewerByName(event.broadcasterId, login);
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
    const viewer = store.getViewer(event.broadcasterId, event.chatterId);
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
  const login = parseLogin(event.args[0]);
  if (!login) {
    await ctx.say(renderMessage(cfg.messages.adminUsage, { user: usage }), event.messageId, event.broadcasterId);
    return null;
  }
  const found = store.findViewerByName(event.broadcasterId, login);
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
    await store.resetViewer(event.broadcasterId, found.chatterId);
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
    await store.setViewerStreak(event.broadcasterId, found.chatterId, value);
    const text = renderMessage(cfg.messages.setDone, { user: found.viewer.displayName, streak: value });
    await ctx.say(text, event.messageId, event.broadcasterId);
  };
}

function openHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
  return async (event, ctx) => {
    const today = streamDayKey(new Date(), cfg.timezone);
    await store.recordStreamDay(event.broadcasterId, today);
    await ctx.say(renderMessage(cfg.messages.opened, { day: today }), event.messageId, event.broadcasterId);
  };
}

const plugin: Plugin = {
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
      handler: checkinHandler(store, cfg),
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
      allow: ['broadcaster', 'moderator'],
      description: "Set a viewer's streak to a specific value.",
      handler: setHandler(store, cfg),
    });
    ctx.command({
      trigger: cfg.triggers.open,
      allow: ['broadcaster', 'moderator'],
      description: 'Open check-in for today if the stream-live event was missed.',
      handler: openHandler(store, cfg),
    });

    ctx.on('streamOnline', async (event) => {
      const day = streamDayKey(event.startedAt, cfg.timezone);
      const added = await store.recordStreamDay(event.broadcasterId, day);
      if (added) {
        ctx.logger.info({ broadcasterId: event.broadcasterId, day }, 'recorded stream day');
      }
    });
  },
};

export default plugin;
