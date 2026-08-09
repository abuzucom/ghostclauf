// Loyalty plugin: viewers passively earn esports dollars for being active in
// chat while the channel is live. Every tickIntervalMinutes, each chatter who
// sent at least one message since the last tick is awarded dollarsPerTick.
// This is a CHAT-ACTIVITY PROXY, not real Twitch viewership - the bot only
// sees chat messages, never the viewer list, so it cannot know who is actually
// watching versus merely chatting. !wallet reports a balance; !economy shows
// the top earners. No spend/redemption yet.

import { DateTime, Duration } from 'luxon';
import { z } from 'zod';
import { resolveConfigField } from '../../core/configField.js';
import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { parseLogin } from '../../core/logins.js';
import {
    ADMIN_LOOKUP_FAILED_MESSAGE,
    buildLeaderboard,
    parseEsdAmount,
    renderAdjustDone,
    renderAdminUnknownUser,
    renderAdminUsage,
    renderAdminViewerCap,
    renderBalance,
    renderLeaderboard,
    renderUndoDone,
    renderUndoNone,
} from './loyalty.js';
import type { EsdDecisionKind } from './loyalty.js';
import { LoyaltyStore, MAX_BALANCE, SHARED_SCOPE_KEY } from './store.js';
import type { Award, DecisionKind } from './store.js';

const DEFAULT_DATA_PATH = './data/loyalty.json';
const DEFAULT_CURRENCY_NAME = 'esports dollars';
const DEFAULT_DOLLARS_PER_TICK = 1;
const DEFAULT_TICK_INTERVAL_MINUTES = 5;
const DEFAULT_COOLDOWN_SECONDS = 10;
const DEFAULT_LEADERBOARD_SIZE = 5;
const MAX_COOLDOWN_SECONDS = 3600;
const MAX_DOLLARS_PER_TICK = 1_000;
const MAX_TICK_INTERVAL_MINUTES = 1_440;
const MAX_LEADERBOARD_SIZE = 25;
const MAX_CURRENCY_NAME_LENGTH = 32;
const MAX_PATH_LENGTH = 4096;

const CONFIG_FIELD_SCHEMAS = {
    dataPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    shareAcrossChannels: z.boolean(),
    currencyName: z.string().trim().min(1).max(MAX_CURRENCY_NAME_LENGTH),
    dollarsPerTick: z.number().int().min(1).max(MAX_DOLLARS_PER_TICK),
    tickIntervalMinutes: z.number().int().min(1).max(MAX_TICK_INTERVAL_MINUTES),
    cooldownSeconds: z.number().int().min(0).max(MAX_COOLDOWN_SECONDS),
    leaderboardSize: z.number().int().min(1).max(MAX_LEADERBOARD_SIZE),
} as const;

interface LoyaltyRuntime {
    store: LoyaltyStore;
    cooldown: CooldownGate;
    currencyName: string;
    shareAcrossChannels: boolean;
    leaderboardSize: number;
    now: () => DateTime;
}

function scopeKeyFor(runtime: LoyaltyRuntime, broadcasterId: string): string {
    return runtime.shareAcrossChannels ? SHARED_SCOPE_KEY : broadcasterId;
}

/** True when the chatter must wait; records the invocation otherwise. */
function isThrottled(runtime: LoyaltyRuntime, event: ChatCommandEvent): boolean {
    if (event.roles.has('broadcaster') || event.roles.has('moderator')) return false;
    const key = `${event.command}:${event.broadcasterId}:${event.chatterId}`;
    return runtime.cooldown.shouldThrottle(key, runtime.now().toMillis());
}

function reply(ctx: BotContext, event: ChatCommandEvent, text: string): Promise<void> {
    return ctx.say(text, event.messageId, event.broadcasterId);
}

