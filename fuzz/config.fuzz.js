import { parseFileConfig } from '../dist/core/config.js';
import { dataToString } from './helpers.js';

export function fuzz(data) {
    try {
        parseFileConfig(dataToString(data));
    } catch {
        // Invalid config is expected; only crashes (uncaught exceptions) are
        // fuzzer findings.
    }
}
