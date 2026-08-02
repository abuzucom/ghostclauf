// Persistence for the funfact pool. Mirrors the streak store: hand-written
// type guards over the parsed JSON, a preserved copy of any unreadable file,
// and coalesced atomic writes.

import { readFile, rename } from 'node:fs/promises';
import { AtomicJsonFile } from '../../core/atomicFile.js';
import type { Logger } from '../../core/types.js';
import type { FunFact, FunFactData, FunFactScope } from './types.js';

/** Scope key used when facts are pooled across every configured channel. */
export const SHARED_SCOPE_KEY = 'shared';

/**
 * Bound on a pool that is rewritten in full on every change. Adds past the cap
 * are refused rather than evicting a curated fact.
 */
export const MAX_FACTS = 500;

export type AddOutcome =
    | { status: 'added'; fact: FunFact }
    | { status: 'duplicate'; fact: FunFact }
    | { status: 'full' };

function emptyData(): FunFactData {
    return { version: 1, scopes: {} };
}

function emptyScope(): FunFactScope {
    return { nextId: 1, facts: [] };
}

function isFunFact(value: unknown): value is FunFact {
    if (typeof value !== 'object' || value === null) return false;
    const fact = value as Partial<FunFact>;
    return (
        Number.isSafeInteger(fact.id) &&
        (fact.id as number) > 0 &&
        typeof fact.text === 'string' &&
        typeof fact.addedByChatterId === 'string' &&
        typeof fact.addedByDisplayName === 'string' &&
        typeof fact.addedInBroadcasterId === 'string' &&
        typeof fact.addedAt === 'string'
    );
}

function isFunFactScope(value: unknown): value is FunFactScope {
    if (typeof value !== 'object' || value === null) return false;
    const scope = value as Partial<FunFactScope>;
    if (!Number.isSafeInteger(scope.nextId) || (scope.nextId as number) < 1) return false;
    return Array.isArray(scope.facts) && scope.facts.every(isFunFact);
}

function isFunFactData(value: unknown): value is FunFactData {
    if (typeof value !== 'object' || value === null) return false;
    const data = value as Partial<FunFactData>;
    return (
        data.version === 1 &&
        typeof data.scopes === 'object' &&
        data.scopes !== null &&
        Object.values(data.scopes).every(isFunFactScope)
    );
}

function parseData(raw: string): FunFactData {
    const parsed: unknown = JSON.parse(raw);
    if (isFunFactData(parsed)) return parsed;
    throw new Error('unexpected funfact data shape');
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
        if (scope.facts.length >= MAX_FACTS) return { status: 'full' };
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
