// Pure text handling for the funfact plugin: sanitize and validate submitted
// text, and render a stored fact for chat. Kept free of I/O so it is unit
// testable without a store.

import type { FunFact } from './types.js';

/**
 * Leaves room for the "Fun fact #NNN: ... (added by <display>)" wrapper inside
 * Twitch's 500 character message limit.
 */
export const MAX_FACT_LENGTH = 300;

/** Twitch chat interprets a leading "/" or "." as a chat command. */
const COMMAND_SIGILS = ['/', '.'];

const LAST_C0_CONTROL = 0x1f;
const DELETE_CHARACTER = 0x7f;
const WHITESPACE_RUN = /\s+/g;

/**
 * C0 controls plus DEL. Chat is a single line, and these corrupt logs.
 * Tested by code point because the lint config forbids control characters
 * inside a regular expression (no-control-regex).
 */
function isControlCharacter(character: string): boolean {
    const code = character.codePointAt(0) ?? 0;
    return code <= LAST_C0_CONTROL || code === DELETE_CHARACTER;
}

export type FactRejection = 'empty' | 'too-long' | 'command';

export type FactValidation = { ok: true; text: string } | { ok: false; reason: FactRejection };

/** Collapse a submitted fact to a single trimmed line without control chars. */
export function sanitizeFactText(raw: string): string {
    const stripped = [...raw].map((ch) => (isControlCharacter(ch) ? ' ' : ch)).join('');
    return stripped.replace(WHITESPACE_RUN, ' ').trim();
}

/** Sanitize then accept or reject submitted fact text. */
export function validateFactText(raw: string): FactValidation {
    const text = sanitizeFactText(raw);
    if (text.length === 0) return { ok: false, reason: 'empty' };
    if (text.length > MAX_FACT_LENGTH) return { ok: false, reason: 'too-long' };
    // Refuse text a chat client would run as a command (/timeout, .ban).
    if (COMMAND_SIGILS.includes(text[0]!)) return { ok: false, reason: 'command' };
    return { ok: true, text };
}

/** Parse a "!funfact 12" / "!delfunfact 12" id argument. */
export function parseFactId(token: string | undefined): number | null {
    if (token === undefined) return null;
    if (!/^[0-9]{1,9}$/.test(token)) return null;
    const id = Number(token);
    return id > 0 ? id : null;
}

/** Render a stored fact for chat, including its attribution. */
export function renderFact(fact: FunFact): string {
    return `Fun fact #${fact.id}: ${fact.text} (added by ${fact.addedByDisplayName})`;
}
