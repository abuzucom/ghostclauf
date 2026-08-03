// Pure helpers for the loyalty plugin: balance math and chat rendering. Kept
// free of I/O so they are unit testable without a store.

import type { LeaderboardEntry, ViewerRecord } from './types.js';

/** Apply an award to a balance. Floors at 0 (never relevant for a positive
 * award today, but keeps the invariant explicit for any future spend path). */
export function applyAward(currentBalance: number, amount: number): number {
    return Math.max(0, currentBalance + amount);
}

/** Twitch's chat message limit; `ctx.say` throws past it, which would drop
 * the whole reply rather than shortening it. */
const MAX_CHAT_MESSAGE_LENGTH = 500;

/** Truncate by code point so a multi-byte character is never split. */
function truncateForChat(text: string): string {
    const codePoints = [...text];
    if (codePoints.length <= MAX_CHAT_MESSAGE_LENGTH) return text;
    return codePoints.slice(0, MAX_CHAT_MESSAGE_LENGTH).join('');
}

/** Render a !wallet balance reply. */
export function renderBalance(currencyName: string, displayName: string, balance: number): string {
    return truncateForChat(`${displayName} has ${balance} ${currencyName}.`);
}

/**
 * Render a !economy reply, or a message for an empty pool.
 *
 * A full leaderboard overruns Twitch's 500-character limit well before the
 * configurable maximum of 25 rows, so entries are added only while they fit
 * and the result is truncated as a final guarantee. Dropping whole trailing
 * rows keeps the reply readable instead of cutting one mid-name.
 */
export function renderLeaderboard(currencyName: string, entries: LeaderboardEntry[]): string {
    if (entries.length === 0) return truncateForChat(`No ${currencyName} earned yet.`);
    const prefix = `Top ${currencyName}: `;
    const ranked: string[] = [];
    for (const [index, entry] of entries.entries()) {
        const row = `${index + 1}. ${entry.displayName} (${entry.balance})`;
        const candidate = prefix + [...ranked, row].join(', ');
        if (ranked.length > 0 && [...candidate].length > MAX_CHAT_MESSAGE_LENGTH) break;
        ranked.push(row);
    }
    return truncateForChat(prefix + ranked.join(', '));
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
