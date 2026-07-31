/** Configurable trigger words (without the command prefix). */
export interface StreakTriggers {
    checkin: string;
    streak: string;
    reset: string;
    set: string;
    open: string;
    fix: string;
    undoSet: string;
}

/** Message templates. Tokens include user, streak, longest, day, and amount. */
export interface StreakMessages {
    started: string;
    extended: string;
    already: string;
    notOpen: string;
    lookupSelf: string;
    lookupOther: string;
    lookupNone: string;
    reset: string;
    setDone: string;
    opened: string;
    fixDone: string;
    fixNone: string;
    undoDone: string;
    undoNone: string;
    undoBlocked: string;
    adminUsage: string;
    adminNotFound: string;
}

export type StreakBreakPolicy = 'previous-stream-day' | 'all-broadcasters';

/** The plugin's config block (`plugins.config.streak`), all optional. */
export interface StreakConfig {
    dataPath?: string;
    decisionPath?: string;
    timezone?: string;
    dayBoundaryHour?: number;
    reconnectGraceMinutes?: number;
    minimumQualifyingSessionMinutes?: number;
    streakBreakPolicy?: StreakBreakPolicy;
    requireStreamDay?: boolean;
    shareAcrossChannels?: boolean;
    streamSessionHours?: number;
    checkinCooldownSeconds?: number;
    triggers?: Partial<StreakTriggers>;
    messages?: Partial<StreakMessages>;
}

export interface ViewerRecord {
    chatterName: string;
    displayName: string;
    currentStreak: number;
    longestStreak: number;
    lastCheckinDay: string | null;
    /** Ignore qualified misses on or before this canonical admin baseline. */
    missEvaluationAfterDay?: string | null;
    /** Last authoritative set still represented by this viewer's value. */
    lastManualDecisionId?: string | null;
    /** Last cross-file transaction committed to the primary database. */
    lastManualTransactionId?: string | null;
    totalCheckins: number;
}

export type SessionStatus = 'offline' | 'live' | 'pending-offline' | 'unverified-offline';

export interface BroadcasterSession {
    logicalDay: string | null;
    logicalSessionStartedAt: string | null;
    currentIntervalStartedAt: string | null;
    currentStreamId: string | null;
    lastOfflineAt: string | null;
    pendingOfflineAt: string | null;
    status: SessionStatus;
}

export interface StreakPenaltyRecord {
    id: string;
    chatterId: string;
    chatterName: string;
    displayName: string;
    checkinDay: string;
    broadcasterId: string;
    recordedAt: string;
    lostAmount: number;
    before: ViewerRecord;
    after: ViewerRecord;
    restoredAt: string | null;
    restoredByChatterId: string | null;
    restoredByBroadcasterId: string | null;
    supersededAt: string | null;
}

export interface ChannelRecord {
    /** Legacy union retained for compatibility and independent-channel mode. */
    streamDays: string[];
    activeStreamStartedAt: string | null;
    qualifiedDaysByBroadcaster: Record<string, string[]>;
    sessionsByBroadcaster: Record<string, BroadcasterSession>;
    viewers: Record<string, ViewerRecord>;
    penalties: StreakPenaltyRecord[];
}

export interface StreakData {
    version: 2;
    channels: Record<string, ChannelRecord>;
}

export interface LegacyStreakData {
    version: 1;
    channels: Record<
        string,
        {
            streamDays: string[];
            activeStreamStartedAt?: string | null;
            viewers: Record<string, ViewerRecord>;
        }
    >;
}

export type CheckinOutcome = 'started' | 'extended' | 'already';
