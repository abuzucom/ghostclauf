import { randomUUID } from 'node:crypto';
import { readFile, rename } from 'node:fs/promises';
import { DateTime } from 'luxon';
import type { Logger } from '../../core/types.js';
import { AtomicJsonFile } from './atomicFile.js';

function toIsoString(date: Date): string {
    return DateTime.fromJSDate(date).toUTC().toISO()!;
}
import {
    applyBroadcasterCheckin,
    applyCheckin,
    newViewerRecord,
    previousStreamDay,
} from './streak.js';
import type {
    BroadcasterSession,
    ChannelRecord,
    CheckinOutcome,
    LegacyStreakData,
    StreakData,
    StreakPenaltyRecord,
    ViewerRecord,
} from './types.js';

const SHARED_SCOPE_KEY = 'shared';

/**
 * Resolved penalties retained per viewer, per channel. Keeps the audit trail
 * useful while bounding a file that is rewritten in full on every check-in.
 */
const MAX_RESOLVED_PENALTIES_PER_VIEWER = 50;

function emptyData(): StreakData {
    return { version: 2, channels: {} };
}

function emptyChannel(): ChannelRecord {
    return {
        streamDays: [],
        activeStreamStartedAt: null,
        qualifiedDaysByBroadcaster: {},
        sessionsByBroadcaster: {},
        viewers: {},
        penalties: [],
    };
}

function isViewerRecord(value: unknown): value is ViewerRecord {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Partial<ViewerRecord>;
    return (
        typeof record.chatterName === 'string' &&
        typeof record.displayName === 'string' &&
        Number.isFinite(record.currentStreak) &&
        Number.isFinite(record.longestStreak) &&
        Number.isFinite(record.totalCheckins) &&
        (record.lastCheckinDay === null || typeof record.lastCheckinDay === 'string') &&
        (record.missEvaluationAfterDay === undefined ||
            record.missEvaluationAfterDay === null ||
            typeof record.missEvaluationAfterDay === 'string') &&
        (record.lastManualDecisionId === undefined ||
            record.lastManualDecisionId === null ||
            typeof record.lastManualDecisionId === 'string') &&
        (record.lastManualTransactionId === undefined ||
            record.lastManualTransactionId === null ||
            typeof record.lastManualTransactionId === 'string')
    );
}

function isStringArrayRecord(value: unknown): value is Record<string, string[]> {
    if (typeof value !== 'object' || value === null) return false;
    return Object.values(value).every(
        (days) => Array.isArray(days) && days.every((day) => typeof day === 'string'),
    );
}

function isSession(value: unknown): value is BroadcasterSession {
    if (typeof value !== 'object' || value === null) return false;
    const session = value as Partial<BroadcasterSession>;
    const nullableString = (candidate: unknown): boolean =>
        candidate === null || typeof candidate === 'string';
    return (
        nullableString(session.logicalDay) &&
        nullableString(session.logicalSessionStartedAt) &&
        nullableString(session.currentIntervalStartedAt) &&
        nullableString(session.currentStreamId) &&
        nullableString(session.lastOfflineAt) &&
        nullableString(session.pendingOfflineAt) &&
        ['offline', 'live', 'pending-offline', 'unverified-offline'].includes(session.status ?? '')
    );
}

function isNullableString(value: unknown): boolean {
    return value === null || typeof value === 'string';
}

function isPenalty(value: unknown): value is StreakPenaltyRecord {
    if (typeof value !== 'object' || value === null) return false;
    const penalty = value as Partial<StreakPenaltyRecord>;
    return (
        typeof penalty.id === 'string' &&
        typeof penalty.chatterId === 'string' &&
        typeof penalty.checkinDay === 'string' &&
        typeof penalty.broadcasterId === 'string' &&
        typeof penalty.recordedAt === 'string' &&
        Number.isFinite(penalty.lostAmount) &&
        // Every reader tests these against null. An absent field would read as
        // "already repaired" and hide the penalty from !fixstreak, so require
        // them to be present rather than defaulting them.
        isNullableString(penalty.restoredAt) &&
        isNullableString(penalty.restoredByChatterId) &&
        isNullableString(penalty.restoredByBroadcasterId) &&
        isNullableString(penalty.supersededAt) &&
        isViewerRecord(penalty.before) &&
        isViewerRecord(penalty.after)
    );
}

