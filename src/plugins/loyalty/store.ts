// Persistence for loyalty balances. Mirrors the funfact/streak stores:
// hand-written type guards over the parsed JSON, a preserved copy of any
// unreadable file, and coalesced atomic writes.

import { constants } from 'node:fs';
import { copyFile, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { AtomicJsonFile } from '../../core/atomicFile.js';
import type { Logger } from '../../core/types.js';
import { applyAward } from './loyalty.js';
import type {
    BalanceDecision,
    LoyaltyData,
    LoyaltyScope,
    RedemptionRecord,
    ViewerRecord,
} from './types.js';

/** Scope key used when balances are pooled across every configured channel. */
export const SHARED_SCOPE_KEY = 'shared';

/** Bound on a single award, so a misconfigured dollarsPerTick cannot overflow a balance in one tick. */
export const MAX_AWARD = 1_000_000;
/** Bound on a stored balance. */
export const MAX_BALANCE = 1_000_000_000;

const MAX_DISPLAY_NAME_LENGTH = 64;
const MAX_CHATTER_ID_LENGTH = 64;
const MAX_SCOPE_KEY_LENGTH = 64;
/** Bound on viewers tracked per scope, so the file stays bounded under chatter churn. */
const MAX_VIEWERS_PER_SCOPE = 100_000;
/** Bound on time-bucketed grant keys kept per viewer. */
const MAX_GRANT_KEYS_PER_VIEWER = 64;
/**
 * Grant keys with this prefix are NEVER pruned. The follow bonus pays once
 * ever, so its key is the only thing standing between the bot and an
 * unfollow/refollow farm - if it ages out, the farm reopens. Its cardinality
 * is bounded by the number of configured broadcasters, so keeping it forever
 * costs nothing. Every other prefix is time-bucketed and safe to age out.
 */
const PERMANENT_GRANT_PREFIX = 'follow:';

/**
 * Bound on resolved (undone) balance decisions kept per viewer, matching
 * streak's MAX_RESOLVED_PER_VIEWER. An 'applied' decision is never pruned -
 * it must stay reachable for undo indefinitely.
 */
const MAX_RESOLVED_DECISIONS_PER_VIEWER = 50;

/** Bound on a grant/redemption key, matching the other key bounds. */
const MAX_GRANT_KEY_LENGTH = 128;

const ViewerRecordSchema = z.object({
    displayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    balance: z.number().int().min(0).max(MAX_BALANCE),
    // Optional so a v1 record migrates as-is. z.object strips unknown keys, so
    // anything not declared here is silently dropped at load - these must be
    // listed or every guard and counter is lost on the next read.
    grants: z
        .record(z.string().min(1).max(MAX_GRANT_KEY_LENGTH), z.number().int().min(0))
        .optional(),
    spent: z.number().int().min(0).max(MAX_BALANCE).optional(),
    redeemed: z
        .record(z.string().min(1).max(MAX_GRANT_KEY_LENGTH), z.number().int().min(0))
        .optional(),
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
    redeemedTotals: z
        .record(z.string().min(1).max(MAX_GRANT_KEY_LENGTH), z.number().int().min(0))
        .optional(),
});

const ScopeMapSchema = z.record(z.string().min(1).max(MAX_SCOPE_KEY_LENGTH), ScopeSchema);

const DataSchemaV1 = z.object({
    version: z.literal(1),
    scopes: ScopeMapSchema,
});

const BalanceDecisionSchema: z.ZodType<BalanceDecision> = z.object({
    id: z.string(),
    scope: z.string(),
    kind: z.enum(['set', 'give', 'take']),
    chatterId: z.string(),
    chatterName: z.string(),
    displayName: z.string(),
    beforeBalance: z.number().int().min(0).max(MAX_BALANCE),
    afterBalance: z.number().int().min(0).max(MAX_BALANCE),
    requestedAmount: z.number().int().min(0).max(MAX_BALANCE),
    createdAt: z.string(),
    createdByChatterId: z.string(),
    createdByChatterName: z.string(),
    createdInBroadcasterId: z.string(),
    status: z.enum(['applied', 'undone']),
    undoneAt: z.string().nullable(),
    undoneByChatterId: z.string().nullable(),
});

const RedemptionRecordSchema: z.ZodType<RedemptionRecord> = z.object({
    id: z.string(),
    scope: z.string(),
    chatterId: z.string(),
    displayName: z.string(),
    itemId: z.string(),
    itemLabel: z.string(),
    cost: z.number().int().min(0).max(MAX_BALANCE),
    balanceBefore: z.number().int().min(0).max(MAX_BALANCE),
    balanceAfter: z.number().int().min(0).max(MAX_BALANCE),
    createdAt: z.string(),
    createdInBroadcasterId: z.string(),
});

const DataSchemaV2 = z.object({
    version: z.literal(2),
    scopes: ScopeMapSchema,
    // Parse rows independently below so one malformed audit row cannot
    // quarantine otherwise valid balances.
    decisions: z.array(z.unknown()).default([]),
    redemptions: z.array(z.unknown()).default([]),
});

/** Accepts either version; `parseData` normalizes v1 up to v2. */
const DataSchema = z.discriminatedUnion('version', [DataSchemaV1, DataSchemaV2]);

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
    return { version: 2, scopes: emptyScopes(), decisions: [], redemptions: [] };
}

