import { describe, expect, it } from 'vitest';
import { formatFollowDuration } from '../src/plugins/followage/duration.js';

describe('formatFollowDuration', () => {
  const now = new Date('2026-07-21T12:00:00.000Z');

  it('returns "just now" for less than 1 minute', () => {
    const followedAt = new Date('2026-07-21T11:59:30.000Z');
    expect(formatFollowDuration(followedAt, now)).toBe('just now');
  });

  it('formats minutes', () => {
    const followedAt = new Date('2026-07-21T11:45:00.000Z');
    expect(formatFollowDuration(followedAt, now)).toBe('15 minutes');
  });

  it('formats hours and minutes', () => {
    const followedAt = new Date('2026-07-21T09:30:00.000Z');
    expect(formatFollowDuration(followedAt, now)).toBe('2 hours, 30 minutes');
  });

  it('formats days, hours, and minutes', () => {
    const followedAt = new Date('2026-07-18T09:30:00.000Z');
    expect(formatFollowDuration(followedAt, now)).toBe('3 days, 2 hours, 30 minutes');
  });

  it('formats years, months, and days', () => {
    const followedAt = new Date('2023-04-10T12:00:00.000Z');
    expect(formatFollowDuration(followedAt, now)).toBe('3 years, 3 months, 11 days');
  });
});
