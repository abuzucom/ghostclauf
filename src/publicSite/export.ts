import { HIDDEN_NAME_PLACEHOLDER } from '../plugins/loyalty/loyalty.js';

const DEFAULT_CURRENCY_NAME = 'esports dollars';
const MAX_LOYALTY_BALANCE = 1_000_000_000;
/** Matches loyalty's own !economy default, so chat and site show the same rows. */
export const DEFAULT_PUBLIC_LEADERBOARD_SIZE = 5;
export const MAX_PUBLIC_LEADERBOARD_SIZE = 25;

export interface PublicFact {
    id: number;
    text: string;
}

export interface PublicQuote extends PublicFact {
    speaker: string | null;
}

export interface PublicLeaderboardEntry {
    rank: number;
    displayName: string;
    balance: number;
}

export interface PublicSiteSnapshot {
    version: 1;
    generatedAt: string;
    facts: PublicFact[];
    quotes: PublicQuote[];
    loyalty: {
        currencyName: string;
        participantCount: number;
        totalBalance: number;
        leaderboard: PublicLeaderboardEntry[];
    };
}

export interface PublicSnapshotInput {
    currencyName: string;
    generatedAt: Date;
    funFacts: unknown;
    quotes: unknown;
    loyalty: unknown;
    /** Rows published on the leaderboard. Defaults to DEFAULT_PUBLIC_LEADERBOARD_SIZE. */
    leaderboardSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

function isBalance(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= MAX_LOYALTY_BALANCE
    );
}

function getScopes(value: unknown): Record<string, unknown> {
    if (!isRecord(value) || !isRecord(value.scopes)) return {};
    return value.scopes;
}

function getCurrencyName(value: string): string {
    const currencyName = value.trim();
    return currencyName || DEFAULT_CURRENCY_NAME;
}

function collectFacts(value: unknown): PublicFact[] {
    const facts: PublicFact[] = [];
    for (const scope of Object.values(getScopes(value))) {
        if (!isRecord(scope) || !Array.isArray(scope.facts)) continue;
        for (const fact of scope.facts) {
            if (!isRecord(fact) || !isInteger(fact.id) || typeof fact.text !== 'string') {
                continue;
            }
            facts.push({ id: fact.id, text: fact.text });
        }
    }
    return facts;
}

function collectQuotes(value: unknown): PublicQuote[] {
    const quotes: PublicQuote[] = [];
    for (const scope of Object.values(getScopes(value))) {
        if (!isRecord(scope) || !Array.isArray(scope.quotes)) continue;
        for (const quote of scope.quotes) {
            if (!isRecord(quote) || !isInteger(quote.id) || typeof quote.text !== 'string') {
                continue;
            }
            const speaker = typeof quote.speaker === 'string' ? quote.speaker : null;
            quotes.push({ id: quote.id, text: quote.text, speaker });
        }
    }
    return quotes;
}

/**
 * Chatter ids hidden with !hidestats. Any id present is hidden whatever its
 * value, and a list that is not an object stops the export: publishing names
 * people asked to hide is worse than publishing nothing.
 */
function getHiddenIds(value: unknown): ReadonlySet<string> {
    if (!isRecord(value) || value.hiddenViewers === undefined) return new Set();
    if (!isRecord(value.hiddenViewers)) {
        throw new Error('loyalty hiddenViewers is malformed; refusing to publish names.');
    }
    return new Set(Object.keys(value.hiddenViewers));
}

/** Every valid loyalty row, with hidden names already replaced, sorted for ranking. */
function collectLoyaltyRows(value: unknown): Array<Omit<PublicLeaderboardEntry, 'rank'>> {
    const hiddenIds = getHiddenIds(value);
    const entries: Array<Omit<PublicLeaderboardEntry, 'rank'>> = [];
    for (const scope of Object.values(getScopes(value))) {
        if (!isRecord(scope) || !isRecord(scope.viewers)) continue;
        for (const [chatterId, viewer] of Object.entries(scope.viewers)) {
            if (!isRecord(viewer) || typeof viewer.displayName !== 'string') continue;
            if (!isBalance(viewer.balance)) continue;
            const displayName = viewer.displayName.trim();
            if (!displayName) continue;
            entries.push({
                displayName: hiddenIds.has(chatterId) ? HIDDEN_NAME_PLACEHOLDER : displayName,
                balance: viewer.balance,
            });
        }
    }
    // Ties sort on the shown name, so a hidden name's position reveals nothing.
    entries.sort(
        (left, right) =>
            right.balance - left.balance || left.displayName.localeCompare(right.displayName),
    );
    return entries;
}

/** Create a public-safe snapshot without retaining private store fields. */
export function createPublicSnapshot(input: PublicSnapshotInput): PublicSiteSnapshot {
    const rows = collectLoyaltyRows(input.loyalty);
    const totalBalance = rows.reduce((total, entry) => total + entry.balance, 0);
    const leaderboard = rows
        .slice(0, input.leaderboardSize ?? DEFAULT_PUBLIC_LEADERBOARD_SIZE)
        .map((entry, index) => ({ ...entry, rank: index + 1 }));
    return {
        version: 1,
        generatedAt: input.generatedAt.toISOString(),
        facts: collectFacts(input.funFacts),
        quotes: collectQuotes(input.quotes),
        loyalty: {
            currencyName: getCurrencyName(input.currencyName),
            participantCount: rows.length,
            totalBalance,
            leaderboard,
        },
    };
}
