import { describe, expect, it } from 'vitest';
import {
  formatFollowDuration,
  renderFollowage,
  renderNotFollowing,
  renderUnknownUser,
} from '../src/plugins/followage/followage.js';

const NOW = new Date('2026-07-21T12:00:00Z');

describe('formatFollowDuration', () => {
  it('renders years and months', () => {
    const from = new Date('2023-05-10T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('3 years, 2 months');
  });

  it('omits months when the remainder is zero', () => {
    const from = new Date('2023-07-21T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('3 years');
  });

  it('uses singular units', () => {
    const from = new Date('2025-06-21T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('1 year, 1 month');
  });

  it('renders months and days below a year', () => {
    const from = new Date('2026-05-18T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('2 months, 3 days');
  });

  it('renders whole months without a day remainder', () => {
    const from = new Date('2026-06-21T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('1 month');
  });

  it('renders days below a month', () => {
    const from = new Date('2026-07-09T12:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('12 days');
  });

  it('renders a single day', () => {
    const from = new Date('2026-07-20T06:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('1 day');
  });

  it('floors sub-day follows to "less than a day"', () => {
    const from = new Date('2026-07-21T08:00:00Z');
    expect(formatFollowDuration(from, NOW)).toBe('less than a day');
  });
});

describe('message rendering', () => {
  it('renders the followage line', () => {
    expect(renderFollowage('Viewer', 'itsjustatank', '3 years, 2 months')).toBe(
      'Viewer has been following itsjustatank for 3 years, 2 months.',
    );
  });

  it('renders the not-following line', () => {
    expect(renderNotFollowing('Viewer', 'dj1a2n')).toBe('Viewer is not following dj1a2n.');
  });

  it('renders the unknown-user line', () => {
    expect(renderUnknownUser('ghost_404')).toBe(
      'No Twitch user named "ghost_404" was found.',
    );
  });
});
