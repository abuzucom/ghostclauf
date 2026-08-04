// Persisted shapes and config for the loyalty plugin.

/**
 * A one-shot or idempotency-keyed bonus already paid to a viewer, e.g.
 * "follow:<broadcasterId>" or "sub:<broadcasterId>:<yyyy-MM>". Presence of the
 * key is the guard: a bonus is paid only when its key is absent.
 */
export type GrantKey = string;

/** One viewer's balance within a scope. */
export interface ViewerRecord {
    displayName: string;
    balance: number;
    /** Grant key -> unix ms awarded. Absent on records migrated from v1. */
    grants?: Record<GrantKey, number>;
    /** Lifetime spend, for reporting. */
    spent?: number;
    /** Reward id -> lifetime redemption count. Never pruned: limits read this,
     *  not the ledger, so pruning the ledger cannot restore an allowance. */
    redeemed?: Record<string, number>;
}

/** One pool of balances: the shared pool, or a single channel's pool. */
export interface LoyaltyScope {
    viewers: Record<string, ViewerRecord>;
    /** Reward id -> global redemption count across every viewer. */
    redeemedTotals?: Record<string, number>;
}

/** An authoritative balance change made by a broadcaster command. */
export interface BalanceDecision {
    id: string;
    scope: string;
    kind: 'set' | 'give' | 'take';
    chatterId: string;
    chatterName: string;
    displayName: string;
    beforeBalance: number;
    afterBalance: number;
    /** What was asked for; differs from the applied delta when give/take clamped. */
    requestedAmount: number;
    createdAt: string;
    createdByChatterId: string;
    createdByChatterName: string;
    createdInBroadcasterId: string;
    status: 'applied' | 'undone';
    undoneAt: string | null;
    undoneByChatterId: string | null;
}

/** One completed redemption. Append-only: there are no refunds. */
export interface RedemptionRecord {
    id: string;
    scope: string;
    chatterId: string;
    displayName: string;
    itemId: string;
    /** Captured at redemption time so a later config edit cannot rewrite history. */
    itemLabel: string;
    /** Captured: what was actually paid, not the current price. */
    cost: number;
    balanceBefore: number;
    balanceAfter: number;
    createdAt: string;
    createdInBroadcasterId: string;
}

export interface LoyaltyData {
    version: 2;
    scopes: Record<string, LoyaltyScope>;
    /** !setesd / !giveesd / !takeesd audit trail. */
    decisions: BalanceDecision[];
    /** !redeem audit trail. */
    redemptions: RedemptionRecord[];
}

export interface LoyaltyConfig {
    /** Where balances are persisted. Defaults to ./data/loyalty.json. */
    dataPath?: string;
    /** Pool balances across every configured channel. Defaults to true. */
    shareAcrossChannels?: boolean;
    /** What the currency is called in chat replies. Defaults to "esports dollars". */
    currencyName?: string;
    /** Awarded per tick to each chatter active since the last tick. Defaults to 1. */
    dollarsPerTick?: number;
    /** Minutes between ticks. Defaults to 5. */
    tickIntervalMinutes?: number;
    /** Seconds a chatter must wait between handled !wallet/!economy replies. Defaults to 10. */
    cooldownSeconds?: number;
    /** Rows shown by !economy. Defaults to 5. */
    leaderboardSize?: number;
}

/** One entry in a rendered leaderboard, ordered highest balance first. */
export interface LeaderboardEntry {
    displayName: string;
    balance: number;
}
