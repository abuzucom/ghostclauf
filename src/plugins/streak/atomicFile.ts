// Re-export of the shared atomic JSON writer, kept so the streak plugin's
// existing imports stay valid now that a second plugin needs the same writer.

export { AtomicJsonFile } from '../../core/atomicFile.js';
