import { DateTime } from 'luxon';
import type {
    BotContext,
    CommandHandler,
    Logger,
    Plugin,
    StreamOnlineEvent,
} from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { parseLogin } from '../../core/logins.js';
import { StreakDecisionStore } from './decisionStore.js';
import { StreakStore } from './store.js';
import {
    attendanceDayKey,
    DEFAULT_DATA_PATH,
    DEFAULT_MESSAGES,
    DEFAULT_STREAM_SESSION_HOURS,
    DEFAULT_TIMEZONE,
    DEFAULT_TRIGGERS,
    isValidTimezone,
    renderMessage,
    resolveCheckinDay,
    streamDayKey,
} from './streak.js';
import type {
    BroadcasterSession,
    CheckinOutcome,
    StreakBreakPolicy,
    StreakConfig,
    StreakMessages,
    StreakTriggers,
} from './types.js';

interface ResolvedConfig {
    dataPath: string;
    decisionPath: string;
    timezone: string;
    dayBoundaryHour: number;
    reconnectGraceMinutes: number;
    minimumQualifyingSessionMinutes: number;
    streakBreakPolicy: StreakBreakPolicy;
    requireStreamDay: boolean;
    shareAcrossChannels: boolean;
    streamSessionHours: number;
    checkinCooldownSeconds: number;
    triggers: StreakTriggers;
    messages: StreakMessages;
}

interface Runtime {
    store: StreakStore;
    decisions: StreakDecisionStore;
    cfg: ResolvedConfig;
    now: () => Date;
    liveBroadcasters: Set<string>;
    requiredBroadcasterIds: ReadonlySet<string>;
    qualificationTimers: Map<string, NodeJS.Timeout>;
    logger: Logger;
}

const STREAK_VALUE_PATTERN = /^\d{1,6}$/;
const SHARED_SCOPE_KEY = 'shared';
const MIN_SESSION_HOURS = 1;
const MAX_SESSION_HOURS = 72;
const DEFAULT_CHECKIN_COOLDOWN_SECONDS = 10;
const MAX_CHECKIN_COOLDOWN_SECONDS = 3600;
const MAX_MINUTES = 1440;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

function resolveBoundedInt(
    configured: number | undefined,
    min: number,
    max: number,
    fallback: number,
    name: string,
    logger: Logger,
): number {
    if (configured === undefined) return fallback;
    if (Number.isInteger(configured) && configured >= min && configured <= max) return configured;
    logger.warn({ configured }, `invalid streak ${name}; falling back to default`);
    return fallback;
}

function resolveConfig(raw: StreakConfig, logger: Logger): ResolvedConfig {
    const configuredTz = raw.timezone ?? DEFAULT_TIMEZONE;
    const timezone = isValidTimezone(configuredTz) ? configuredTz : DEFAULT_TIMEZONE;
    if (timezone !== configuredTz) {
        logger.warn({ configuredTz }, 'invalid streak timezone; falling back to UTC');
    }
    const dataPath = raw.dataPath ?? DEFAULT_DATA_PATH;
    return {
        dataPath,
        decisionPath: raw.decisionPath ?? `${dataPath}.decisions`,
        timezone,
        dayBoundaryHour: resolveBoundedInt(
            raw.dayBoundaryHour,
            0,
            23,
            0,
            'dayBoundaryHour',
            logger,
        ),
        reconnectGraceMinutes: resolveBoundedInt(
            raw.reconnectGraceMinutes,
            0,
            MAX_MINUTES,
            0,
            'reconnectGraceMinutes',
            logger,
        ),
        minimumQualifyingSessionMinutes: resolveBoundedInt(
            raw.minimumQualifyingSessionMinutes,
            0,
            MAX_MINUTES,
            0,
            'minimumQualifyingSessionMinutes',
            logger,
        ),
        streakBreakPolicy:
            raw.streakBreakPolicy === 'all-broadcasters'
                ? 'all-broadcasters'
                : 'previous-stream-day',
        requireStreamDay: raw.requireStreamDay ?? true,
        shareAcrossChannels: raw.shareAcrossChannels ?? true,
        streamSessionHours: resolveBoundedInt(
            raw.streamSessionHours,
            MIN_SESSION_HOURS,
            MAX_SESSION_HOURS,
            DEFAULT_STREAM_SESSION_HOURS,
            'streamSessionHours',
            logger,
        ),
        checkinCooldownSeconds: resolveBoundedInt(
            raw.checkinCooldownSeconds,
            0,
            MAX_CHECKIN_COOLDOWN_SECONDS,
            DEFAULT_CHECKIN_COOLDOWN_SECONDS,
            'checkinCooldownSeconds',
            logger,
        ),
        triggers: { ...DEFAULT_TRIGGERS, ...raw.triggers },
        messages: { ...DEFAULT_MESSAGES, ...raw.messages },
    };
}

