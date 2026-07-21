// Per-key cooldown gate shared by plugins that must not amplify chat floods
// into API calls or replies (see the streak and followage commands).

/** Bound on the in-memory map before expired entries are pruned. */
const DEFAULT_ENTRY_LIMIT = 10_000;

/**
 * Tracks the last handled time per key and reports whether a new invocation
 * falls inside the cooldown window. Throttled invocations are expected to be
 * dropped silently so the bot does not amplify a flood.
 */
export class CooldownGate {
  private readonly lastHandledAtMs = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number,
    private readonly entryLimit = DEFAULT_ENTRY_LIMIT,
  ) {}

  /** Number of tracked keys (exposed for tests). */
  get size(): number {
    return this.lastHandledAtMs.size;
  }

  /**
   * True if `key` was handled within the cooldown window; otherwise records
   * this invocation and returns false. A cooldown of zero never throttles.
   */
  shouldThrottle(key: string, nowMs: number): boolean {
    if (this.cooldownMs <= 0) return false;
    const last = this.lastHandledAtMs.get(key);
    if (last !== undefined && nowMs - last < this.cooldownMs) return true;
    if (this.lastHandledAtMs.size >= this.entryLimit) {
      this.pruneExpired(nowMs - this.cooldownMs);
    }
    this.lastHandledAtMs.set(key, nowMs);
    return false;
  }

  /** Drop expired entries so the map stays bounded under chatter churn. */
  private pruneExpired(cutoffMs: number): void {
    for (const [key, at] of [...this.lastHandledAtMs]) {
      if (at < cutoffMs) this.lastHandledAtMs.delete(key);
    }
  }
}
