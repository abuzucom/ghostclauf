const DEFAULT_CURRENCY_NAME = 'esports dollars';

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value);
}

function isBalance(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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

function collectLeaderboard(value: unknown): PublicLeaderboardEntry[] {
    const entries: Array<Omit<PublicLeaderboardEntry, 'rank'>> = [];
    for (const scope of Object.values(getScopes(value))) {
        if (!isRecord(scope) || !isRecord(scope.viewers)) continue;
        for (const viewer of Object.values(scope.viewers)) {
            if (!isRecord(viewer) || typeof viewer.displayName !== 'string') continue;
            if (!isBalance(viewer.balance)) continue;
            const displayName = viewer.displayName.trim();
            if (!displayName) continue;
            entries.push({ displayName, balance: viewer.balance });
        }
    }
    entries.sort(
        (left, right) =>
            right.balance - left.balance || left.displayName.localeCompare(right.displayName),
    );
    return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** Create a public-safe snapshot without retaining private store fields. */
export function createPublicSnapshot(input: PublicSnapshotInput): PublicSiteSnapshot {
    const leaderboard = collectLeaderboard(input.loyalty);
    const totalBalance = leaderboard.reduce((total, entry) => total + entry.balance, 0);
    return {
        version: 1,
        generatedAt: input.generatedAt.toISOString(),
        facts: collectFacts(input.funFacts),
        quotes: collectQuotes(input.quotes),
        loyalty: {
            currencyName: getCurrencyName(input.currencyName),
            participantCount: leaderboard.length,
            totalBalance,
            leaderboard,
        },
    };
}