function scopeKey(cfg: ResolvedConfig, broadcasterId: string): string {
    return cfg.shareAcrossChannels ? SHARED_SCOPE_KEY : broadcasterId;
}

function usesBroadcasterPolicy(cfg: ResolvedConfig): boolean {
    return cfg.streakBreakPolicy === 'all-broadcasters' && cfg.shareAcrossChannels;
}

function parseStreakValue(token: string | undefined): number | null {
    if (token === undefined || !STREAK_VALUE_PATTERN.test(token)) return null;
    return Number(token);
}

function pickCheckinTemplate(messages: StreakMessages, outcome: CheckinOutcome): string {
    if (outcome === 'extended') return messages.extended;
    if (outcome === 'already') return messages.already;
    return messages.started;
}

function logicalDay(cfg: ResolvedConfig, instant: Date): string {
    return attendanceDayKey(instant, cfg.timezone, cfg.dayBoundaryHour);
}

function emptySession(): BroadcasterSession {
    return {
        logicalDay: null,
        logicalSessionStartedAt: null,
        currentIntervalStartedAt: null,
        currentStreamId: null,
        lastOfflineAt: null,
        pendingOfflineAt: null,
        status: 'offline',
    };
}

function isReconnect(
    previous: BroadcasterSession,
    event: StreamOnlineEvent,
    graceMinutes: number,
): boolean {
    if (previous.currentStreamId && previous.currentStreamId === event.streamId) return true;
    if (!previous.lastOfflineAt || graceMinutes === 0) return false;
    const offlineAt = DateTime.fromISO(previous.lastOfflineAt).toUTC();
    const onlineAt = DateTime.fromJSDate(event.startedAt).toUTC();
    const elapsedMs = onlineAt.toMillis() - offlineAt.toMillis();
    const graceMs = graceMinutes * MS_PER_MINUTE;
    return elapsedMs >= 0 && elapsedMs <= graceMs;
}

async function qualifyCurrentInterval(runtime: Runtime, broadcasterId: string): Promise<void> {
    const scope = scopeKey(runtime.cfg, broadcasterId);
    const session = runtime.store.getSession(scope, broadcasterId);
    if (!session?.logicalDay || !session.currentIntervalStartedAt) return;
    const effectiveEnd = session.pendingOfflineAt
        ? DateTime.fromISO(session.pendingOfflineAt).toUTC()
        : DateTime.fromJSDate(runtime.now()).toUTC();
    const intervalStart = DateTime.fromISO(session.currentIntervalStartedAt).toUTC();
    const elapsedMs = effectiveEnd.toMillis() - intervalStart.toMillis();
    const minimumMs = runtime.cfg.minimumQualifyingSessionMinutes * MS_PER_MINUTE;
    if (elapsedMs < minimumMs || session.status === 'unverified-offline') return;
    await runtime.store.recordQualifiedDay(scope, broadcasterId, session.logicalDay);
}

function scheduleQualification(runtime: Runtime, broadcasterId: string): void {
    const existing = runtime.qualificationTimers.get(broadcasterId);
    if (existing) clearTimeout(existing);
    const scope = scopeKey(runtime.cfg, broadcasterId);
    const session = runtime.store.getSession(scope, broadcasterId);
    if (!session?.currentIntervalStartedAt) return;
    const start = DateTime.fromISO(session.currentIntervalStartedAt).toUTC();
    const target = start.plus({ minutes: runtime.cfg.minimumQualifyingSessionMinutes });
    const nowDt = DateTime.fromJSDate(runtime.now()).toUTC();
    const delay = Math.max(0, target.toMillis() - nowDt.toMillis());
    const timer = setTimeout(() => {
        runtime.qualificationTimers.delete(broadcasterId);
        void qualifyCurrentInterval(runtime, broadcasterId).catch((err: unknown) => {
            runtime.logger.error({ err, broadcasterId }, 'failed to qualify streak stream day');
        });
    }, delay);
    runtime.qualificationTimers.set(broadcasterId, timer);
}

