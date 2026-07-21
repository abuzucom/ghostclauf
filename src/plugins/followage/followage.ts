// Pure formatting logic for the followage plugin, kept free of I/O so it is
// directly unit-testable.

import { DateTime } from 'luxon';

/** Format a count with its singular/plural unit, e.g. "1 month", "3 years". */
function formatUnit(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * Human-readable duration between a follow date and now, using the two
 * largest calendar units: "3 years, 2 months", "2 months, 3 days", "12 days",
 * or "less than a day".
 */
export function formatFollowDuration(followedAt: Date, now: Date): string {
  const diff = DateTime.fromJSDate(now)
    .diff(DateTime.fromJSDate(followedAt), ['years', 'months', 'days']);
  const years = Math.floor(diff.years);
  const months = Math.floor(diff.months);
  const days = Math.floor(diff.days);

  if (years >= 1) {
    const parts = [formatUnit(years, 'year')];
    if (months >= 1) parts.push(formatUnit(months, 'month'));
    return parts.join(', ');
  }
  if (months >= 1) {
    const parts = [formatUnit(months, 'month')];
    if (days >= 1) parts.push(formatUnit(days, 'day'));
    return parts.join(', ');
  }
  if (days >= 1) return formatUnit(days, 'day');
  return 'less than a day';
}

export function renderFollowage(user: string, broadcaster: string, duration: string): string {
  return `${user} has been following ${broadcaster} for ${duration}.`;
}

export function renderNotFollowing(user: string, broadcaster: string): string {
  return `${user} is not following ${broadcaster}.`;
}

export function renderUnknownUser(login: string): string {
  return `No Twitch user named "${login}" was found.`;
}

export function renderBroadcasterSelf(broadcaster: string): string {
  return `${broadcaster} can't follow their own channel.`;
}

export const USAGE_MESSAGE = 'Usage: !followage [@user]';
export const LOOKUP_FAILED_MESSAGE = "Couldn't look up followage right now.";
