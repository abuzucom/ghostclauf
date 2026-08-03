// Persistence for loyalty balances. Mirrors the funfact/streak stores:
// hand-written type guards over the parsed JSON, a preserved copy of any
// unreadable file, and coalesced atomic writes.

import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { AtomicJsonFile } from '../../core/atomicFile.js';
import type { Logger } from '../../core/types.js';
import { applyAward } from './loyalty.js';
import type { LoyaltyData, LoyaltyScope, ViewerRecord } from './types.js';

/** Scope key used when balances are pooled across every configured channel. */
export const SHARED_SCOPE_KEY = 'shared';

/** Bound on a single award, so a misconfigured pointsPerTick cannot overflow a balance in one tick. */
export const MAX_AWARD = 1_000_000;
/** Bound on a stored balance. */
export const MAX_BALANCE = 1_000_000_000;

const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_CHATTER_ID_LENGTH = 64;
const MAX_SCOPE_KEY_LENGTH = 64;
/** Bound on viewers tracked per scope, so the file stays bounded under chatter churn. */
const MAX_VIEWERS_PER_SCOPE = 100_000;

const ViewerRecordSchema = z.object({
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    balance: z.number().int().min(0).max(MAX_BALANCE),
});

const ViewerMapSchema = z.record(z.string().min(1).max(MAX_CHATTER_ID_LENGTH), ViewerRecordSchema);

/**
 * Bounded on load as well as on write: the file is untrusted input, and a
 * hand-edited or corrupt one would otherwise load unboundedly many viewers.
 *
 * The count is checked before the per-viewer schema so an oversized map costs
 * one `Object.keys` rather than a full validation pass over every record.
 * This bounds post-parse work only - a file large enough to exhaust memory
 * does so in `JSON.parse`, before any schema runs.
 */
const BoundedViewerMapSchema = z
    .record(z.string(), z.unknown())
    .refine((viewers) => Object.keys(viewers).length <= MAX_VIEWERS_PER_SCOPE, {
        message: `a scope cannot hold more than ${MAX_VIEWERS_PER_SCOPE} viewers`,
    })
    .pipe(ViewerMapSchema);

const ScopeSchema = z.object({
    viewers: BoundedViewerMapSchema,
});

const DataSchema = z.object({
    version: z.literal(1),
    scopes: z.record(z.string().min(1).max(MAX_SCOPE_KEY_LENGTH), ScopeSchema),
});

/** True when a key satisfies the bounds the load schema puts on chatter ids. */
function isStorableKey(key: string): boolean {
    return key.length > 0 && key.length <= MAX_CHATTER_ID_LENGTH;
}

/**
 * Fit a display name to the length the load schema allows, falling back to the
 * chatter id when it is empty. Measured in UTF-16 units because that is what
 * zod's `.max()` counts; a cut that would strand the high half of a surrogate
 * pair drops that half rather than emitting a lone surrogate.
 */
function boundDisplayName(raw: string, fallback: string): string {
    if (raw.length > 0 && raw.length <= MAX_DISPLAY_NAME_LENGTH) return raw;
    if (raw.length === 0) return fallback;
    let cut = raw.slice(0, MAX_DISPLAY_NAME_LENGTH);
    const lastUnit = cut.charCodeAt(cut.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) cut = cut.slice(0, -1);
    return cut.length > 0 ? cut : fallback;
}

/** Scope/viewer maps use a null prototype so a key can never resolve to an
 * inherited `Object.prototype` member (e.g. "constructor"). */
function emptyScopes(): Record<string, LoyaltyScope> {
    return Object.create(null) as Record<string, LoyaltyScope>;
}

function emptyViewers(): Record<string, ViewerRecord> {
    return Object.create(null) as Record<string, ViewerRecord>;
}

function emptyData(): LoyaltyData {
    return { version: 1, scopes: emptyScopes() };
}

function emptyScope(): LoyaltyScope {
    return { viewers: emptyViewers() };
}

function parseData(raw: string): LoyaltyData {
    const parsed = DataSchema.parse(JSON.parse(raw));
    const scopes = emptyScopes();
    for (const [scopeKey, scope] of Object.entries(parsed.scopes)) {
        scopes[scopeKey] = { viewers: Object.assign(emptyViewers(), scope.viewers) };
    }
    return { version: 1, scopes };
}

export interface Award {
    chatterId: string;
    displayName: string;
    amount: number;
}

