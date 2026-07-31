// Shared atomic writer for the streak plugin's two JSON journals: write a
// temp file, then rename it over the target so a crash mid-write never leaves
// a truncated database. One previous snapshot is kept alongside as `.bak`.

import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Owner-only. These files hold viewer chatter IDs, logins, and display names,
 * and sit next to the OAuth token store in ./data.
 */
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

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
            await rename(backupTemp, `${this.path}.bak`);
        }
        const tempPath = `${this.path}.${this.writeSeq}.tmp`;
        // mode on writeFile applies only when creating; chmod covers a reused
        // temp path left behind by an earlier crash.
        await writeFile(tempPath, json, { encoding: 'utf8', mode: FILE_MODE });
        await chmod(tempPath, FILE_MODE);
        await rename(tempPath, this.path);
        this.hasPersisted = true;
    }
}
