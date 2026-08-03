// In-process counter registry for operational visibility (EventSub reconnects,
// chat-send failures, rate-limit drops, and similar). Not persisted, not
// exported to any external metrics system - a snapshot is served by
// core/healthServer.ts's /readyz endpoint.

export interface Metrics {
    increment(name: string, by?: number): void;
    snapshot(): Record<string, number>;
}

export function createMetrics(): Metrics {
    const counters = new Map<string, number>();
    return {
        increment(name, by = 1) {
            counters.set(name, (counters.get(name) ?? 0) + by);
        },
        snapshot() {
            return Object.fromEntries(counters);
        },
    };
}