function emptyScope(): LoyaltyScope {
    return { viewers: emptyViewers() };
}

/**
 * Parse either schema version, normalizing v1 up to v2. Every field v2 adds is
 * optional or defaulted, so the per-record migration is the identity - a v1
 * file simply gains empty journals.
 */
function parseData(raw: string): { data: LoyaltyData; wasV1: boolean } {
    const parsed = DataSchema.parse(JSON.parse(raw));
    const scopes = emptyScopes();
    for (const [scopeKey, scope] of Object.entries(parsed.scopes)) {
        scopes[scopeKey] = {
            viewers: Object.assign(emptyViewers(), scope.viewers),
            ...(scope.redeemedTotals ? { redeemedTotals: scope.redeemedTotals } : {}),
        };
    }
    if (parsed.version === 1) {
        return { data: { version: 2, scopes, decisions: [], redemptions: [] }, wasV1: true };
    }
    const decisions = parsed.decisions.flatMap((decision) => {
        const result = BalanceDecisionSchema.safeParse(decision);
        return result.success ? [result.data] : [];
    });
    const redemptions = parsed.redemptions.flatMap((redemption) => {
        const result = RedemptionRecordSchema.safeParse(redemption);
        return result.success ? [result.data] : [];
    });
    return {
        data: {
            version: 2,
            scopes,
            decisions,
            redemptions,
        },
        wasV1: false,
    };
}

/**
 * Trim time-bucketed grant keys to the newest MAX_GRANT_KEYS_PER_VIEWER,
 * keeping every permanent key regardless of the cap. Runs at load() only -
 * never mid-flight - matching how the streak journals prune.
 */
function pruneGrants(grants: Record<string, number>): Record<string, number> {
    const entries = Object.entries(grants);
    const permanent = entries.filter(([key]) => key.startsWith(PERMANENT_GRANT_PREFIX));
    const prunable = entries.filter(([key]) => !key.startsWith(PERMANENT_GRANT_PREFIX));
    if (prunable.length <= MAX_GRANT_KEYS_PER_VIEWER) return grants;
    const kept = prunable.sort(([, a], [, b]) => b - a).slice(0, MAX_GRANT_KEYS_PER_VIEWER);
    return Object.fromEntries([...permanent, ...kept]);
}

/** Apply grant pruning across every viewer in every scope. */
function pruneAllGrants(scopes: Record<string, LoyaltyScope>): void {
    for (const scope of Object.values(scopes)) {
        for (const viewer of Object.values(scope.viewers)) {
            if (viewer.grants) viewer.grants = pruneGrants(viewer.grants);
        }
    }
}

/**
 * Trim resolved (undone) balance decisions to the newest
 * MAX_RESOLVED_DECISIONS_PER_VIEWER per (scope, chatterId). An 'applied'
 * decision is kept regardless of count - undo must always be able to reach
 * it. Runs at load() only, matching decisionStore's pruneHistory.
 */
function pruneDecisions(decisions: BalanceDecision[]): BalanceDecision[] {
    const resolvedByViewer = new Map<string, BalanceDecision[]>();
    for (const decision of decisions) {
        if (decision.status !== 'undone') continue;
        const key = `${decision.scope}\u0000${decision.chatterId}`;
        const list = resolvedByViewer.get(key);
        if (list) list.push(decision);
        else resolvedByViewer.set(key, [decision]);
    }
    const dropped = new Set<BalanceDecision>();
    for (const resolved of resolvedByViewer.values()) {
        if (resolved.length <= MAX_RESOLVED_DECISIONS_PER_VIEWER) continue;
        resolved.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const decision of resolved.slice(
            0,
            resolved.length - MAX_RESOLVED_DECISIONS_PER_VIEWER,
        )) {
            dropped.add(decision);
        }
    }
    if (dropped.size === 0) return decisions;
    return decisions.filter((decision) => !dropped.has(decision));
}

