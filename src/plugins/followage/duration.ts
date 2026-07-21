import { DateTime, Duration } from 'luxon';

/**
 * Format the time elapsed between `followedAt` and `now` into a friendly string using Luxon.
 * e.g. "just now", "5 minutes", "2 hours, 15 minutes", "1 year, 3 months, 12 days".
 */
export function formatFollowDuration(followedAt: Date, now: Date = new Date()): string {
  const start = DateTime.fromJSDate(followedAt);
  const end = DateTime.fromJSDate(now);

  if (!start.isValid || !end.isValid || end < start) {
    return 'just now';
  }

  const diffMs = end.diff(start).milliseconds;
  if (diffMs < 60_000) {
    return 'just now';
  }

  const duration = end.diff(start, ['years', 'months', 'days', 'hours', 'minutes']).toObject();

  const parts: string[] = [];

  const years = Math.floor(duration.years ?? 0);
  const months = Math.floor(duration.months ?? 0);
  const days = Math.floor(duration.days ?? 0);
  const hours = Math.floor(duration.hours ?? 0);
  const minutes = Math.floor(duration.minutes ?? 0);

  if (years > 0) parts.push(`${years} ${years === 1 ? 'year' : 'years'}`);
  if (months > 0) parts.push(`${months} ${months === 1 ? 'month' : 'months'}`);
  if (days > 0) parts.push(`${days} ${days === 1 ? 'day' : 'days'}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0 && years === 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);

  return parts.length > 0 ? parts.join(', ') : 'just now';
}