function isChannelRecord(value: unknown): value is ChannelRecord {
    if (typeof value !== 'object' || value === null) return false;
    const channel = value as Partial<ChannelRecord>;
    if (!Array.isArray(channel.streamDays) || !channel.streamDays.every(isString)) return false;
    if (
        channel.activeStreamStartedAt !== null &&
        typeof channel.activeStreamStartedAt !== 'string'
    ) {
        return false;
    }
    if (!isStringArrayRecord(channel.qualifiedDaysByBroadcaster)) return false;
    if (
        typeof channel.sessionsByBroadcaster !== 'object' ||
        channel.sessionsByBroadcaster === null
    ) {
        return false;
    }
    if (!Object.values(channel.sessionsByBroadcaster).every(isSession)) return false;
    if (typeof channel.viewers !== 'object' || channel.viewers === null) return false;
    if (!Object.values(channel.viewers).every(isViewerRecord)) return false;
    return Array.isArray(channel.penalties) && channel.penalties.every(isPenalty);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isStreakData(value: unknown): value is StreakData {
    if (typeof value !== 'object' || value === null) return false;
    const data = value as Partial<StreakData>;
    return (
        data.version === 2 &&
        typeof data.channels === 'object' &&
        data.channels !== null &&
        Object.values(data.channels).every(isChannelRecord)
    );
}

function isLegacyData(value: unknown): value is LegacyStreakData {
    if (typeof value !== 'object' || value === null) return false;
    const data = value as Partial<LegacyStreakData>;
    if (data.version !== 1 || typeof data.channels !== 'object' || data.channels === null)
        return false;
    return Object.values(data.channels).every((candidate) => {
        if (typeof candidate !== 'object' || candidate === null) return false;
        const channel = candidate;
        return (
            Array.isArray(channel.streamDays) &&
            channel.streamDays.every(isString) &&
            (channel.activeStreamStartedAt === undefined ||
                channel.activeStreamStartedAt === null ||
                typeof channel.activeStreamStartedAt === 'string') &&
            typeof channel.viewers === 'object' &&
            channel.viewers !== null &&
            Object.values(channel.viewers).every(isViewerRecord)
        );
    });
}

function migrateLegacy(data: LegacyStreakData): StreakData {
    const migrated = emptyData();
    for (const [scope, legacy] of Object.entries(data.channels)) {
        const channel = emptyChannel();
        channel.streamDays = [...new Set(legacy.streamDays)].sort();
        channel.activeStreamStartedAt = legacy.activeStreamStartedAt ?? null;
        channel.viewers = legacy.viewers;
        if (scope !== SHARED_SCOPE_KEY) {
            channel.qualifiedDaysByBroadcaster[scope] = [...channel.streamDays];
        }
        migrated.channels[scope] = channel;
    }
    return migrated;
}

function parseData(raw: string): StreakData {
    const parsed: unknown = JSON.parse(raw);
    if (isStreakData(parsed)) return parsed;
    if (isLegacyData(parsed)) return migrateLegacy(parsed);
    throw new Error('unexpected streak data shape');
}

function cloneViewer(viewer: ViewerRecord): ViewerRecord {
    return { ...viewer };
}

export class StreakStore {
    private data: StreakData = emptyData();
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
            this.logger.error({ err, dataPath: this.dataPath }, 'failed to read streak data file');
            throw err;
        }
        try {
            this.data = parseData(raw);
            this.file.markExisting();
        } catch (err) {
            await this.backupCorruptFile(err);
            this.data = await this.loadPreviousBackup();
        }
        await this.prunePenaltyHistory();
    }

    /**
     * Trim resolved penalty history at startup, when no command is mid-flight.
     * Unrepaired penalties are never dropped, so !fixstreak still reaches them.
     */
    private async prunePenaltyHistory(): Promise<void> {
        let removed = 0;
        for (const channel of Object.values(this.data.channels)) {
            const pruned = pruneResolvedPenalties(channel.penalties);
            removed += channel.penalties.length - pruned.length;
            channel.penalties = pruned;
        }
        if (removed === 0) return;
        this.logger.info({ removed }, 'pruned resolved streak penalties');
        await this.persist();
    }

    private async loadPreviousBackup(): Promise<StreakData> {
        try {
            const raw = await readFile(`${this.dataPath}.bak`, 'utf8');
            const restored = parseData(raw);
            this.logger.warn({ dataPath: this.dataPath }, 'loaded previous streak database backup');
            return restored;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({ err }, 'failed to load previous streak database backup');
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
                'streak data file was unreadable; preserved it before recovery',
            );
        } catch (renameErr) {
            this.logger.error({ err: renameErr }, 'failed to preserve corrupt streak data file');
        }
    }

    private channel(channelKey: string): ChannelRecord {
        const existing = this.data.channels[channelKey];
        if (existing) return existing;
        const created = emptyChannel();
        this.data.channels[channelKey] = created;
        return created;
    }

    streamDays(channelKey: string): string[] {
        return [...(this.data.channels[channelKey]?.streamDays ?? [])];
    }

    hasStreamDay(channelKey: string, day: string): boolean {
        return this.data.channels[channelKey]?.streamDays.includes(day) ?? false;
    }

    async recordStreamDay(channelKey: string, day: string, startedAt: Date): Promise<boolean> {
        const channel = this.channel(channelKey);
        const isNewDay = addSortedDay(channel.streamDays, day);
        const startedAtIso = toIsoString(startedAt);
        const previousAnchor = channel.activeStreamStartedAt;
        const anchorChanged = previousAnchor === null || startedAtIso > previousAnchor;
        if (anchorChanged) channel.activeStreamStartedAt = startedAtIso;
        if (isNewDay || anchorChanged) await this.persist();
        return isNewDay;
    }

    activeStreamStartedAt(channelKey: string): Date | null {
        const iso = this.data.channels[channelKey]?.activeStreamStartedAt;
        return iso ? new Date(iso) : null;
    }

    async recordQualifiedDay(scope: string, broadcasterId: string, day: string): Promise<boolean> {
        const channel = this.channel(scope);
        const days = (channel.qualifiedDaysByBroadcaster[broadcasterId] ??= []);
        const added = addSortedDay(days, day);
        if (added) await this.persist();
        return added;
    }

    missedBroadcasters(
        scope: string,
        afterDay: string | null,
        beforeDay: string,
        requiredBroadcasterIds: ReadonlySet<string>,
    ): Set<string> {
        if (afterDay === null) return new Set();
        const qualified = this.data.channels[scope]?.qualifiedDaysByBroadcaster ?? {};
        return new Set(
            [...requiredBroadcasterIds].filter((id) =>
                (qualified[id] ?? []).some((day) => day > afterDay && day < beforeDay),
            ),
        );
    }

    getSession(scope: string, broadcasterId: string): BroadcasterSession | undefined {
        const session = this.data.channels[scope]?.sessionsByBroadcaster[broadcasterId];
        return session ? { ...session } : undefined;
    }

    async setSession(
        scope: string,
        broadcasterId: string,
        session: BroadcasterSession,
    ): Promise<void> {
        this.channel(scope).sessionsByBroadcaster[broadcasterId] = { ...session };
        await this.persist();
    }

    getViewer(channelKey: string, chatterId: string): ViewerRecord | undefined {
        return this.data.channels[channelKey]?.viewers[chatterId];
    }

    getManualTransactionId(scope: string, chatterId: string): string | null {
        return this.data.channels[scope]?.viewers[chatterId]?.lastManualTransactionId ?? null;
    }

    findViewerByName(
        channelKey: string,
        login: string,
    ): { chatterId: string; viewer: ViewerRecord } | undefined {
        const wanted = login.toLowerCase();
        const viewers = this.data.channels[channelKey]?.viewers ?? {};
        for (const [chatterId, viewer] of Object.entries(viewers)) {
            if (viewer.chatterName === wanted) return { chatterId, viewer };
        }
        return undefined;
    }

    async checkIn(
        channelKey: string,
        chatterId: string,
        chatterName: string,
        displayName: string,
        today: string,
    ): Promise<{ outcome: CheckinOutcome; viewer: ViewerRecord }> {
        const channel = this.channel(channelKey);
        const current = channel.viewers[chatterId] ?? newViewerRecord(chatterName, displayName);
        const previous = previousStreamDay(channel.streamDays, today);
        const result = applyCheckin(current, today, previous);
        const updated = updateIdentity(result.viewer, chatterName, displayName);
        if (result.outcome !== 'already') updated.missEvaluationAfterDay = today;
        channel.viewers[chatterId] = updated;
        await this.persist();
        return { outcome: result.outcome, viewer: updated };
    }

    async checkInBroadcaster(
        scope: string,
        chatterId: string,
        chatterName: string,
        displayName: string,
        today: string,
        requiredBroadcasterIds: ReadonlySet<string>,
        broadcasterId: string,
        recordedAt: Date = new Date(),
    ): Promise<{ outcome: CheckinOutcome; viewer: ViewerRecord }> {
        const channel = this.channel(scope);
        const current = channel.viewers[chatterId] ?? newViewerRecord(chatterName, displayName);
        const baseline = current.missEvaluationAfterDay ?? current.lastCheckinDay;
        const missed = this.missedBroadcasters(scope, baseline, today, requiredBroadcasterIds);
        const result = applyBroadcasterCheckin(current, today, missed, requiredBroadcasterIds);
        const updated = updateIdentity(result.viewer, chatterName, displayName);
        if (result.outcome !== 'already') updated.missEvaluationAfterDay = today;
        channel.viewers[chatterId] = updated;
        if (result.lostAmount > 0) {
            channel.penalties.push(
                createPenalty(
                    chatterId,
                    broadcasterId,
                    today,
                    recordedAt,
                    current,
                    updated,
                    result.lostAmount,
                ),
            );
        }
        await this.persist();
        return { outcome: result.outcome, viewer: updated };
    }

    async fixLatestPenalty(
        scope: string,
        chatterId: string,
        restoredByChatterId: string,
        restoredByBroadcasterId: string,
        restoredAt: Date = new Date(),
    ): Promise<{ amount: number; currentStreak: number } | null> {
        const channel = this.data.channels[scope];
        const viewer = channel?.viewers[chatterId];
        if (!channel || !viewer) return null;
        const penalty = [...channel.penalties]
            .reverse()
            .find(
                (candidate) =>
                    candidate.chatterId === chatterId &&
                    candidate.restoredAt === null &&
                    candidate.supersededAt === null,
            );
        if (!penalty) return null;
        viewer.currentStreak += penalty.lostAmount;
        viewer.longestStreak = Math.max(viewer.longestStreak, viewer.currentStreak);
        penalty.restoredAt = toIsoString(restoredAt);
        penalty.restoredByChatterId = restoredByChatterId;
        penalty.restoredByBroadcasterId = restoredByBroadcasterId;
        await this.persist();
        return { amount: penalty.lostAmount, currentStreak: viewer.currentStreak };
    }

    hasUnrepairedPenaltyAfter(scope: string, chatterId: string, afterIso: string): boolean {
        return (
            this.data.channels[scope]?.penalties.some(
                (penalty) =>
                    penalty.chatterId === chatterId &&
                    penalty.recordedAt > afterIso &&
                    penalty.restoredAt === null &&
                    penalty.supersededAt === null,
            ) ?? false
        );
    }

    async applyStreakAdjustment(
        scope: string,
        chatterId: string,
        adjustment: number,
        previousLongest: number,
        transactionId?: string,
        previousDecisionId?: string | null,
    ): Promise<number | null> {
        const viewer = this.data.channels[scope]?.viewers[chatterId];
        if (!viewer) return null;
        const currentStreak = viewer.currentStreak - adjustment;
        if (!Number.isSafeInteger(currentStreak) || currentStreak < 0) return null;
        viewer.currentStreak = currentStreak;
        viewer.longestStreak = Math.max(previousLongest, currentStreak);
        if (transactionId !== undefined) {
            viewer.lastManualTransactionId = transactionId;
            viewer.lastManualDecisionId = previousDecisionId ?? null;
        }
        await this.persist();
        return currentStreak;
    }

    async resetViewer(
        channelKey: string,
        chatterId: string,
        now: Date = new Date(),
    ): Promise<void> {
        const channel = this.data.channels[channelKey];
        const viewer = channel?.viewers[chatterId];
        if (!channel || !viewer) return;
        viewer.currentStreak = 0;
        viewer.lastCheckinDay = null;
        viewer.missEvaluationAfterDay = latestRecordedDay(channel);
        viewer.lastManualDecisionId = null;
        viewer.lastManualTransactionId = null;
        supersedePenalties(channel, chatterId, now);
        await this.persist();
    }

    async setViewerStreak(
        channelKey: string,
        chatterId: string,
        value: number,
        now: Date = new Date(),
        transactionId?: string,
    ): Promise<void> {
        const channel = this.data.channels[channelKey];
        const viewer = channel?.viewers[chatterId];
        if (!channel || !viewer) return;
        viewer.currentStreak = value;
        viewer.longestStreak = Math.max(viewer.longestStreak, value);
        viewer.missEvaluationAfterDay = latestRecordedDay(channel);
        if (transactionId !== undefined) {
            viewer.lastManualDecisionId = transactionId;
            viewer.lastManualTransactionId = transactionId;
        }
        supersedePenalties(channel, chatterId, now);
        await this.persist();
    }

    private persist(): Promise<void> {
        if (this.pendingWrite) return this.pendingWrite;
        const write = this.saveChain.then(async () => {
            this.pendingWrite = null;
            await this.file.write(JSON.stringify(this.data, null, 2));
        });
        this.pendingWrite = write;
        // Keep the queue usable after a failed write. The caller still receives
        // `write` and its rejection, while later commands can attempt recovery.
        this.saveChain = write.catch((error: unknown) => {
            this.logger.error({ err: error }, 'streak store write failed');
        });
        return write;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}

