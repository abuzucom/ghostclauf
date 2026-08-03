// Persisted shapes and config for the quotes plugin.

/** One curated community quote, with optional speaker attribution. */
export interface Quote {
    /** Monotonic id within the scope; never reused after a delete. */
    id: number;
    /** Sanitized single-line quote text. */
    text: string;
    /** Who said it, e.g. the streamer or a memorable chatter. Optional. */
    speaker: string | null;
    /** Chatter id of the curator who added it (audit trail). */
    addedByChatterId: string;
    /** Display name shown in the !quote reply. */
    addedByDisplayName: string;
    /** Channel the quote was added in (audit trail). */
    addedInBroadcasterId: string;
    /** ISO 8601 UTC timestamp of the add. */
    addedAt: string;
}

/** One pool of quotes: the shared pool, or a single channel's pool. */
export interface QuoteScope {
    /** Id handed to the next added quote. */
    nextId: number;
    quotes: Quote[];
}

export interface QuoteData {
    version: 1;
    scopes: Record<string, QuoteScope>;
}

export interface QuotesConfig {
    /** Where the pool is persisted. Defaults to ./data/quotes.json. */
    dataPath?: string;
    /** Pool quotes across every configured channel. Defaults to true. */
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
