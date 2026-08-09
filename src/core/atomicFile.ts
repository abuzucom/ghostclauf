// Shared atomic JSON writer for plugin-owned journals: write a temp file, then
// rename it over the target so a crash mid-write never leaves a truncated
// database. One previous snapshot is kept alongside as `.bak`.

import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Owner-only. These files hold viewer chatter IDs, logins, and display names,
 * and sit next to the OAuth token store in ./data.
 */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

/**
 * Windows fails a rename onto an open target instead of replacing it, so a
 * transient reader - Defender, the search indexer, a backup agent, or a
 * concurrent write to the same path - surfaces as one of these. POSIX
 * replaces atomically and never reports them here.
 */
const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_BASE_MS = 10;

function isRenameContention(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && RENAME_CONTENTION_CODES.has(code);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rename, retrying while the target is momentarily locked. The lock is held by
 * whoever opened the file, so backing off and retrying is the only remedy;
 * the last attempt rethrows so a genuine permission error still surfaces.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            if (attempt === RENAME_ATTEMPTS || !isRenameContention(error)) throw error;
            await delay(RENAME_RETRY_BASE_MS * attempt);
        }
    }
}

/**
 * Persist one JSON document through atomic replacement. A single owning store
 * must serialize write calls; this class protects file replacement, not the
 * store's read-modify-write lifecycle.
 */
export class AtomicJsonFile {
    private writeSeq = 0;
    private hasPersisted = false;

    constructor(private readonly path: string) {}

    /** Record that the target already exists, so the next write snapshots it. */
    markExisting(): void {
        this.hasPersisted = true;
    }

    async write(json: string): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true, mode: DIRECTORY_MODE });
        // Unique per write so two in-flight writes cannot share a temp path.
        this.writeSeq += 1;
        if (this.hasPersisted) {
            const backupTemp = `${this.path}.bak.${this.writeSeq}.tmp`;
            await copyFile(this.path, backupTemp);
            await chmod(backupTemp, FILE_MODE);
            await renameWithRetry(backupTemp, `${this.path}.bak`);
        }
        const tempPath = `${this.path}.${this.writeSeq}.tmp`;
        // mode on writeFile applies only when creating; chmod covers a reused
        // temp path left behind by an earlier crash.
        await writeFile(tempPath, json, { encoding: 'utf8', mode: FILE_MODE });
        await chmod(tempPath, FILE_MODE);
        await renameWithRetry(tempPath, this.path);
        this.hasPersisted = true;
    }
}