function addSortedDay(days: string[], day: string): boolean {
    if (days.includes(day)) return false;
    days.push(day);
    days.sort();
    return true;
}

function updateIdentity(
    viewer: ViewerRecord,
    chatterName: string,
    displayName: string,
): ViewerRecord {
    return { ...viewer, chatterName: chatterName.toLowerCase(), displayName };
}

function createPenalty(
    chatterId: string,
    broadcasterId: string,
    checkinDay: string,
    recordedAt: Date,
    before: ViewerRecord,
    after: ViewerRecord,
    lostAmount: number,
): StreakPenaltyRecord {
    return {
        id: randomUUID(),
        chatterId,
        chatterName: after.chatterName,
        displayName: after.displayName,
        checkinDay,
        broadcasterId,
        recordedAt: toIsoString(recordedAt),
        lostAmount,
        before: cloneViewer(before),
        after: cloneViewer(after),
        restoredAt: null,
        restoredByChatterId: null,
        restoredByBroadcasterId: null,
        supersededAt: null,
    };
}

function latestRecordedDay(channel: ChannelRecord): string | null {
    const days = [
        ...channel.streamDays,
        ...Object.values(channel.qualifiedDaysByBroadcaster).flat(),
    ].sort();
    return days.at(-1) ?? null;
}