/**
 * Render a journal timestamp. `toISO()` returns null only for an Invalid
 * DateTime, which never happens on the real `now()` clock - but a ledger
 * timestamp is exactly the kind of field that should never be allowed to
 * persist as `null`, so this falls all the way back to the system clock
 * rather than asserting a value that is not actually guaranteed.
 */
function toJournalTimestamp(now: DateTime): string {
    return now.toUTC().toISO() ?? now.toISO() ?? new Date().toISOString();
}

export interface Award {
    chatterId: string;
    displayName: string;
    amount: number;
}

export type DecisionKind = 'set' | 'give' | 'take';

export interface ApplyDecisionInput {
    scopeKey: string;
    kind: DecisionKind;
    chatterId: string;
    chatterName: string;
    displayName: string;
    /** What the operator asked for. For `set`, the target balance; for
     *  `give`/`take`, the amount to add or subtract. */
    requestedAmount: number;
    createdByChatterId: string;
    createdByChatterName: string;
    createdInBroadcasterId: string;
    now: DateTime;
}

export type ApplyDecisionResult =
    { ok: true; decision: BalanceDecision } | { ok: false; reason: 'unstorable' | 'viewer-cap' };

export interface UndoActor {
    chatterId: string;
}

export type UndoResult = { ok: true; decision: BalanceDecision; balance: number } | { ok: false };

