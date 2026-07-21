import { describe, expect, it } from 'vitest';
import {
  applyCheckin,
  newViewerRecord,
  previousStreamDay,
  renderMessage,
  streamDayKey,
} from '../src/plugins/streak/streak.js';
import type { ViewerRecord } from '../src/plugins/streak/types.js';

describe('streamDayKey', () => {
  it('formats YYYY-MM-DD in UTC', () => {
    expect(streamDayKey(new Date('2026-07-20T02:00:00.000Z'), 'UTC')).toBe('2026-07-20');
  });

  it('shifts the day across timezones', () => {
    // 02:00 UTC on the 20th is 22:00 on the 19th in New York (UTC-4 in July).
    const instant = new Date('2026-07-20T02:00:00.000Z');
    expect(streamDayKey(instant, 'America/New_York')).toBe('2026-07-19');
    expect(streamDayKey(instant, 'UTC')).toBe('2026-07-20');
  });

  it('throws on an invalid timezone', () => {
    expect(() => streamDayKey(new Date('2026-07-20T02:00:00.000Z'), 'Not/AZone')).toThrow(
      /invalid timezone/i,
    );
  });
});

describe('previousStreamDay', () => {
  const days = ['2026-07-18', '2026-07-20', '2026-07-22'];

  it('returns the stream day immediately before today', () => {
    expect(previousStreamDay(days, '2026-07-22')).toBe('2026-07-20');
    expect(previousStreamDay(days, '2026-07-20')).toBe('2026-07-18');
  });

  it('returns null when today is the earliest stream day', () => {
    expect(previousStreamDay(days, '2026-07-18')).toBeNull();
  });

  it('returns the latest earlier day when today is not recorded', () => {
    expect(previousStreamDay(days, '2026-07-25')).toBe('2026-07-22');
  });

  it('returns null for an empty list', () => {
    expect(previousStreamDay([], '2026-07-20')).toBeNull();
  });
});

describe('applyCheckin', () => {
  function viewer(overrides: Partial<ViewerRecord> = {}): ViewerRecord {
    return { ...newViewerRecord('foo', 'Foo'), ...overrides };
  }

  it('starts a streak for a first-time viewer', () => {
    const { viewer: next, outcome } = applyCheckin(viewer(), '2026-07-20', null);
    expect(outcome).toBe('started');
    expect(next.currentStreak).toBe(1);
    expect(next.longestStreak).toBe(1);
    expect(next.lastCheckinDay).toBe('2026-07-20');
    expect(next.totalCheckins).toBe(1);
  });

  it('extends when the last check-in was the previous stream day', () => {
    const start = viewer({
      currentStreak: 2,
      longestStreak: 2,
      lastCheckinDay: '2026-07-18',
      totalCheckins: 2,
    });
    const { viewer: next, outcome } = applyCheckin(start, '2026-07-20', '2026-07-18');
    expect(outcome).toBe('extended');
    expect(next.currentStreak).toBe(3);
    expect(next.longestStreak).toBe(3);
    expect(next.totalCheckins).toBe(3);
  });

  it('resets when a stream day was missed', () => {
    const start = viewer({
      currentStreak: 5,
      longestStreak: 5,
      lastCheckinDay: '2026-07-16',
      totalCheckins: 5,
    });
    // previous stream day was 07-20 but viewer last checked in 07-16 (missed 07-20).
    const { viewer: next, outcome } = applyCheckin(start, '2026-07-22', '2026-07-20');
    expect(outcome).toBe('started');
    expect(next.currentStreak).toBe(1);
    expect(next.longestStreak).toBe(5); // longest preserved
    expect(next.totalCheckins).toBe(6);
  });

  it('is idempotent for a same-day repeat check-in', () => {
    const start = viewer({
      currentStreak: 3,
      longestStreak: 4,
      lastCheckinDay: '2026-07-20',
      totalCheckins: 7,
    });
    const { viewer: next, outcome } = applyCheckin(start, '2026-07-20', '2026-07-18');
    expect(outcome).toBe('already');
    expect(next.currentStreak).toBe(3);
    expect(next.longestStreak).toBe(4);
    expect(next.totalCheckins).toBe(7);
  });

  it('does not mutate the input record', () => {
    const start = viewer({ currentStreak: 1, lastCheckinDay: '2026-07-18' });
    applyCheckin(start, '2026-07-20', '2026-07-18');
    expect(start.currentStreak).toBe(1);
    expect(start.lastCheckinDay).toBe('2026-07-18');
  });
});

describe('renderMessage', () => {
  it('substitutes tokens', () => {
    const text = renderMessage('@{user} streak {streak} (best {longest}) on {day}', {
      user: 'Foo',
      streak: 3,
      longest: 5,
      day: '2026-07-20',
    });
    expect(text).toBe('@Foo streak 3 (best 5) on 2026-07-20');
  });
});