function registerBalanceCommand(ctx: BotContext, runtime: LoyaltyRuntime): void {
    ctx.command({
        trigger: 'wallet',
        allow: ['everyone'],
        description: 'Report your loyalty balance.',
        handler: async (event, ctx) => {
            if (isThrottled(runtime, event)) return;
            const scopeKey = scopeKeyFor(runtime, event.broadcasterId);
            const balance = runtime.store.getBalance(scopeKey, event.chatterId);
            await reply(
                ctx,
                event,
                renderBalance(runtime.currencyName, event.chatterDisplayName, balance),
            );
        },
    });
}

function registerLeaderboardCommand(ctx: BotContext, runtime: LoyaltyRuntime): void {
    ctx.command({
        trigger: 'economy',
        allow: ['everyone'],
        description: 'Show the top loyalty balances.',
        handler: async (event, ctx) => {
            if (isThrottled(runtime, event)) return;
            const scopeKey = scopeKeyFor(runtime, event.broadcasterId);
            const viewers = runtime.store.leaderboardViewers(scopeKey);
            const entries = buildLeaderboard(viewers, runtime.leaderboardSize);
            await reply(ctx, event, renderLeaderboard(runtime.currencyName, entries));
        },
    });
}

/**
 * Resolve the @user argument of a broadcaster-only balance command via Helix,
 * not the local viewer store - unlike streak's admin commands, this lets the
 * broadcaster target any Twitch user, not only one the bot has already seen
 * chat from. Replies and returns null on a missing or unresolvable argument.
 */
async function resolveEsdTarget(
    event: ChatCommandEvent,
    ctx: BotContext,
    usage: string,
): Promise<{ id: string; displayName: string } | null> {
    const login = parseLogin(event.args[0]);
    if (!login) {
        await reply(ctx, event, renderAdminUsage(usage));
        return null;
    }
    let user;
    try {
        user = await ctx.helix.getUserByLogin(login);
    } catch (err) {
        ctx.logger.error({ err, login }, 'loyalty admin command: Helix user lookup failed');
        await reply(ctx, event, ADMIN_LOOKUP_FAILED_MESSAGE);
        return null;
    }
    if (!user) {
        await reply(ctx, event, renderAdminUnknownUser(login));
        return null;
    }
    return { id: user.id, displayName: user.displayName };
}

/**
 * Parse and range-check the !setESD/!giveESD/!takeESD amount argument.
 * `set` accepts [0, MAX_BALANCE]; `give`/`take` require >= 1 (adjusting by
 * zero is a no-op) and are likewise capped at MAX_BALANCE.
 */
function parseEsdAmountForKind(kind: DecisionKind, token: string | undefined): number | null {
    const amount = parseEsdAmount(token);
    if (amount === null || amount > MAX_BALANCE) return null;
    if (kind !== 'set' && amount < 1) return null;
    return amount;
}

function registerAdjustCommand(
    ctx: BotContext,
    runtime: LoyaltyRuntime,
    trigger: string,
    kind: DecisionKind,
    usage: string,
): void {
    ctx.command({
        trigger,
        allow: ['broadcaster'],
        description: `Broadcaster-only: ${kind} a viewer's ${runtime.currencyName} balance.`,
        handler: async (event, ctx) => {
            const amount = parseEsdAmountForKind(kind, event.args[1]);
            if (amount === null) {
                await reply(ctx, event, renderAdminUsage(usage));
                return;
            }
            const target = await resolveEsdTarget(event, ctx, usage);
            if (!target) return;
            const scopeKey = scopeKeyFor(runtime, event.broadcasterId);
            const result = await runtime.store.applyDecision({
                scopeKey,
                kind,
                chatterId: target.id,
                chatterName: target.displayName,
                displayName: target.displayName,
                requestedAmount: amount,
                createdByChatterId: event.chatterId,
                createdByChatterName: event.chatterDisplayName,
                createdInBroadcasterId: event.broadcasterId,
                now: runtime.now(),
            });
            if (!result.ok) {
                if (result.reason === 'viewer-cap') {
                    await reply(ctx, event, renderAdminViewerCap(target.displayName));
                    return;
                }
                // 'unstorable': target.id came from Helix, a trusted numeric
                // Twitch id, so this should be unreachable - log it rather
                // than silently reporting it as if the syntax were wrong.
                ctx.logger.error(
                    { chatterId: target.id, kind },
                    'loyalty admin command: unstorable chatter id from Helix',
                );
                await reply(ctx, event, renderAdminUsage(usage));
                return;
            }
            const { beforeBalance, afterBalance } = result.decision;
            const actualAmount =
                kind === 'set'
                    ? afterBalance
                    : kind === 'give'
                      ? afterBalance - beforeBalance
                      : beforeBalance - afterBalance;
            await reply(
                ctx,
                event,
                renderAdjustDone(
                    runtime.currencyName,
                    kind,
                    target.displayName,
                    amount,
                    actualAmount,
                    afterBalance,
                ),
            );
        },
    });
}

