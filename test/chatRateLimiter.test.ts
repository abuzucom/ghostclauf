import { describe, expect, it, vi } from 'vitest';
import { ChatRateLimiter } from '../src/core/chatRateLimiter.js';

describe('ChatRateLimiter', () => {
  it('spaces messages for the same channel by one second', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ChatRateLimiter();
      const calls: number[] = [];
      const start = Date.now();
      const first = limiter.enqueue('channel', async () => {
        calls.push(Date.now());
      });
      await vi.advanceTimersByTimeAsync(0);
      await first;

      const second = limiter.enqueue('channel', async () => {
        calls.push(Date.now());
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;

      expect(calls).toEqual([start, start + 1000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares the global budget across channels', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new ChatRateLimiter();
      const calls: number[] = [];
      const start = Date.now();
      const sends = Array.from({ length: 21 }, (_, index) =>
        limiter.enqueue(`channel-${index}`, async () => {
          calls.push(Date.now());
        }),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toHaveLength(20);
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all(sends);

      expect(calls).toHaveLength(21);
      expect(calls[20]).toBe(start + 30_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