async function handleOnline(runtime: Runtime, event: StreamOnlineEvent): Promise<void> {
    const scope = scopeKey(runtime.cfg, event.broadcasterId);
    const previous = runtime.store.getSession(scope, event.broadcasterId) ?? emptySession();
    const reconnect = isReconnect(previous, event, runtime.cfg.reconnectGraceMinutes);
    const sameStream =
        previous.currentStreamId !== null && previous.currentStreamId === event.streamId;
    const day =
        reconnect && previous.logicalDay
            ? previous.logicalDay
            : logicalDay(runtime.cfg, event.startedAt);
    const intervalStart =
        sameStream && previous.currentIntervalStartedAt
            ? previous.currentIntervalStartedAt
            : event.startedAt.toISOString();
    const session: BroadcasterSession = {
        logicalDay: day,
        logicalSessionStartedAt:
            reconnect && previous.logicalSessionStartedAt
                ? previous.logicalSessionStartedAt
                : event.startedAt.toISOString(),
        currentIntervalStartedAt: intervalStart,
        currentStreamId: event.streamId ?? event.startedAt.toISOString(),
        lastOfflineAt: previous.lastOfflineAt,
        pendingOfflineAt: null,
        status: 'live',
    };
    runtime.liveBroadcasters.add(event.broadcasterId);
    await runtime.store.setSession(scope, event.broadcasterId, session);
    await runtime.store.recordStreamDay(scope, day, event.startedAt);
    scheduleQualification(runtime, event.broadcasterId);
}

async function handleLegacyOnline(runtime: Runtime, event: StreamOnlineEvent): Promise<void> {
    runtime.liveBroadcasters.add(event.broadcasterId);
    const scope = scopeKey(runtime.cfg, event.broadcasterId);
    const day = streamDayKey(event.startedAt, runtime.cfg.timezone);
    await runtime.store.recordStreamDay(scope, day, event.startedAt);
}

async function handlePendingOffline(
    runtime: Runtime,
    broadcasterId: string,
    observedAt: Date,
): Promise<void> {
    const scope = scopeKey(runtime.cfg, broadcasterId);
    const session = runtime.store.getSession(scope, broadcasterId);
    if (!session) return;
    session.status = 'pending-offline';
    session.pendingOfflineAt = observedAt.toISOString();
    await runtime.store.setSession(scope, broadcasterId, session);
}

async function handleOffline(
    runtime: Runtime,
    broadcasterId: string,
    observedAt: Date,
    verified: boolean,
): Promise<void> {
    const timer = runtime.qualificationTimers.get(broadcasterId);
    if (timer) clearTimeout(timer);
    runtime.qualificationTimers.delete(broadcasterId);
    const scope = scopeKey(runtime.cfg, broadcasterId);
    const session = runtime.store.getSession(scope, broadcasterId);
    runtime.liveBroadcasters.delete(broadcasterId);
    if (!session) return;
    session.status = verified ? 'offline' : 'unverified-offline';
    session.lastOfflineAt = observedAt.toISOString();
    session.pendingOfflineAt = observedAt.toISOString();
    await runtime.store.setSession(scope, broadcasterId, session);
    if (verified) await qualifyCurrentInterval(runtime, broadcasterId);
    const currentSession = runtime.store.getSession(scope, broadcasterId);
    if (currentSession && currentSession.status !== 'live') {
        currentSession.pendingOfflineAt = null;
        await runtime.store.setSession(scope, broadcasterId, currentSession);
    }
}

