import { pino } from 'pino';
import type { Logger } from './types.js';

/**
 * Create the root logger. Emits structured JSON (lightweight, no worker
 * threads); pipe through `pino-pretty` in development for human-readable output:
 *   node dist/index.js | npx pino-pretty
 */
export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { app: 'ghostclauf' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
