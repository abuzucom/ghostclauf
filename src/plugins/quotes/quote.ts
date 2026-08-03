// Pure text handling for the quotes plugin: sanitize and validate submitted
// text, split off an optional " - <speaker>" attribution, and render a
// stored quote for chat. Kept free of I/O so it is unit testable without a
// store.

import type { Quote } from './types.js';

/**
 * Leaves room for the `Quote #NNN: "..." - <speaker> (added by <display>)`
 * wrapper inside Twitch's 500 character message limit.
 */
export const MAX_QUOTE_TEXT_LENGTH = 300;
export const MAX_SPEAKER_LENGTH = 50;

/** Twitch chat interprets a leading "/" or "." as a chat command. */
const COMMAND_SIGILS = ['/', '.'];

const LAST_C0_CONTROL = 0x1f;
const DELETE_CHARACTER = 0x7f;
const WHITESPACE_RUN = /\s+/g;
/** Splits "<text> - <speaker>" on the last " - ", so text may itself contain a hyphen. */
const ATTRIBUTION_SEPARATOR = ' - ';

/**
 * C0 controls plus DEL. Chat is a single line, and these corrupt logs.
 * Tested by code point because the lint config forbids control characters
 * inside a regular expression (no-control-regex).
 */
function isControlCharacter(character: string): boolean {
    const code = character.codePointAt(0) ?? 0;
    return code <= LAST_C0_CONTROL || code === DELETE_CHARACTER;
}

export type QuoteRejection = 'empty' | 'text-too-long' | 'speaker-too-long' | 'command';

export type QuoteValidation =
    { ok: true; text: string; speaker: string | null } | { ok: false; reason: QuoteRejection };

/** Collapse submitted text to a single trimmed line without control chars. */
export function sanitizeLine(raw: string): string {
    const stripped = [...raw].map((ch) => (isControlCharacter(ch) ? ' ' : ch)).join('');
    return stripped.replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Split "<text> - <speaker>" on the last occurrence of " - ". Both sides must
 * be non-empty for the split to take effect; otherwise the whole input is
 * treated as quote text with no speaker.
 */
function splitAttribution(sanitized: string): { text: string; speaker: string | null } {
    const separatorIndex = sanitized.lastIndexOf(ATTRIBUTION_SEPARATOR);
    if (separatorIndex === -1) return { text: sanitized, speaker: null };
    const text = sanitized.slice(0, separatorIndex).trim();
    const speaker = sanitized.slice(separatorIndex + ATTRIBUTION_SEPARATOR.length).trim();
    if (text.length === 0 || speaker.length === 0) return { text: sanitized, speaker: null };
    return { text, speaker };
}

/** Sanitize, split off an optional speaker, then accept or reject. */
export function validateQuoteInput(raw: string): QuoteValidation {
    const sanitized = sanitizeLine(raw);
    if (sanitized.length === 0) return { ok: false, reason: 'empty' };
    // Refuse text a chat client would run as a command (/timeout, .ban).
    if (COMMAND_SIGILS.includes(sanitized[0]!)) return { ok: false, reason: 'command' };
    const { text, speaker } = splitAttribution(sanitized);
    if (text.length === 0) return { ok: false, reason: 'empty' };
    if (text.length > MAX_QUOTE_TEXT_LENGTH) return { ok: false, reason: 'text-too-long' };
    if (speaker !== null && speaker.length > MAX_SPEAKER_LENGTH) {
        return { ok: false, reason: 'speaker-too-long' };
    }
    return { ok: true, text, speaker };
}

/** Parse a "!quote 12" / "!delquote 12" id argument. */
export function parseQuoteId(token: string | undefined): number | null {
    if (token === undefined) return null;
    if (!/^[0-9]{1,9}$/.test(token)) return null;
    const id = Number(token);
    return id > 0 ? id : null;
}

/** Render a stored quote for chat, including attribution and who added it. */
export function renderQuote(quote: Quote): string {
    const attribution = quote.speaker ? ` - ${quote.speaker}` : '';
    return `Quote #${quote.id}: "${quote.text}"${attribution} (added by ${quote.addedByDisplayName})`;
}