export class LoyaltyStore {
    private data: LoyaltyData = emptyData();
    private saveChain: Promise<void> = Promise.resolve();
    private pendingWrite: Promise<void> | null = null;
    private readonly file: AtomicJsonFile;

    constructor(
        private readonly dataPath: string,
        private readonly logger: Logger,
    ) {
        this.file = new AtomicJsonFile(dataPath);
    }

    async load(): Promise<void> {
        let raw: string;
        try {
            raw = await readFile(this.dataPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.data = await this.loadPreviousBackup();
                return;
            }
            this.logger.error({ err, dataPath: this.dataPath }, 'failed to read loyalty data file');
            throw err;
        }
        try {
            this.data = parseData(raw);
            this.file.markExisting();
        } catch (err) {
            await this.backupCorruptFile(err);
            this.data = await this.loadPreviousBackup();
        }
    }

    private async loadPreviousBackup(): Promise<LoyaltyData> {
        try {
            const raw = await readFile(`${this.dataPath}.bak`, 'utf8');
            const restored = parseData(raw);
            this.logger.warn(
                { dataPath: this.dataPath },
                'loaded previous loyalty database backup',
            );
            return restored;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({ err }, 'failed to load previous loyalty database backup');
            }
            return emptyData();
        }
    }

    private async backupCorruptFile(err: unknown): Promise<void> {
        const backupPath = `${this.dataPath}.corrupt-${Date.now()}`;
        try {
            await rename(this.dataPath, backupPath);
            this.logger.error(
                { err, backupPath },
                'loyalty data file was unreadable; preserved it before recovery',
            );
        } catch (renameErr) {
            this.logger.error({ err: renameErr }, 'failed to preserve corrupt loyalty data file');
        }
    }

    private scope(scopeKey: string): LoyaltyScope {
        const existing = this.data.scopes[scopeKey];
        if (existing) return existing;
        const created = emptyScope();
        this.data.scopes[scopeKey] = created;
        return created;
    }

    getBalance(scopeKey: string, chatterId: string): number {
        return this.data.scopes[scopeKey]?.viewers[chatterId]?.balance ?? 0;
    }

    getDisplayName(scopeKey: string, chatterId: string): string | undefined {
        return this.data.scopes[scopeKey]?.viewers[chatterId]?.displayName;
    }

    leaderboardViewers(scopeKey: string): Record<string, ViewerRecord> {
        return this.data.scopes[scopeKey]?.viewers ?? emptyViewers();
    }

    /**
     * Apply every award in one batch and persist once, so a tick over many
     * chatters is a single atomic write rather than one write per chatter.
     * Awards are clamped to [0, MAX_AWARD] and the resulting balance to
     * MAX_BALANCE before being applied.
     *
     * Each award is held to the same bounds the load schema enforces, so the
     * store cannot write a file it would later reject as corrupt. A non-finite
     * amount is the sharp edge: it survives clamping (`NaN === 0` is false),
     * serializes as `null`, and would fail validation on the next startup.
     */
    async awardMany(scopeKey: string, awards: readonly Award[]): Promise<void> {
        if (awards.length === 0) return;
        const scope = this.scope(scopeKey);
        let viewerCount = Object.keys(scope.viewers).length;
        let changed = false;
        for (const award of awards) {
            const clampedAmount = Math.max(0, Math.min(MAX_AWARD, award.amount));
            if (!Number.isFinite(clampedAmount) || clampedAmount === 0) continue;
            if (!isStorableKey(award.chatterId)) continue;
            const existing = scope.viewers[award.chatterId];
            const nextBalance = Math.min(
                MAX_BALANCE,
                applyAward(existing?.balance ?? 0, clampedAmount),
            );
            if (!existing) {
                if (viewerCount >= MAX_VIEWERS_PER_SCOPE) continue;
                viewerCount += 1;
            }
            scope.viewers[award.chatterId] = {
                displayName: boundDisplayName(award.displayName, award.chatterId),
                balance: nextBalance,
            };
            changed = true;
        }
        // Every award can clamp to zero or hit the viewer cap, leaving nothing
        // to write; skip the atomic write rather than rewriting the same file.
        if (!changed) return;
        await this.persist();
    }

    private persist(): Promise<void> {
        if (this.pendingWrite) return this.pendingWrite;
        const write = this.saveChain.then(async () => {
            this.pendingWrite = null;
            await this.file.write(JSON.stringify(this.data, null, 2));
        });
        this.pendingWrite = write;
        this.saveChain = write.catch(() => {});
        return write;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}
