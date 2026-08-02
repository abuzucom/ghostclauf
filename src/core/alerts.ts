// Structured alert hook for failures an operator needs to notice even without
// watching logs continuously: token-refresh failure, EventSub subscription
// revocation. Deliberately log-only (no webhook/SDK) - ops pipelines can
// alert on the `alert: true` field. See core/metrics.ts for the paired
// counters these same call sites also increment.

import type { Logger } from './types.js';

/** Emit a structured, greppable alert-level log line. */
export function fireAlert(logger: Logger, kind: string, details: Record<string, unknown>): void {
    logger.error({ alert: true, kind, ...details }, `alert: ${kind}`);
}
