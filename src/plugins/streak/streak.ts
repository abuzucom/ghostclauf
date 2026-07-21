// Pure streak logic: no I/O, no clock reads. Callers pass in the current
// stream-day key so this module is fully deterministic and unit-testable.

import { DateTime } from 'luxon';
import type {
  CheckinOutcome,
  StreakMessages,
  StreakTriggers,
  ViewerRecord,
} from './types.js';

export const DEFAULT_TIMEZONE = 'UTC';
export const DEFAULT_DATA_PATH = './data/streaks.json';
/** How long a stream session anchors check-ins before falling back to the
 *  wall-clock day; long enough for an overnight stream, short enough not to
 *  misattribute an unrelated later check-in to a stale session. */
export const DEFAULT_STREAM_SESSION_HOURS = 18;

export const DEFAULT_TRIGGERS: StreakTriggers = {
  checkin: 'checkin',
  streak: 'streak',
  reset: 'streakreset',
  set: 'streakset',
  open: 'streakopen',
};

export const DEFAULT_MESSAGES: StreakMessages = {
  started: '@{user} checked in! Streak started: {streak} day.',
  extended: '@{user} checked in! Streak: {streak} days (best {longest}).',
  already: '@{user} you already checked in today. Streak: {streak} days.',
  notOpen: '@{user} check-in is not open yet - the stream has not been marked live today.',
  lookupSelf: '@{user} your streak is {streak} days (best {longest}).',
  lookupOther: '{user} has a streak of {streak} days (best {longest}).',
  lookupNone: '@{user} no streak yet - type the check-in command while live to start one.',
  reset: 'Reset {user}\'s streak to 0.',
  setDone: 'Set {user}\'s streak to {streak}.',
  opened: 'Check-in is now open for today ({day}).',
  adminUsage: 'Usage: {user}',
  adminNotFound: 'No streak record found for {user}.',
};

/**
 * Return the YYYY-MM-DD stream-day key for an instant in the given IANA zone.
 * Throws on an invalid timezone so callers validate configuration up front.
 */
export function streamDayKey(date: Date, timeZone: string): string {
  const local = DateTime.fromJSDate(date, { zone: timeZone });
  const key = local.isValid ? local.toISODate() : null;
  if (key === null) {
    throw new Error(`invalid timezone "${timeZone}" for streak day boundaries`);
  }
  return key;
}

/** True if `timeZone` is a valid IANA zone luxon can resolve. */
export function isValidTimezone(timeZone: string): boolean {
  return DateTime.local().setZone(timeZone).isValid;
}

/**
 * Return the recorded stream day immediately before `today`, or null if none.
 * Robust whether or not `today` itself is present in the (ascending) list.
 */
export function previousStreamDay(streamDays: readonly string[], today: string): string | null {
  let previous: string | null = null;
  for (const day of streamDays) {
    if (day < today) {
      previous = day;
    } else {
      break;
    }
  }
  return previous;
}

/** A fresh viewer record with no streak history. */
export function newViewerRecord(chatterName: string, displayName: string): ViewerRecord {
  return {
    chatterName,
    displayName,
    currentStreak: 0,
    longestStreak: 0,
    lastCheckinDay: null,
    totalCheckins: 0,
  };
}

/**
 * Apply a check-in on stream day `today`. Returns a new record (never mutates
 * the input) plus the outcome. `previousStreamDayKey` is the stream day
 * immediately before `today`; a viewer whose last check-in was that day extends
 * their streak, otherwise it restarts at 1. A same-day repeat is a no-op.
 */
export function applyCheckin(
  viewer: ViewerRecord,
  today: string,
  previousStreamDayKey: string | null,
): { viewer: ViewerRecord; outcome: CheckinOutcome } {
  if (viewer.lastCheckinDay === today) {
    return { viewer, outcome: 'already' };
  }
  const extends_ =
    viewer.lastCheckinDay !== null && viewer.lastCheckinDay === previousStreamDayKey;
  const currentStreak = extends_ ? viewer.currentStreak + 1 : 1;
  const next: ViewerRecord = {
    ...viewer,
    currentStreak,
    longestStreak: Math.max(viewer.longestStreak, currentStreak),
    lastCheckinDay: today,
    totalCheckins: viewer.totalCheckins + 1,
  };
  return { viewer: next, outcome: extends_ ? 'extended' : 'started' };
}

/**
 * Resolve which stream day a check-in at `now` should count toward. Anchors
 * to the day the current stream started (rather than the wall-clock day of
 * the check-in itself) as long as that start is within `sessionHours` and not
 * in the future, so a stream that runs past midnight doesn't split a single
 * session across two stream days. Falls back to the plain wall-clock day
 * otherwise (no active/recent stream, or the anchor has gone stale).
 */
export function resolveCheckinDay(
  now: Date,
  activeStreamStartedAt: Date | null,
  timeZone: string,
  sessionHours: number,
): string {
  if (activeStreamStartedAt) {
    const elapsedHours = (now.getTime() - activeStreamStartedAt.getTime()) / 3_600_000;
    if (elapsedHours >= 0 && elapsedHours <= sessionHours) {
      return streamDayKey(activeStreamStartedAt, timeZone);
    }
  }
  return streamDayKey(now, timeZone);
}

/** Tokens available to message templates. */
export interface MessageTokens {
  user?: string;
  streak?: number;
  longest?: number;
  day?: string;
}

/** Substitute {user}/{streak}/{longest}/{day} tokens in a template. */
export function renderMessage(template: string, tokens: MessageTokens): string {
  return template
    .replaceAll('{user}', tokens.user ?? '')
    .replaceAll('{streak}', String(tokens.streak ?? ''))
    .replaceAll('{longest}', String(tokens.longest ?? ''))
    .replaceAll('{day}', tokens.day ?? '');
}
