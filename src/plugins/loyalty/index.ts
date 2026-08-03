// Loyalty plugin: viewers passively earn a configurable currency for being
// active in chat while the channel is live. Every tickIntervalMinutes, each
// chatter who sent at least one message since the last tick is awarded
// pointsPerTick. This is a CHAT-ACTIVITY PROXY, not real Twitch viewership -
// the bot only sees chat messages, never the viewer list, so it cannot know
// who is actually watching versus merely chatting. !points reports a
// balance; !pointsboard shows the top earners. No spend/redemption yet.

import { z } from 'zod';
import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { buildLeaderboard, renderBalance, renderLeaderboard } from './loyalty.js';
import { LoyaltyStore, SHARED_SCOPE_KEY } from './store.js';
import type { Award } from './store.js';

const DEFAULT_DATA_PATH = './data/loyalty.json';
const DEFAULT_CURRENCY_NAME = 'points';
const DEFAULT_POINTS_PER_TICK = 1;
const DEFAULT_TICK_INTERVAL_MINUTES = 5;
const DEFAULT_COOLDOWN_SECONDS = 10;
const DEFAULT_LEADERBOARD_SIZE = 5;
const MAX_COOLDOWN_SECONDS = 3600;
const MAX_POINTS_PER_TICK = 1_000;
const MAX_TICK_INTERVAL_MINUTES = 1_440;
const MAX_LEADERBOARD_SIZE = 25;
const MAX_CURRENCY_NAME_LENGTH = 32;
const MAX_PATH_LENGTH = 4096;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

const CONFIG_FIELD_SCHEMAS = {
    dataPath: z.string().trim().min(1).max(MAX_PATH_LENGTH),
    shareAcrossChannels: z.boolean(),
    currencyName: z.string().trim().min(1).max(MAX_CURRENCY_NAME_LENGTH),
    pointsPerTick: z.number().int().min(1).max(MAX_POINTS_PER_TICK),
    tickIntervalMinutes: z.number().int().min(1).max(MAX_TICK_INTERVAL_MINUTES),
    cooldownSeconds: z.number().int().min(0).max(MAX_COOLDOWN_SECONDS),
    leaderboardSize: z.number().int().min(1).max(MAX_LEADERBOARD_SIZE),
} as const;

/** Validate one config field, warning and falling back when it is invalid. */
function resolveField<K extends keyof typeof CONFIG_FIELD_SCHEMAS>(
    field: K,
    configured: unknown,
    fallback: z.infer<(typeof CONFIG_FIELD_SCHEMAS)[K]>,
    logger: BotContext['logger'],
): z.infer<(typeof CONFIG_FIELD_SCHEMAS)[K]> {
    if (configured === undefined) return fallback;
    const result = CONFIG_FIELD_SCHEMAS[field].safeParse(configured);
    if (result.success) return result.data;
    logger.warn(
        { field, configured, issues: result.error.issues },
        'invalid loyalty config value; falling back to default',
    );
    return fallback;
}

interface LoyaltyRuntime {
    store: LoyaltyStore;
    cooldown: CooldownGate;
    currencyName: string;
    shareAcrossChannels: boolean;
    leaderboardSize: number;
    now: () => Date;
}

function scopeKeyFor(runtime: LoyaltyRuntime, broadcasterId: string): string {
    return runtime.shareAcrossChannels ? SHARED_SCOPE_KEY : broadcasterId;
}

/** True when the chatter must wait; records the invocation otherwise. */
function isThrottled(runtime: LoyaltyRuntime, event: ChatCommandEvent): boolean {
    if (event.roles.has('broadcaster') || event.roles.has('moderator')) return false;
    const key = `${event.command}:${event.broadcasterId}:${event.chatterId}`;
    return runtime.cooldown.shouldThrottle(key, runtime.now().getTime());
}

function reply(ctx: BotContext, event: ChatCommandEvent, text: string): Promise<void> {
    return ctx.say(text, event.messageId, event.broadcasterId);
}

function registerBalanceCommand(ctx: BotContext, runtime: LoyaltyRuntime): void {
    ctx.command({
        trigger: 'points',
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
        trigger: 'pointsboard',
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
 * Build the loyalty plugin. `now` is injectable so cooldown timing is
 * deterministically testable; production use relies on the real clock.
 */
export function createLoyaltyPlugin(now: () => Date = () => new Date()): Plugin {
    let store: LoyaltyStore | null = null;
    let tickTimer: NodeJS.Timeout | null = null;

    return {
        name: 'loyalty',
        version: '1.0.0',
        async init(ctx: BotContext): Promise<void> {
            const config = ctx.config ?? {};
            const dataPath = resolveField(
                'dataPath',
                config.dataPath,
                DEFAULT_DATA_PATH,
                ctx.logger,
            );
            store = new LoyaltyStore(dataPath, ctx.logger);
            await store.load();

            const currencyName = resolveField(
                'currencyName',
                config.currencyName,
                DEFAULT_CURRENCY_NAME,
                ctx.logger,
            );
            const shareAcrossChannels = resolveField(
                'shareAcrossChannels',
                config.shareAcrossChannels,
                true,
                ctx.logger,
            );
            const pointsPerTick = resolveField(
                'pointsPerTick',
                config.pointsPerTick,
                DEFAULT_POINTS_PER_TICK,
                ctx.logger,
            );
            const tickIntervalMinutes = resolveField(
                'tickIntervalMinutes',
                config.tickIntervalMinutes,
                DEFAULT_TICK_INTERVAL_MINUTES,
                ctx.logger,
            );
            const cooldownSeconds = resolveField(
                'cooldownSeconds',
                config.cooldownSeconds,
                DEFAULT_COOLDOWN_SECONDS,
                ctx.logger,
            );
            const leaderboardSize = resolveField(
                'leaderboardSize',
                config.leaderboardSize,
                DEFAULT_LEADERBOARD_SIZE,
                ctx.logger,
            );

            const runtime: LoyaltyRuntime = {
                store,
                cooldown: new CooldownGate(cooldownSeconds * MS_PER_SECOND),
                currencyName,
                shareAcrossChannels,
                leaderboardSize,
                now,
            };

            registerBalanceCommand(ctx, runtime);
            registerLeaderboardCommand(ctx, runtime);

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
                liveBroadcasters.delete(event.broadcasterId);
                activeSinceLastTick.delete(event.broadcasterId);
            });
            ctx.on('chatMessage', (event) => {
                if (!liveBroadcasters.has(event.broadcasterId)) return;
                activeChatters(event.broadcasterId).set(event.chatterId, event.chatterDisplayName);
            });

            tickTimer = setInterval(() => {
                for (const [broadcasterId, chatters] of activeSinceLastTick) {
                    if (chatters.size === 0) continue;
                    const scopeKey = scopeKeyFor(runtime, broadcasterId);
                    const awards: Award[] = [...chatters].map(([chatterId, displayName]) => ({
                        chatterId,
                        displayName,
                        amount: pointsPerTick,
                    }));
                    chatters.clear();
                    void store?.awardMany(scopeKey, awards);
                }
            }, tickIntervalMinutes * MS_PER_MINUTE);
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
