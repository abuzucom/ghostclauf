// Pure helpers for the loyalty plugin: balance math and chat rendering. Kept
// free of I/O so they are unit testable without a store.

import type { LeaderboardEntry, ViewerRecord } from './types.js';

/** Apply an award to a balance. Floors at 0 (never relevant for a positive
 * award today, but keeps the invariant explicit for any future spend path). */
export function applyAward(currentBalance: number, amount: number): number {
    return Math.max(0, currentBalance + amount);
}

/**
 * Digits only, length-bounded before Number() ever runs. !setESD/!giveESD/
 * !takeESD write straight into a balance, so the argument must be a plain
 * decimal integer literal - no arithmetic, no expression evaluation, no
 * alternate bases or notations. Matches the pattern funfact's parseFactId and
 * streak's parseStreakValue already use for the same reason.
 */
const ESD_AMOUNT_PATTERN = /^[0-9]{1,10}$/;

/** Parse a !setESD/!giveESD/!takeESD amount argument. */
export function parseEsdAmount(token: string | undefined): number | null {
    if (token === undefined || !ESD_AMOUNT_PATTERN.test(token)) return null;
    const amount = Number(token);
    return Number.isSafeInteger(amount) ? amount : null;
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

/** Which broadcaster-only balance command produced a decision. Mirrors
 * `DecisionKind` in ./store.ts by value - not imported from it, since store.ts
 * already imports this module and a cross-import would cycle. */
export type EsdDecisionKind = 'set' | 'give' | 'take';

/** Render a usage hint for a malformed or missing admin-command argument. */
export function renderAdminUsage(usage: string): string {
    return truncateForChat(`Usage: ${usage}`);
}

/** Render a reply when an admin command's @user argument names no known Twitch user. */
export function renderAdminUnknownUser(login: string): string {
    return truncateForChat(`Could not find a Twitch user named ${login}.`);
}

/**
 * Render the result of !setESD/!giveESD/!takeESD. `requestedAmount` and
 * `actualAmount` differ when give/take clamped at 0 or MAX_BALANCE, which
 * gets called out rather than silently reported as if nothing clamped.
 */
export function renderAdjustDone(
    currencyName: string,
    kind: EsdDecisionKind,
    displayName: string,
    requestedAmount: number,
    actualAmount: number,
    balance: number,
): string {
    if (kind === 'set') {
        return truncateForChat(`Set ${displayName}'s ${currencyName} to ${balance}.`);
    }
    const clampedNote = actualAmount !== requestedAmount ? ' (clamped)' : '';
    const verb = kind === 'give' ? 'Gave' : 'Took';
    const preposition = kind === 'give' ? 'to' : 'from';
    return truncateForChat(
        `${verb} ${actualAmount} ${currencyName} ${preposition} ${displayName}${clampedNote}. New balance: ${balance}.`,
    );
}

/** Render the result of a successful !undo*ESD. */
export function renderUndoDone(
    currencyName: string,
    kind: EsdDecisionKind,
    displayName: string,
    balance: number,
): string {
    return truncateForChat(
        `Undid the last !${kind}ESD for ${displayName}. New balance: ${balance} ${currencyName}.`,
    );
}

/** Render the reply when there is nothing of that kind left to undo. */
export function renderUndoNone(kind: EsdDecisionKind, displayName: string): string {
    return truncateForChat(`Nothing to undo: no applied !${kind}ESD found for ${displayName}.`);
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
