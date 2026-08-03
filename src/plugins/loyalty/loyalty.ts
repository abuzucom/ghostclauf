// Pure helpers for the loyalty plugin: balance math and chat rendering. Kept
// free of I/O so they are unit testable without a store.

import type { LeaderboardEntry, ViewerRecord } from './types.js';

/** Apply an award to a balance. Floors at 0 (never relevant for a positive
 * award today, but keeps the invariant explicit for any future spend path). */
export function applyAward(currentBalance: number, amount: number): number {
    return Math.max(0, currentBalance + amount);
}

/** Render a !points balance reply. */
export function renderBalance(currencyName: string, displayName: string, balance: number): string {
    return `${displayName} has ${balance} ${currencyName}.`;
}

/** Render a !pointsboard reply, or a message for an empty pool. */
export function renderLeaderboard(currencyName: string, entries: LeaderboardEntry[]): string {
    if (entries.length === 0) return `No ${currencyName} earned yet.`;
    const ranked = entries
        .map((entry, index) => `${index + 1}. ${entry.displayName} (${entry.balance})`)
        .join(', ');
    return `Top ${currencyName}: ${ranked}`;
}

/** Sort viewer records into a leaderboard, highest balance first, ties broken by name. */
export function buildLeaderboard(
    viewers: Record<string, ViewerRecord>,
    limit: number,
): LeaderboardEntry[] {
    return Object.values(viewers)
        .filter((viewer) => viewer.balance > 0)
        .sort((a, b) => b.balance - a.balance || a.displayName.localeCompare(b.displayName))
        .slice(0, limit)
        .map(({ displayName, balance }) => ({ displayName, balance }));
}
