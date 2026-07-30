import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from '../../core/types.js';

export interface StreakDecision {
    id: string;
    scope: string;
    chatterId: string;
    chatterName: string;
    beforeStreak: number;
    afterStreak: number;
    previousLongest: number;
    adjustment: number;
    createdAt: string;
    createdByChatterId: string;
    createdInBroadcasterId: string;
    status: 'pending' | 'applied' | 'aborted';
    pendingReversal: {
        id: string;
        createdAt: string;
        reversedByChatterId: string;
        reversedInBroadcasterId: string;
    } | null;
    reversedAt: string | null;
    reversedByChatterId: string | null;
    reversedInBroadcasterId: string | null;
    supersededAt: string | null;
}

interface DecisionData {
    version: 1;
    decisions: StreakDecision[];
}

function emptyData(): DecisionData {
    return { version: 1, decisions: [] };
}

function isDecision(value: unknown): value is StreakDecision {
    if (typeof value !== 'object' || value === null) return false;
    const decision = value as Partial<StreakDecision>;
    return (
        typeof decision.id === 'string' &&
        typeof decision.scope === 'string' &&
        typeof decision.chatterId === 'string' &&
        Number.isFinite(decision.beforeStreak) &&
        Number.isFinite(decision.afterStreak) &&
        Number.isFinite(decision.previousLongest) &&
        Number.isFinite(decision.adjustment) &&
        typeof decision.createdAt === 'string' &&
        (decision.status === undefined ||
            decision.status === 'pending' ||
            decision.status === 'applied' ||
            decision.status === 'aborted') &&
        (decision.pendingReversal === undefined ||
            decision.pendingReversal === null ||
            isPendingReversal(decision.pendingReversal)) &&
        (decision.reversedAt === null || typeof decision.reversedAt === 'string') &&
        (decision.supersededAt === null || typeof decision.supersededAt === 'string')
    );
}

function isPendingReversal(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    const reversal = value as Record<string, unknown>;
    return (
        typeof reversal.id === 'string' &&
        typeof reversal.createdAt === 'string' &&
        typeof reversal.reversedByChatterId === 'string' &&
        typeof reversal.reversedInBroadcasterId === 'string'
    );
}

function parseData(raw: string): DecisionData {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('invalid decision data');
    const data = parsed as Partial<DecisionData>;
    if (data.version !== 1 || !Array.isArray(data.decisions) || !data.decisions.every(isDecision)) {
        throw new Error('invalid decision data');
    }
    return {
        version: 1,
        decisions: data.decisions.map((decision) => ({
            ...decision,
            status: decision.status ?? 'applied',
            pendingReversal: decision.pendingReversal ?? null,
        })),
    };
}

export class StreakDecisionStore {
    private data: DecisionData = emptyData();
    private saveChain: Promise<void> = Promise.resolve();
    private writeSeq = 0;
    private hasPersistedPrimary = false;

    constructor(
        private readonly dataPath: string,
        private readonly logger: Logger,
    ) {}