/**
 * Drop the oldest repaired or superseded penalties per viewer once they exceed
 * MAX_RESOLVED_PENALTIES_PER_VIEWER. Unrepaired penalties are always kept.
 */
function pruneResolvedPenalties(penalties: StreakPenaltyRecord[]): StreakPenaltyRecord[] {
    const seen = new Map<string, number>();
    const keep = new Set<StreakPenaltyRecord>();
    for (let i = penalties.length - 1; i >= 0; i -= 1) {
        const penalty = penalties[i]!;
        if (penalty.restoredAt === null && penalty.supersededAt === null) {
            keep.add(penalty);
            continue;
        }
        const count = seen.get(penalty.chatterId) ?? 0;
        if (count < MAX_RESOLVED_PENALTIES_PER_VIEWER) {
            keep.add(penalty);
            seen.set(penalty.chatterId, count + 1);
        }
    }
    return penalties.filter((penalty) => keep.has(penalty));
}

function supersedePenalties(channel: ChannelRecord, chatterId: string, now: Date): void {
    const timestamp = toIsoString(now);
    for (const penalty of channel.penalties) {
        if (
            penalty.chatterId === chatterId &&
            penalty.restoredAt === null &&
            penalty.supersededAt === null
        ) {
            penalty.supersededAt = timestamp;
        }
    }
}
