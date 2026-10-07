// Shared helpers for Jazzer.js fuzz targets.
// These targets import the compiled code in dist/ and must be run after
// `npm run build`.

import { createLogger } from '../dist/core/logger.js';

// The config target intentionally feeds malformed YAML to the yaml parser,
// which emits a `YAMLWarning` for every directive/tag error. Filter only
// that warning family so deprecation, prototype pollution, and crash warnings
// still surface.
const originalEmitWarning = process.emitWarning;

process.emitWarning = function emitWarningFiltered(warning, name, code) {
    const warningName = typeof warning === 'string' ? name : warning?.name;
    if (warningName === 'YAMLWarning') return;
    if (typeof warning === 'string') {
        return originalEmitWarning(warning, name, code);
    }
    return originalEmitWarning(warning);
};

/** Silent logger so fuzzing does not spam stdout. */
export const fuzzLogger = createLogger('silent');

/** Decode fuzzer input as a UTF-8 string, replacing invalid sequences. */
export function dataToString(data) {
    return Buffer.from(data).toString('utf8');
}

/** Decode fuzzer input as the first whitespace-delimited token. */
export function dataToToken(data) {
    return dataToString(data).split(/\s+/)[0];
}
