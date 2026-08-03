// Persisted shapes and config for the loyalty plugin.

/** One viewer's balance within a scope. */
export interface ViewerRecord {
    displayName: string;
    balance: number;
}

/** One pool of balances: the shared pool, or a single channel's pool. */
export interface LoyaltyScope {
    viewers: Record<string, ViewerRecord>;
}

export interface LoyaltyData {
    version: 1;
    scopes: Record<string, LoyaltyScope>;
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