function checkinHandler(runtime: Runtime): CommandHandler {
    const cooldown = new CooldownGate(runtime.cfg.checkinCooldownSeconds * MS_PER_SECOND);
    return async (event, ctx) => {
        const scope = scopeKey(runtime.cfg, event.broadcasterId);
        const now = runtime.now();
        if (cooldown.shouldThrottle(`${scope}:${event.chatterId}`, now.getTime())) return;
        const modern = usesBroadcasterPolicy(runtime.cfg);
        const session = runtime.store.getSession(scope, event.broadcasterId);
        const open = modern
            ? runtime.liveBroadcasters.has(event.broadcasterId) && session?.logicalDay !== null
            : await ensureLegacyOpen(runtime, scope, event.broadcasterId, now);
        if (!open) {
            await ctx.say(
                renderMessage(runtime.cfg.messages.notOpen, { user: event.chatterDisplayName }),
                event.messageId,
                event.broadcasterId,
            );
            return;
        }
        const day = modern
            ? session!.logicalDay!
            : resolveLegacyDay(runtime.store, runtime.cfg, scope, now);
        if (modern) await qualifyCurrentInterval(runtime, event.broadcasterId);
        const result = modern
            ? await runtime.store.checkInBroadcaster(
                  scope,
                  event.chatterId,
                  event.chatterName,
                  event.chatterDisplayName,
                  day,
                  runtime.requiredBroadcasterIds,
                  event.broadcasterId,
                  now,
              )
            : await runtime.store.checkIn(
                  scope,
                  event.chatterId,
                  event.chatterName,
                  event.chatterDisplayName,
                  day,
              );
        await ctx.say(
            renderMessage(pickCheckinTemplate(runtime.cfg.messages, result.outcome), {
                user: event.chatterDisplayName,
                streak: result.viewer.currentStreak,
                longest: result.viewer.longestStreak,
                day,
            }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function resolveLegacyDay(
    store: StreakStore,
    cfg: ResolvedConfig,
    scope: string,
    now: Date,
): string {
    return resolveCheckinDay(
        now,
        store.activeStreamStartedAt(scope),
        cfg.timezone,
        cfg.streamSessionHours,
    );
}

async function ensureLegacyOpen(
    runtime: Runtime,
    scope: string,
    broadcasterId: string,
    now: Date,
): Promise<boolean> {
    const day = resolveLegacyDay(runtime.store, runtime.cfg, scope, now);
    if (runtime.cfg.requireStreamDay) {
        const live = runtime.cfg.shareAcrossChannels
            ? runtime.liveBroadcasters.size > 0
            : runtime.liveBroadcasters.has(broadcasterId);
        return runtime.store.hasStreamDay(scope, day) && live;
    }
    if (!runtime.store.hasStreamDay(scope, day))
        await runtime.store.recordStreamDay(scope, day, now);
    return true;
}

function lookupHandler(store: StreakStore, cfg: ResolvedConfig): CommandHandler {
    return async (event, ctx) => {
        const scope = scopeKey(cfg, event.broadcasterId);
        const login = parseLogin(event.args[0]);
        const found = login ? store.findViewerByName(scope, login) : undefined;
        const viewer = login ? found?.viewer : store.getViewer(scope, event.chatterId);
        const user = login ? (found?.viewer.displayName ?? login) : event.chatterDisplayName;
        const template = viewer
            ? login
                ? cfg.messages.lookupOther
                : cfg.messages.lookupSelf
            : cfg.messages.lookupNone;
        await ctx.say(
            renderMessage(template, {
                user,
                streak: viewer?.currentStreak,
                longest: viewer?.longestStreak,
            }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

async function resolveAdminTarget(
    store: StreakStore,
    cfg: ResolvedConfig,
    event: Parameters<CommandHandler>[0],
    ctx: BotContext,
    usage: string,
): Promise<{ chatterId: string; viewer: { displayName: string; chatterName?: string } } | null> {
    const login = parseLogin(event.args[0]);
    if (!login) {
        await ctx.say(
            renderMessage(cfg.messages.adminUsage, { user: usage }),
            event.messageId,
            event.broadcasterId,
        );
        return null;
    }
    const found = store.findViewerByName(scopeKey(cfg, event.broadcasterId), login);
    if (found) return found;
    await ctx.say(
        renderMessage(cfg.messages.adminNotFound, { user: login }),
        event.messageId,
        event.broadcasterId,
    );
    return null;
}

function resetHandler(runtime: Runtime): CommandHandler {
    return async (event, ctx) => {
        const found = await resolveAdminTarget(
            runtime.store,
            runtime.cfg,
            event,
            ctx,
            `!${runtime.cfg.triggers.reset} @user`,
        );
        if (!found) return;
        const scope = scopeKey(runtime.cfg, event.broadcasterId);
        await runtime.decisions.supersede(scope, found.chatterId, runtime.now());
        await runtime.store.resetViewer(scope, found.chatterId, runtime.now());
        await ctx.say(
            renderMessage(runtime.cfg.messages.reset, { user: found.viewer.displayName }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function setHandler(runtime: Runtime): CommandHandler {
    return async (event, ctx) => {
        const value = parseStreakValue(event.args[1]);
        if (value === null) {
            await ctx.say(
                renderMessage(runtime.cfg.messages.adminUsage, {
                    user: `!${runtime.cfg.triggers.set} @user <number>`,
                }),
                event.messageId,
                event.broadcasterId,
            );
            return;
        }
        const found = await resolveAdminTarget(
            runtime.store,
            runtime.cfg,
            event,
            ctx,
            `!${runtime.cfg.triggers.set} @user <number>`,
        );
        if (!found) return;
        const scope = scopeKey(runtime.cfg, event.broadcasterId);
        const before = runtime.store.getViewer(scope, found.chatterId)!;
        const decision = await runtime.decisions.prepareSet(
            scope,
            found.chatterId,
            before.chatterName,
            before.currentStreak,
            value,
            before.longestStreak,
            event.chatterId,
            event.broadcasterId,
            runtime.now(),
        );
        try {
            await runtime.store.setViewerStreak(
                scope,
                found.chatterId,
                value,
                runtime.now(),
                decision.id,
            );
        } catch (err) {
            await runtime.decisions.abortSet(decision.id);
            throw err;
        }
        await runtime.decisions.markSetApplied(decision.id);
        await ctx.say(
            renderMessage(runtime.cfg.messages.setDone, {
                user: found.viewer.displayName,
                streak: value,
            }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function fixHandler(runtime: Runtime): CommandHandler {
    return async (event, ctx) => {
        const found = await resolveAdminTarget(
            runtime.store,
            runtime.cfg,
            event,
            ctx,
            `!${runtime.cfg.triggers.fix} @user`,
        );
        if (!found) return;
        const fixed = await runtime.store.fixLatestPenalty(
            scopeKey(runtime.cfg, event.broadcasterId),
            found.chatterId,
            event.chatterId,
            event.broadcasterId,
            runtime.now(),
        );
        await ctx.say(
            renderMessage(fixed ? runtime.cfg.messages.fixDone : runtime.cfg.messages.fixNone, {
                user: found.viewer.displayName,
                amount: fixed?.amount,
                streak: fixed?.currentStreak,
            }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function undoSetHandler(runtime: Runtime): CommandHandler {
    return async (event, ctx) => {
        const found = await resolveAdminTarget(
            runtime.store,
            runtime.cfg,
            event,
            ctx,
            `!${runtime.cfg.triggers.undoSet} @user`,
        );
        if (!found) return;
        const scope = scopeKey(runtime.cfg, event.broadcasterId);
        const decision = runtime.decisions.latest(scope, found.chatterId);
        if (!decision) {
            await ctx.say(
                renderMessage(runtime.cfg.messages.undoNone, { user: found.viewer.displayName }),
                event.messageId,
                event.broadcasterId,
            );
            return;
        }
        if (runtime.store.hasUnrepairedPenaltyAfter(scope, found.chatterId, decision.createdAt)) {
            await ctx.say(
                renderMessage(runtime.cfg.messages.undoBlocked, { user: found.viewer.displayName }),
                event.messageId,
                event.broadcasterId,
            );
            return;
        }
        const reversal = await runtime.decisions.prepareReverse(
            scope,
            found.chatterId,
            event.chatterId,
            event.broadcasterId,
            runtime.now(),
        );
        if (!reversal) return;
        let current: number | null;
        try {
            current = await runtime.store.applyStreakAdjustment(
                scope,
                found.chatterId,
                reversal.adjustment,
                reversal.previousLongest,
                reversal.transactionId,
                reversal.previousDecisionId,
            );
        } catch (err) {
            await runtime.decisions.cancelReverse(reversal.transactionId);
            throw err;
        }
        if (current === null) {
            await runtime.decisions.cancelReverse(reversal.transactionId);
            return;
        }
        await runtime.decisions.markReverseApplied(reversal.transactionId);
        await ctx.say(
            renderMessage(runtime.cfg.messages.undoDone, {
                user: found.viewer.displayName,
                streak: current,
            }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function openHandler(runtime: Runtime): CommandHandler {
    return async (event, ctx) => {
        const now = runtime.now();
        if (usesBroadcasterPolicy(runtime.cfg)) {
            await handleOnline(runtime, {
                broadcasterId: event.broadcasterId,
                broadcasterName: event.broadcasterName,
                broadcasterDisplayName: event.broadcasterName,
                streamId: `manual:${now.toISOString()}`,
                startedAt: now,
            });
        } else {
            const scope = scopeKey(runtime.cfg, event.broadcasterId);
            await runtime.store.recordStreamDay(
                scope,
                streamDayKey(now, runtime.cfg.timezone),
                now,
            );
            runtime.liveBroadcasters.add(event.broadcasterId);
        }
        await ctx.say(
            renderMessage(runtime.cfg.messages.opened, { day: logicalDay(runtime.cfg, now) }),
            event.messageId,
            event.broadcasterId,
        );
    };
}

function registerCommands(ctx: BotContext, runtime: Runtime): void {
    const definitions: Array<{
        trigger: string;
        allow: Array<'everyone' | 'broadcaster' | 'moderator'>;
        description: string;
        handler: CommandHandler;
    }> = [
        {
            trigger: runtime.cfg.triggers.checkin,
            allow: ['everyone'],
            description: 'Check in while live to build your attendance streak.',
            handler: checkinHandler(runtime),
        },
        {
            trigger: runtime.cfg.triggers.streak,
            allow: ['everyone'],
            description: 'Show a viewer streak.',
            handler: lookupHandler(runtime.store, runtime.cfg),
        },
        {
            trigger: runtime.cfg.triggers.reset,
            allow: ['broadcaster'],
            description: 'Reset a viewer streak.',
            handler: resetHandler(runtime),
        },
        {
            trigger: runtime.cfg.triggers.set,
            allow: ['broadcaster'],
            description: 'Set a canonical viewer streak.',
            handler: setHandler(runtime),
        },
        {
            trigger: runtime.cfg.triggers.fix,
            allow: ['broadcaster'],
            description: 'Repair the latest automatic streak penalty.',
            handler: fixHandler(runtime),
        },
        {
            trigger: runtime.cfg.triggers.undoSet,
            allow: ['broadcaster'],
            description: 'Reverse the latest manual streak set.',
            handler: undoSetHandler(runtime),
        },
        {
            trigger: runtime.cfg.triggers.open,
            allow: ['broadcaster', 'moderator'],
            description: 'Open check-in after a missed online event.',
            handler: openHandler(runtime),
        },
    ];
    for (const definition of definitions) ctx.command(definition);
}

export function createStreakPlugin(now: () => Date = () => new Date()): Plugin {
    let runtime: Runtime | undefined;
    return {
        name: 'streak',
        version: '1.1.0',
        async init(ctx) {
            const cfg = resolveConfig(ctx.config, ctx.logger);
            const required = new Set((ctx.broadcasters ?? []).map(({ id }) => id));
            if (usesBroadcasterPolicy(cfg) && required.size < 2) {
                throw new Error(
                    'all-broadcasters streak policy requires configured broadcaster identities',
                );
            }
            const store = new StreakStore(cfg.dataPath, ctx.logger);
            const decisions = new StreakDecisionStore(cfg.decisionPath, ctx.logger);
            await Promise.all([store.load(), decisions.load()]);
            await decisions.reconcile((scope, chatterId) =>
                store.getManualTransactionId(scope, chatterId),
            );
            runtime = {
                store,
                decisions,
                cfg,
                now,
                liveBroadcasters: new Set(),
                requiredBroadcasterIds: required,
                qualificationTimers: new Map(),
                logger: ctx.logger,
            };
            registerCommands(ctx, runtime);
            ctx.on('streamOnline', (event) =>
                usesBroadcasterPolicy(runtime!.cfg)
                    ? handleOnline(runtime!, event)
                    : handleLegacyOnline(runtime!, event),
            );
            ctx.on('streamOfflinePending', (event) =>
                handlePendingOffline(runtime!, event.broadcasterId, event.observedAt ?? now()),
            );
            ctx.on('streamOffline', (event) =>
                handleOffline(
                    runtime!,
                    event.broadcasterId,
                    event.observedAt ?? now(),
                    event.verified !== false,
                ),
            );
        },
        async dispose(ctx) {
            if (!runtime) return;
            for (const timer of runtime.qualificationTimers.values()) clearTimeout(timer);
            // Drain all in-flight event handlers before flushing so no write is
            // orphaned after the store chain resolves (especially on Windows).
            await ctx.drain();
            await Promise.all([runtime.store.flush(), runtime.decisions.flush()]);
        },
    };
}

export default createStreakPlugin();
