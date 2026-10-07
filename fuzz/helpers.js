// Shared helpers for Jazzer.js fuzz targets.
// These targets import the compiled code in dist/ and must be run after
// `npm run build`.

import { createLogger } from '../dist/core/logger.js';

// Fuzzer targets intentionally feed malformed input to libraries that emit
// process warnings (yaml, zod). Suppress them so CI logs stay readable.
process.emitWarning = () => {};

/** Silent logger so fuzzing does not spam stdout. */
export const fuzzLogger = createLogger('silent');

/** Decode fuzzer input as a UTF-8 string, replacing invalid sequences. */
export function dataToString(data) {
    return Buffer.from(data).toString('utf8');
}

/** Decode fuzzer input as a trimmed token useful for command arguments. */
export function dataToToken(data) {
    return dataToString(data).split(/\s+/)[0] ?? '';
}
