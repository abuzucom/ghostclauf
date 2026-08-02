// Persistence for the funfact pool. Mirrors the streak store: hand-written
// type guards over the parsed JSON, a preserved copy of any unreadable file,
// and coalesced atomic writes.

import { readFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { AtomicJsonFile } from '../../core/atomicFile.js';
import type { Logger } from '../../core/types.js';
import { MAX_FACT_LENGTH } from './fact.js';
import type { FunFact, FunFactData, FunFactScope } from './types.js';

/** Scope key used when facts are pooled across every configured channel. */
export const SHARED_SCOPE_KEY = 'shared';

/**
 * Bound on a pool that is rewritten in full on every change. Adds past the cap
 * are refused rather than evicting a curated fact.
 */
export const MAX_FACTS = 500;

/**
 * Highest id the store hands out. Matches the 9-digit cap the command parser
 * accepts, so every stored id stays addressable from chat.
 */
export const MAX_FACT_ID = 999_999_999;

/** Bounds on the identity fields copied out of chat events. */
const MAX_USER_ID_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 64;
/** Scope keys are the literal "shared" or a platform broadcaster id. */
const MAX_SCOPE_KEY_LENGTH = 64;

export type AddOutcome =
    | { status: 'added'; fact: FunFact }
    | { status: 'duplicate'; fact: FunFact }
    | { status: 'full' };

/**
 * The on-disk file is untrusted input: it can be hand-edited, restored from an
 * old backup, or corrupted. Every field is bounded by type, length, and range
 * before the store will serve it into chat.
 */
const FactSchema = z.object({
    id: z.number().int().positive().max(MAX_FACT_ID),
    text: z.string().min(1).max(MAX_FACT_LENGTH),
    addedByChatterId: z.string().min(1).max(MAX_USER_ID_LENGTH),
    addedByDisplayName: z.string().min(1).max(MAX_DISPLAY_NAME_LENGTH),
    addedInBroadcasterId: z.string().min(1).max(MAX_USER_ID_LENGTH),
    addedAt: z.string().datetime(),
});

const ScopeSchema = z
    .object({
        nextId: z.number().int().positive().max(MAX_FACT_ID),
        facts: z.array(FactSchema).max(MAX_FACTS),
    })
    .superRefine((scope, ctx) => {
        // Semantic checks the field types cannot express: ids must be unique
        // and already issued, or !delfunfact would address two facts at once.
        const ids = new Set(scope.facts.map((fact) => fact.id));
        if (ids.size !== scope.facts.length) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate fact id' });
        }
        if (scope.facts.some((fact) => fact.id >= scope.nextId)) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'fact id ahead of nextId' });
        }
    });

const DataSchema = z.object({
    version: z.literal(1),
    scopes: z.record(z.string().min(1).max(MAX_SCOPE_KEY_LENGTH), ScopeSchema),
});

/** Scope maps use a null prototype so a scope key can never resolve to an
 * inherited `Object.prototype` member (e.g. "constructor"). */
function emptyScopes(): Record<string, FunFactScope> {
    return Object.create(null) as Record<string, FunFactScope>;
}

function emptyData(): FunFactData {
    return { version: 1, scopes: emptyScopes() };
}

function emptyScope(): FunFactScope {
    return { nextId: 1, facts: [] };
}

function parseData(raw: string): FunFactData {
    const parsed = DataSchema.parse(JSON.parse(raw));
    return { version: 1, scopes: Object.assign(emptyScopes(), parsed.scopes) };
}

export class FunFactStore {
    private data: FunFactData = emptyData();
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
            this.logger.error({ err, dataPath: this.dataPath }, 'failed to read funfact data file');
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

    private async loadPreviousBackup(): Promise<FunFactData> {
        try {
            const raw = await readFile(`${this.dataPath}.bak`, 'utf8');
            const restored = parseData(raw);
            this.logger.warn(
                { dataPath: this.dataPath },
                'loaded previous funfact database backup',
            );
            return restored;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({ err }, 'failed to load previous funfact database backup');
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
                'funfact data file was unreadable; preserved it before recovery',
            );
        } catch (renameErr) {
            this.logger.error({ err: renameErr }, 'failed to preserve corrupt funfact data file');
        }
    }

    private scope(scopeKey: string): FunFactScope {
        const existing = this.data.scopes[scopeKey];
        if (existing) return existing;
        const created = emptyScope();
        this.data.scopes[scopeKey] = created;
        return created;
    }

    count(scopeKey: string): number {
        return this.data.scopes[scopeKey]?.facts.length ?? 0;
    }

    get(scopeKey: string, id: number): FunFact | undefined {
        return this.data.scopes[scopeKey]?.facts.find((fact) => fact.id === id);
    }

    /** Pick a fact using `roll` in [0, 1). Undefined when the pool is empty. */
    pick(scopeKey: string, roll: number): FunFact | undefined {
        const facts = this.data.scopes[scopeKey]?.facts ?? [];
        if (facts.length === 0) return undefined;
        const index = Math.min(facts.length - 1, Math.floor(roll * facts.length));
        return facts[index];
    }

    /**
     * Store `text`, which the caller has already sanitized. Reports the
     * existing entry instead of storing a case-insensitive duplicate.
     */
    async add(
        scopeKey: string,
        text: string,
        addedByChatterId: string,
        addedByDisplayName: string,
        addedInBroadcasterId: string,
        addedAt: Date,
    ): Promise<AddOutcome> {
        const scope = this.scope(scopeKey);
        const wanted = text.toLowerCase();
        const existing = scope.facts.find((fact) => fact.text.toLowerCase() === wanted);
        if (existing) return { status: 'duplicate', fact: existing };
        if (scope.facts.length >= MAX_FACTS || scope.nextId > MAX_FACT_ID) {
            return { status: 'full' };
        }
        const fact: FunFact = {
            id: scope.nextId,
            text,
            addedByChatterId,
            addedByDisplayName,
            addedInBroadcasterId,
            addedAt: addedAt.toISOString(),
        };
        scope.nextId += 1;
        scope.facts.push(fact);
        await this.persist();
        return { status: 'added', fact };
    }

    /** Remove by id. Returns the removed fact, or null when there was none. */
    async remove(scopeKey: string, id: number): Promise<FunFact | null> {
        const scope = this.data.scopes[scopeKey];
        if (!scope) return null;
        const index = scope.facts.findIndex((fact) => fact.id === id);
        if (index === -1) return null;
        const [removed] = scope.facts.splice(index, 1);
        await this.persist();
        return removed ?? null;
    }

    private persist(): Promise<void> {
        if (this.pendingWrite) return this.pendingWrite;
        const write = this.saveChain.then(async () => {
            this.pendingWrite = null;
            await this.file.write(JSON.stringify(this.data, null, 2));
        });
        this.pendingWrite = write;
        this.saveChain = write.catch(() => {});
        return write;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}
