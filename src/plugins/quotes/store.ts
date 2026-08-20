// Persistence for the quotes pool. Mirrors the funfact store: hand-written
// type guards over the parsed JSON, a preserved copy of any unreadable file,
// and coalesced atomic writes.

import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { AtomicJsonFile } from '../../core/atomicFile.js';
import type { Logger } from '../../core/types.js';
import { MAX_QUOTE_TEXT_LENGTH, MAX_SPEAKER_LENGTH } from './quote.js';
import type { Quote, QuoteData, QuoteScope } from './types.js';

/** Scope key used when quotes are pooled across every configured channel. */
export const SHARED_SCOPE_KEY = 'shared';

/**
 * Bound on a pool that is rewritten in full on every change. Adds past the cap
 * are refused rather than evicting a curated quote.
 */
export const MAX_QUOTES = 500;

/**
 * Highest id the store hands out. Matches the 9-digit cap the command parser
 * accepts, so every stored id stays addressable from chat.
 */
export const MAX_QUOTE_ID = 999_999_999;

/** Bounds on the identity fields copied out of chat events. */
const MAX_USER_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;
/** Scope keys are the literal "shared" or a platform broadcaster id. */
const MAX_SCOPE_KEY_LENGTH = 64;

export type AddOutcome =
    { status: 'added'; quote: Quote } | { status: 'duplicate'; quote: Quote } | { status: 'full' };

/**
 * The on-disk file is untrusted input: it can be hand-edited, restored from an
 * old backup, or corrupted. Every field is bounded by type, length, and range
 * before the store will serve it into chat.
 */
const QuoteSchema = z.object({
    id: z.number().int().positive().max(MAX_QUOTE_ID),
    text: z.string().min(1).max(MAX_QUOTE_TEXT_LENGTH),
    speaker: z.string().min(1).max(MAX_SPEAKER_LENGTH).nullable(),
    addedByChatterId: z.string().min(1).max(MAX_USER_ID_LENGTH),
    addedByDisplayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    addedInBroadcasterId: z.string().min(1).max(MAX_USER_ID_LENGTH),
    addedAt: z.string().datetime(),
});

