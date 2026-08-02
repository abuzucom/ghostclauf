// Persisted shapes and config for the funfact plugin.

/** One curated fun fact, with the attribution shown by !funfact. */
export interface FunFact {
    /** Monotonic id within the scope; never reused after a delete. */
    id: number;
    /** Sanitized single-line fact text. */
    text: string;
    /** Chatter id of the broadcaster who added it (audit trail). */
    addedByChatterId: string;
    /** Display name shown in the !funfact reply. */
    addedByDisplayName: string;
    /** Channel the fact was added in (audit trail). */
    addedInBroadcasterId: string;
    /** ISO 8601 UTC timestamp of the add. */
    addedAt: string;
}

/** One pool of facts: the shared pool, or a single channel's pool. */
export interface FunFactScope {
    /** Id handed to the next added fact. */
    nextId: number;
    facts: FunFact[];
}

export interface FunFactData {
    version: 1;
    scopes: Record<string, FunFactScope>;
}

export interface FunFactConfig {
    /** Where the pool is persisted. Defaults to ./data/funfacts.json. */
    dataPath?: string;
    /** Pool facts across every configured channel. Defaults to true. */
    shareAcrossChannels?: boolean;
    /** Seconds between handled reads per chatter per channel. Defaults to 30. */
    cooldownSeconds?: number;
    /**
     * Broadcaster login (any case) -> chatter logins (any case) allowed to run
     * the curation commands on that channel despite their actual Twitch role.
     * For streamers who moderate each other's channels.
     */
    treatAsBroadcaster?: Record<string, string[]>;
}