    async load(): Promise<void> {
        try {
            this.data = parseData(await readFile(this.dataPath, 'utf8'));
            this.hasPersistedPrimary = true;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                this.data = await this.loadBackup();
                return;
            }
            this.logger.error(
                { err, dataPath: this.dataPath },
                'failed to load streak decision data',
            );
            this.data = await this.loadBackup();
        }
    }

    private async loadBackup(): Promise<DecisionData> {
        try {
            return parseData(await readFile(`${this.dataPath}.bak`, 'utf8'));
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.logger.error({ err }, 'failed to load streak decision backup');
            }
            return emptyData();
        }
    }

    async recordSet(
        scope: string,
        chatterId: string,
        chatterName: string,
        beforeStreak: number,
        afterStreak: number,
        previousLongest: number,
        createdByChatterId: string,
        createdInBroadcasterId: string,
        now: Date = new Date(),
    ): Promise<void> {
        const decision = await this.prepareSet(
            scope,
            chatterId,
            chatterName,
            beforeStreak,
            afterStreak,
            previousLongest,
            createdByChatterId,
            createdInBroadcasterId,
            now,
        );
        await this.markSetApplied(decision.id);
    }

    async prepareSet(
        scope: string,
        chatterId: string,
        chatterName: string,
        beforeStreak: number,
        afterStreak: number,
        previousLongest: number,
        createdByChatterId: string,
        createdInBroadcasterId: string,
        now: Date = new Date(),
    ): Promise<StreakDecision> {
        const decision: StreakDecision = {
            id: randomUUID(),
            scope,
            chatterId,
            chatterName,
            beforeStreak,
            afterStreak,
            previousLongest,
            adjustment: afterStreak - beforeStreak,
            createdAt: now.toISOString(),
            createdByChatterId,
            createdInBroadcasterId,
            status: 'pending',
            pendingReversal: null,
            reversedAt: null,
            reversedByChatterId: null,
            reversedInBroadcasterId: null,
            supersededAt: null,
        };
        this.data.decisions.push(decision);
        await this.persist();
        return decision;
    }

    async markSetApplied(decisionId: string): Promise<void> {
        const decision = this.data.decisions.find(({ id }) => id === decisionId);
        if (!decision || decision.status !== 'pending') return;
        decision.status = 'applied';
        await this.persist();
    }

    async abortSet(decisionId: string): Promise<void> {
        const decision = this.data.decisions.find(({ id }) => id === decisionId);
        if (!decision || decision.status !== 'pending') return;
        decision.status = 'aborted';
        await this.persist();
    }

    latest(scope: string, chatterId: string): StreakDecision | null {
        return (
            [...this.data.decisions]
                .reverse()
                .find(
                    (decision) =>
                        decision.scope === scope &&
                        decision.chatterId === chatterId &&
                        decision.status === 'applied' &&
                        decision.pendingReversal === null &&
                        decision.reversedAt === null &&
                        decision.supersededAt === null,
                ) ?? null
        );
    }

    async reverseLatest(
        scope: string,
        chatterId: string,
        reversedByChatterId: string,
        reversedInBroadcasterId: string,
        now: Date = new Date(),
    ): Promise<{ adjustment: number; previousLongest: number } | null> {
        const reversal = await this.prepareReverse(
            scope,
            chatterId,
            reversedByChatterId,
            reversedInBroadcasterId,
            now,
        );
        if (!reversal) return null;
        await this.markReverseApplied(reversal.transactionId);
        return {
            adjustment: reversal.adjustment,
            previousLongest: reversal.previousLongest,
        };
    }

    async prepareReverse(
        scope: string,
        chatterId: string,
        reversedByChatterId: string,
        reversedInBroadcasterId: string,
        now: Date = new Date(),
    ): Promise<{
        transactionId: string;
        adjustment: number;
        previousLongest: number;
        previousDecisionId: string | null;
    } | null> {
        const decision = this.latest(scope, chatterId);
        if (!decision) return null;
        const transactionId = randomUUID();
        decision.pendingReversal = {
            id: transactionId,
            createdAt: now.toISOString(),
            reversedByChatterId,
            reversedInBroadcasterId,
        };
        const previousDecisionId = this.latest(scope, chatterId)?.id ?? null;
        await this.persist();
        return {
            transactionId,
            adjustment: decision.adjustment,
            previousLongest: decision.previousLongest,
            previousDecisionId,
        };
    }

    async markReverseApplied(transactionId: string): Promise<void> {
        const decision = this.findPendingReversal(transactionId);
        if (!decision?.pendingReversal) return;
        decision.reversedAt = decision.pendingReversal.createdAt;
        decision.reversedByChatterId = decision.pendingReversal.reversedByChatterId;
        decision.reversedInBroadcasterId = decision.pendingReversal.reversedInBroadcasterId;
        decision.pendingReversal = null;
        await this.persist();
    }

    async cancelReverse(transactionId: string): Promise<void> {
        const decision = this.findPendingReversal(transactionId);
        if (!decision) return;
        decision.pendingReversal = null;
        await this.persist();
    }

    async reconcile(
        getPrimaryTransactionId: (scope: string, chatterId: string) => string | null,
    ): Promise<void> {
        let changed = false;
        for (const decision of this.data.decisions) {
            const primaryId = getPrimaryTransactionId(decision.scope, decision.chatterId);
            if (decision.status === 'pending') {
                decision.status = primaryId === decision.id ? 'applied' : 'aborted';
                changed = true;
            }
            const reversal = decision.pendingReversal;
            if (!reversal) continue;
            if (primaryId === reversal.id) {
                decision.reversedAt = reversal.createdAt;
                decision.reversedByChatterId = reversal.reversedByChatterId;
                decision.reversedInBroadcasterId = reversal.reversedInBroadcasterId;
            }
            decision.pendingReversal = null;
            changed = true;
        }
        if (changed) await this.persist();
    }

    private findPendingReversal(transactionId: string): StreakDecision | undefined {
        return this.data.decisions.find(
            (decision) => decision.pendingReversal?.id === transactionId,
        );
    }

    async supersede(scope: string, chatterId: string, now: Date = new Date()): Promise<void> {
        const timestamp = now.toISOString();
        let changed = false;
        for (const decision of this.data.decisions) {
            if (
                decision.scope === scope &&
                decision.chatterId === chatterId &&
                decision.reversedAt === null &&
                decision.supersededAt === null
            ) {
                decision.supersededAt = timestamp;
                changed = true;
            }
        }
        if (changed) await this.persist();
    }

    private persist(): Promise<void> {
        const json = JSON.stringify(this.data, null, 2);
        const write = this.saveChain.then(() => this.writeAtomic(json));
        this.saveChain = write.catch(() => {});
        return write;
    }

    private async writeAtomic(json: string): Promise<void> {
        await mkdir(dirname(this.dataPath), { recursive: true });
        this.writeSeq += 1;
        if (this.hasPersistedPrimary) {
            const backupTemp = `${this.dataPath}.bak.${this.writeSeq}.tmp`;
            await copyFile(this.dataPath, backupTemp);
            await rename(backupTemp, `${this.dataPath}.bak`);
        }
        const tempPath = `${this.dataPath}.${this.writeSeq}.tmp`;
        await writeFile(tempPath, json, 'utf8');
        await rename(tempPath, this.dataPath);
        this.hasPersistedPrimary = true;
    }

    async flush(): Promise<void> {
        await this.saveChain;
    }
}
