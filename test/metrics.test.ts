import { describe, expect, it } from 'vitest';
import { createMetrics } from '../src/core/metrics.js';

describe('metrics', () => {
    it('starts with an empty snapshot', () => {
        const metrics = createMetrics();
        expect(metrics.snapshot()).toEqual({});
    });

    it('increments a counter from zero by one by default', () => {
        const metrics = createMetrics();
        metrics.increment('eventsub_reconnects');
        expect(metrics.snapshot()).toEqual({ eventsub_reconnects: 1 });
    });

    it('accumulates repeated increments', () => {
        const metrics = createMetrics();
        metrics.increment('chat_send_failures');
        metrics.increment('chat_send_failures');
        metrics.increment('chat_send_failures');
        expect(metrics.snapshot().chat_send_failures).toBe(3);
    });

    it('supports incrementing by a custom amount', () => {
        const metrics = createMetrics();
        metrics.increment('rate_limit_drops', 5);
        expect(metrics.snapshot().rate_limit_drops).toBe(5);
    });

    it('tracks counters independently', () => {
        const metrics = createMetrics();
        metrics.increment('a');
        metrics.increment('b');
        metrics.increment('a');
        expect(metrics.snapshot()).toEqual({ a: 2, b: 1 });
    });

    it('returns a snapshot that does not mutate on further increments', () => {
        const metrics = createMetrics();
        metrics.increment('a');
        const snapshot = metrics.snapshot();
        metrics.increment('a');
        expect(snapshot).toEqual({ a: 1 });
        expect(metrics.snapshot()).toEqual({ a: 2 });
    });
});