export class LoyaltyStore {
    private data: LoyaltyData = emptyData();
    private saveChain: Promise<void> = Promise.resolve();
    private pendingWrite: Promise<void> | null = null;
    /** Set when the on-disk file was v1, so the first write snapshots it. */
    private upgradedFromV1 = false;
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
            const parsed = parseData(raw);
            this.data = parsed.data;
            this.upgradedFromV1 = parsed.wasV1;
            pruneAllGrants(this.data.scopes);
            this.data.decisions = pruneDecisions(this.data.decisions);
            this.file.markExisting();
        } catch (err) {
            await this.backupCorruptFile(err);
            this.data = await this.loadPreviousBackup();
        }
    }

    private async loadPreviousBackup(): Promise<LoyaltyData> {
        try {
            const raw = await readFile(`${this.dataPath}.bak`, 'utf8');
            const restored = parseData(raw).data;
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
                // Spread `existing` first so an award never drops the fields it
                // does not own - grants especially, since wiping those reopens
                // every one-shot bonus (the follow farm) on the next tick.
                ...existing,
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

    /**
     * Preserve the pristine v1 file before the first v2 write.
     *
     * `AtomicJsonFile` refreshes `.bak` on every write, so after two v2 writes
     * both it and the target are v2 - a rollback to a v1 build would reject
     * both, quarantine them as `.corrupt-*`, and appear to lose every balance.
     * This snapshot is written once and never overwritten, so it stays a
     * valid v1 file forever. `copyFile` with COPYFILE_EXCL fails if the
     * destination exists, which is the "never overwrite" guarantee.
     */
    private async snapshotV1IfNeeded(): Promise<void> {
        if (!this.upgradedFromV1) return;
        this.upgradedFromV1 = false;
        const snapshotPath = `${this.dataPath}.v1`;
        try {
            await copyFile(this.dataPath, snapshotPath, constants.COPYFILE_EXCL);
            this.logger.info({ snapshotPath }, 'preserved v1 loyalty data before upgrading to v2');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
            // Not fatal: the upgrade itself is still safe, the operator just
            // loses the rollback convenience. Surfacing it beats failing the write.
            this.logger.warn({ err, snapshotPath }, 'could not preserve v1 loyalty data');
        }
    }

    /**
     * Apply a broadcaster-issued balance change (!setESD/!giveESD/!takeESD)
     * and journal it in one write.
     *
     * The read-modify-write of the balance and the journal push happen
     * synchronously, before the only `await` in this method - Node cannot
     * interleave another call in between, so two admin commands issued back
     * to back cannot race each other's before/after snapshot.
     */
    async applyDecision(input: ApplyDecisionInput): Promise<ApplyDecisionResult> {
        if (!isStorableKey(input.chatterId)) return { ok: false, reason: 'unstorable' };
        const scope = this.scope(input.scopeKey);
        const existing = scope.viewers[input.chatterId];
        if (!existing && Object.keys(scope.viewers).length >= MAX_VIEWERS_PER_SCOPE) {
            return { ok: false, reason: 'viewer-cap' };
        }
        const before = existing?.balance ?? 0;
        const raw =
            input.kind === 'set'
                ? input.requestedAmount
                : input.kind === 'give'
                  ? before + input.requestedAmount
                  : before - input.requestedAmount;
        const after = Math.max(0, Math.min(MAX_BALANCE, raw));
        scope.viewers[input.chatterId] = {
            ...existing,
            displayName: boundDisplayName(input.displayName, input.chatterId),
            balance: after,
        };
        const decision: BalanceDecision = {
            id: randomUUID(),
            scope: input.scopeKey,
            kind: input.kind,
            chatterId: input.chatterId,
            chatterName: input.chatterName,
            displayName: input.displayName,
            beforeBalance: before,
            afterBalance: after,
            requestedAmount: input.requestedAmount,
            createdAt: toJournalTimestamp(input.now),
            createdByChatterId: input.createdByChatterId,
            createdByChatterName: input.createdByChatterName,
            createdInBroadcasterId: input.createdInBroadcasterId,
            status: 'applied',
            undoneAt: null,
            undoneByChatterId: null,
        };
        this.data.decisions.push(decision);
        await this.persist();
        return { ok: true, decision };
    }

    /**
     * Reverse the newest still-applied decision of `kind` for this viewer.
     *
     * Reverses the recorded delta (`afterBalance - beforeBalance`), not an
     * absolute restore to `beforeBalance` - so undoing a `give` leaves an
     * intervening `take` (or any earnings) standing, and undoing an old `set`
     * does not erase balance the viewer has earned since. Filtering by `kind`
     * means `!undogiveESD` reaches past an intervening `take` or `set` to the
     * last `give`, rather than only ever reversing the single latest change.
     *
     * The search, the mutation, and the journal update are synchronous, ahead
     * of the only `await` - the same no-interleaving guarantee as
     * `applyDecision`.
     */
    async undoLatest(
        scopeKey: string,
        chatterId: string,
        kind: DecisionKind,
        undoneBy: UndoActor,
        now: DateTime,
    ): Promise<UndoResult> {
        let target: BalanceDecision | undefined;
        for (let i = this.data.decisions.length - 1; i >= 0; i -= 1) {
            const candidate = this.data.decisions[i]!;
            if (
                candidate.scope === scopeKey &&
                candidate.chatterId === chatterId &&
                candidate.kind === kind &&
                candidate.status === 'applied'
            ) {
                target = candidate;
                break;
            }
        }
        if (!target) return { ok: false };
        const scope = this.scope(scopeKey);
        const existing = scope.viewers[chatterId];
        const currentBalance = existing?.balance ?? 0;
        const delta = target.afterBalance - target.beforeBalance;
        const restored = Math.max(0, Math.min(MAX_BALANCE, currentBalance - delta));
        // A decision can only exist for a viewer applyDecision already created,
        // so `existing` is always present in practice; the fallback keeps the
        // write well-typed rather than assuming that invariant holds forever.
        scope.viewers[chatterId] = {
            ...existing,
            displayName: existing?.displayName ?? chatterId,
            balance: restored,
        };
        target.status = 'undone';
        target.undoneAt = toJournalTimestamp(now);
        target.undoneByChatterId = undoneBy.chatterId;
        await this.persist();
        return { ok: true, decision: target, balance: restored };
    }

    private persist(): Promise<void> {
        if (this.pendingWrite) return this.pendingWrite;
        const write = this.saveChain.then(async () => {
            this.pendingWrite = null;
            await this.snapshotV1IfNeeded();
            await this.file.write(JSON.stringify(this.data, null, 2));
        });
        this.pendingWrite = write;
        // Keep the queue usable after a failed write. The caller still receives
        // `write` and its rejection, while later commands can attempt recovery.
        this.saveChain = write.catch((error: unknown) => {
            this.logger.error({ err: error }, 'loyalty store write failed');
        });
        return write;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}