function registerUndoCommand(
    ctx: BotContext,
    runtime: LoyaltyRuntime,
    trigger: string,
    kind: EsdDecisionKind,
    usage: string,
): void {
    ctx.command({
        trigger,
        allow: ['broadcaster'],
        description: `Broadcaster-only: undo the last !${kind}ESD for a viewer.`,
        handler: async (event, ctx) => {
            const target = await resolveEsdTarget(event, ctx, usage);
            if (!target) return;
            const scopeKey = scopeKeyFor(runtime, event.broadcasterId);
            const result = await runtime.store.undoLatest(
                scopeKey,
                target.id,
                kind,
                { chatterId: event.chatterId },
                runtime.now(),
            );
            if (!result.ok) {
                await reply(ctx, event, renderUndoNone(kind, target.displayName));
                return;
            }
            await reply(
                ctx,
                event,
                renderUndoDone(runtime.currencyName, kind, target.displayName, result.balance),
            );
        },
    });
}

/**
 * Build the loyalty plugin. `now` is injectable so cooldown timing is
 * deterministically testable; production use relies on the real clock.
 */
export function createLoyaltyPlugin(now: () => DateTime = () => DateTime.utc()): Plugin {
    let store: LoyaltyStore | null = null;
    let tickTimer: NodeJS.Timeout | null = null;

    return {
        name: 'loyalty',
        version: '1.0.0',
        async init(ctx: BotContext): Promise<void> {
            const config = ctx.config ?? {};
            const dataPath = resolveConfigField(
                'loyalty',
                'dataPath',
                CONFIG_FIELD_SCHEMAS.dataPath,
                config.dataPath,
                DEFAULT_DATA_PATH,
                ctx.logger,
            );
            store = new LoyaltyStore(dataPath, ctx.logger);
            await store.load();

            const currencyName = resolveConfigField(
                'loyalty',
                'currencyName',
                CONFIG_FIELD_SCHEMAS.currencyName,
                config.currencyName,
                DEFAULT_CURRENCY_NAME,
                ctx.logger,
            );
            const shareAcrossChannels = resolveConfigField(
                'loyalty',
                'shareAcrossChannels',
                CONFIG_FIELD_SCHEMAS.shareAcrossChannels,
                config.shareAcrossChannels,
                true,
                ctx.logger,
            );
            const dollarsPerTick = resolveConfigField(
                'loyalty',
                'dollarsPerTick',
                CONFIG_FIELD_SCHEMAS.dollarsPerTick,
                config.dollarsPerTick,
                DEFAULT_DOLLARS_PER_TICK,
                ctx.logger,
            );
            const tickIntervalMinutes = resolveConfigField(
                'loyalty',
                'tickIntervalMinutes',
                CONFIG_FIELD_SCHEMAS.tickIntervalMinutes,
                config.tickIntervalMinutes,
                DEFAULT_TICK_INTERVAL_MINUTES,
                ctx.logger,
            );
            const cooldownSeconds = resolveConfigField(
                'loyalty',
                'cooldownSeconds',
                CONFIG_FIELD_SCHEMAS.cooldownSeconds,
                config.cooldownSeconds,
                DEFAULT_COOLDOWN_SECONDS,
                ctx.logger,
            );
            const leaderboardSize = resolveConfigField(
                'loyalty',
                'leaderboardSize',
                CONFIG_FIELD_SCHEMAS.leaderboardSize,
                config.leaderboardSize,
                DEFAULT_LEADERBOARD_SIZE,
                ctx.logger,
            );

            const runtime: LoyaltyRuntime = {
                store,
                cooldown: new CooldownGate(
                    Duration.fromObject({ seconds: cooldownSeconds }).as('milliseconds'),
                ),
                currencyName,
                shareAcrossChannels,
                leaderboardSize,
                now,
            };

            registerBalanceCommand(ctx, runtime);
            registerLeaderboardCommand(ctx, runtime);

            // Broadcaster-only balance overrides. Every configured broadcaster
            // is the operator's own channel or persona, so `allow: ['broadcaster']`
            // alone is a correct gate here - see the Phase 1b note in README.md.
            registerAdjustCommand(ctx, runtime, 'setesd', 'set', '!setESD @user <amount>');
            registerAdjustCommand(ctx, runtime, 'giveesd', 'give', '!giveESD @user <amount>');
            registerAdjustCommand(ctx, runtime, 'takeesd', 'take', '!takeESD @user <amount>');
            registerUndoCommand(ctx, runtime, 'undosetesd', 'set', '!undosetESD @user');
            registerUndoCommand(ctx, runtime, 'undogiveesd', 'give', '!undogiveESD @user');
            registerUndoCommand(ctx, runtime, 'undotakeesd', 'take', '!undotakeESD @user');

            // Chat-activity tracking: a chatter who sends any chat message
            // while their channel is live is credited on the next tick. Not
            // real watch-time - see the module comment above.
            const liveBroadcasters = new Set<string>();
            const activeSinceLastTick = new Map<string, Map<string, string>>();

            const activeChatters = (broadcasterId: string): Map<string, string> => {
                const existing = activeSinceLastTick.get(broadcasterId);
                if (existing) return existing;
                const created = new Map<string, string>();
                activeSinceLastTick.set(broadcasterId, created);
                return created;
            };

            ctx.on('streamOnline', (event) => {
                liveBroadcasters.add(event.broadcasterId);
            });
            ctx.on('streamOffline', (event) => {
                // An unverified offline must not cost anyone their tick
                // activity: verification can fail transiently, and treating
                // it as a real offline would discard up to a full tick of
                // earned activity for a channel that is probably still live.
                // Absent is optimistically treated as verified, matching
                // streak's handling of the same field.
                if (event.verified === false) return;
                liveBroadcasters.delete(event.broadcasterId);
                activeSinceLastTick.delete(event.broadcasterId);
            });
            ctx.on('chatMessage', (event) => {
                if (!liveBroadcasters.has(event.broadcasterId)) return;
                activeChatters(event.broadcasterId).set(event.chatterId, event.chatterDisplayName);
            });

            tickTimer = setInterval(
                () => {
                    for (const [broadcasterId, chatters] of activeSinceLastTick) {
                        if (chatters.size === 0) continue;
                        const scopeKey = scopeKeyFor(runtime, broadcasterId);
                        const awards: Award[] = [...chatters].map(([chatterId, displayName]) => ({
                            chatterId,
                            displayName,
                            amount: dollarsPerTick,
                        }));
                        chatters.clear();
                        store
                            ?.awardMany(scopeKey, awards)
                            .catch((err: unknown) =>
                                ctx.logger.error(
                                    { err, scopeKey, broadcasterId },
                                    'loyalty tick award failed',
                                ),
                            );
                    }
                },
                Duration.fromObject({ minutes: tickIntervalMinutes }).as('milliseconds'),
            );
            tickTimer.unref?.();
        },
        async dispose(ctx: BotContext): Promise<void> {
            if (tickTimer) clearInterval(tickTimer);
            await ctx.drain();
            await store?.flush();
        },
    };
}

const plugin = createLoyaltyPlugin();
export default plugin;