const ScopeSchema = z
    .object({
        nextId: z.number().int().positive().max(MAX_QUOTE_ID),
        quotes: z.array(QuoteSchema).max(MAX_QUOTES),
    })
    .superRefine((scope, ctx) => {
        // Semantic checks the field types cannot express: ids must be unique
        // and already issued, or !delquote would address two quotes at once.
        const ids = new Set(scope.quotes.map((quote) => quote.id));
        if (ids.size !== scope.quotes.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate quote id' });
        }
        if (scope.quotes.some((quote) => quote.id >= scope.nextId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quote id ahead of nextId' });
        }
    });

const DataSchema = z.object({
    version: z.literal(1),
    scopes: z.record(z.string().min(1).max(MAX_SCOPE_KEY_LENGTH), ScopeSchema),
});

/** Scope maps use a null prototype so a scope key can never resolve to an
 * inherited `Object.prototype` member (e.g. "constructor"). */
function emptyScopes(): Record<string, QuoteScope> {
    return Object.create(null) as Record<string, QuoteScope>;
}

function emptyData(): QuoteData {
    return { version: 1, scopes: emptyScopes() };
}

function emptyScope(): QuoteScope {
    return { nextId: 1, quotes: [] };
}

function parseData(raw: string): QuoteData {
    const parsed = DataSchema.parse(JSON.parse(raw));
    return { version: 1, scopes: Object.assign(emptyScopes(), parsed.scopes) };
}

export class QuoteStore {
    private data: QuoteData = emptyData();
    private saveChain: Promise<void> = Promise.resolve();
    private pendingWrite: Promise<void> | null = null;
    private readonly file: AtomicJsonFile;

    constructor(
        private readonly dataPath: string,
        private readonly logger: Logger,
    ) {
        this.file = new AtomicJsonFile(dataPath);
    }

    async load(): Promise<void> {
        let raw: string;
        try {
            raw = await readFile(this.dataPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.data = await this.loadPreviousBackup();
                return;
            }
            this.logger.error({ err, dataPath: this.dataPath }, 'failed to read quotes data file');
            throw err;
        }
        try {
            this.data = parseData(raw);
            this.file.markExisting();
        } catch (err) {
            await this.backupCorruptFile(err);
            this.data = await this.loadPreviousBackup();
        }
    }

    private async loadPreviousBackup(): Promise<QuoteData> {
        try {
            const raw = await readFile(`${this.dataPath}.bak`, 'utf8');
            const restored = parseData(raw);
            this.logger.warn({ dataPath: this.dataPath }, 'loaded previous quotes database backup');
            return restored;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({ err }, 'failed to load previous quotes database backup');
            }
            return emptyData();
        }
    }

    private async backupCorruptFile(err: unknown): Promise<void> {
        const backupPath = `${this.dataPath}.corrupt-${Date.now()}`;
        try {
            await rename(this.dataPath, backupPath);
            this.logger.error(
                { err, backupPath },
                'quotes data file was unreadable; preserved it before recovery',
            );
        } catch (renameErr) {
            this.logger.error({ err: renameErr }, 'failed to preserve corrupt quotes data file');
        }
    }

    private scope(scopeKey: string): QuoteScope {
        return (this.data.scopes[scopeKey] ??= emptyScope());
    }

    count(scopeKey: string): number {
        return this.data.scopes[scopeKey]?.quotes.length ?? 0;
    }

    get(scopeKey: string, id: number): Quote | undefined {
        return this.data.scopes[scopeKey]?.quotes.find((quote) => quote.id === id);
    }

    /** Pick a quote using `roll` in [0, 1). Undefined when the pool is empty. */
    pick(scopeKey: string, roll: number): Quote | undefined {
        const quotes = this.data.scopes[scopeKey]?.quotes ?? [];
        if (quotes.length === 0) return undefined;
        const index = Math.min(quotes.length - 1, Math.floor(roll * quotes.length));
        return quotes[index];
    }

    /**
     * Store `text`/`speaker`, which the caller has already sanitized. Reports
     * the existing entry instead of storing a case-insensitive duplicate
     * (matched on text and speaker together).
     */
    async add(
        scopeKey: string,
        text: string,
        speaker: string | null,
        addedByChatterId: string,
        addedByDisplayName: string,
        addedInBroadcasterId: string,
        addedAt: Date,
    ): Promise<AddOutcome> {
        const scope = this.scope(scopeKey);
        const wantedText = text.toLowerCase();
        const wantedSpeaker = speaker?.toLowerCase() ?? null;
        const existing = scope.quotes.find(
            (quote) =>
                quote.text.toLowerCase() === wantedText &&
                (quote.speaker?.toLowerCase() ?? null) === wantedSpeaker,
        );
        if (existing) return { status: 'duplicate', quote: existing };
        if (scope.quotes.length >= MAX_QUOTES || scope.nextId > MAX_QUOTE_ID) {
            return { status: 'full' };
        }
        const quote: Quote = {
            id: scope.nextId,
            text,
            speaker,
            addedByChatterId,
            addedByDisplayName,
            addedInBroadcasterId,
            addedAt: addedAt.toISOString(),
        };
        scope.nextId += 1;
        scope.quotes.push(quote);
        await this.persist();
        return { status: 'added', quote };
    }

    /** Remove by id. Returns the removed quote, or null when there was none. */
    async remove(scopeKey: string, id: number): Promise<Quote | null> {
        const scope = this.data.scopes[scopeKey];
        if (!scope) return null;
        const index = scope.quotes.findIndex((quote) => quote.id === id);
        if (index === -1) return null;
        const removed = scope.quotes.splice(index, 1)[0]!;
        await this.persist();
        return removed;
    }

    private persist(): Promise<void> {
        if (this.pendingWrite) return this.pendingWrite;
        const write = this.saveChain.then(async () => {
            this.pendingWrite = null;
            await this.file.write(JSON.stringify(this.data, null, 2));
        });
        this.pendingWrite = write;
        // Keep the queue usable after a failed write. The caller still receives
        // `write` and its rejection, while later commands can attempt recovery.
        this.saveChain = write.catch((error: unknown) => {
            this.logger.error({ err: error }, 'quote store write failed');
        });
        return write;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}
