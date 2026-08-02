// Funfact plugin: broadcasters curate a persistent pool of fun facts with
// !addfunfact / !delfunfact, and anyone can pull one with !funfact. Reads are
// throttled per chatter per channel so the pool cannot be spammed into chat.
//
// The curation commands are registered for moderators as well as broadcasters
// because the registry enforces `allow` before the handler runs; the handler
// then narrows to broadcasters plus the configured cross-channel curators.

import type { BotContext, ChatCommandEvent, Plugin } from '../../core/types.js';
import { CooldownGate } from '../../core/cooldown.js';
import { LOGIN_PATTERN } from '../../core/logins.js';
import { MAX_FACT_LENGTH, parseFactId, renderFact, validateFactText } from './fact.js';
import type { FactRejection } from './fact.js';
import { FunFactStore, MAX_FACTS, SHARED_SCOPE_KEY } from './store.js';
import type { FunFactConfig } from './types.js';

const DEFAULT_DATA_PATH = './data/funfacts.json';
const DEFAULT_COOLDOWN_SECONDS = 30;
const MAX_COOLDOWN_SECONDS = 3600;
const MS_PER_SECOND = 1000;

const REJECTION_MESSAGES: Readonly<Record<FactRejection, string>> = {
    empty: 'Usage: addfunfact <text>',
    'too-long': `Fun facts are limited to ${MAX_FACT_LENGTH} characters.`,
    command: 'Fun facts cannot start with "/" or ".".',
};

const NO_FACTS_MESSAGE = 'No fun facts yet.';
const BAD_ID_MESSAGE = 'That is not a fun fact id.';

/**
 * Build the lookup table for the cross-channel curation exception. Keys and
 * values are lowercased Twitch logins; `Map`/`Set` are used instead of a plain
 * object so a chatter or channel login can never be interpreted as an
 * inherited `Object.prototype` member (e.g. "constructor").
 */
function buildElevationMap(config: FunFactConfig): Map<string, Set<string>> {
    const entries = Object.entries(config.treatAsBroadcaster ?? {});
    return new Map(
        entries.map(([broadcasterLogin, chatterLogins]) => [
            broadcasterLogin.toLowerCase(),
            new Set(chatterLogins.map((login) => login.toLowerCase())),
        ]),
    );
}

function isElevated(
    elevationMap: Map<string, Set<string>>,
    broadcasterName: string,
    chatterName: string,
): boolean {
    if (!LOGIN_PATTERN.test(broadcasterName) || !LOGIN_PATTERN.test(chatterName)) return false;
    return elevationMap.get(broadcasterName)?.has(chatterName) ?? false;
}

/** Resolve the read cooldown, bounding invalid config to the default. */
function resolveCooldownSeconds(configured: unknown, logger: BotContext['logger']): number {
    if (configured === undefined) return DEFAULT_COOLDOWN_SECONDS;
    if (
        typeof configured === 'number' &&
        Number.isInteger(configured) &&
        configured >= 0 &&
        configured <= MAX_COOLDOWN_SECONDS
    ) {
        return configured;
    }
    logger.warn({ configured }, 'invalid funfact cooldownSeconds; falling back to default');
    return DEFAULT_COOLDOWN_SECONDS;
}

function resolveDataPath(configured: unknown, logger: BotContext['logger']): string {
    if (configured === undefined) return DEFAULT_DATA_PATH;
    if (typeof configured === 'string' && configured.trim().length > 0) return configured;
    logger.warn('invalid funfact dataPath; falling back to default');
    return DEFAULT_DATA_PATH;
}

function resolveShareAcrossChannels(configured: unknown, logger: BotContext['logger']): boolean {
    if (configured === undefined) return true;
    if (typeof configured === 'boolean') return configured;
    logger.warn({ configured }, 'invalid funfact shareAcrossChannels; falling back to default');
    return true;
}

/** Shared state handed to each command binding. */
interface FunFactRuntime {
    store: FunFactStore;
    cooldown: CooldownGate;
    elevationMap: Map<string, Set<string>>;
    shareAcrossChannels: boolean;
    now: () => Date;
    roll: () => number;
}

function scopeKeyFor(runtime: FunFactRuntime, event: ChatCommandEvent): string {
    return runtime.shareAcrossChannels ? SHARED_SCOPE_KEY : event.broadcasterId;
}

function canCurate(runtime: FunFactRuntime, event: ChatCommandEvent): boolean {
    if (event.roles.has('broadcaster')) return true;
    return isElevated(runtime.elevationMap, event.broadcasterName, event.chatterName);
}

/** True when the chatter must wait; records the invocation otherwise. */
function isThrottled(runtime: FunFactRuntime, event: ChatCommandEvent): boolean {
    if (event.roles.has('broadcaster') || event.roles.has('moderator')) return false;
    const key = `${event.command}:${event.broadcasterId}:${event.chatterId}`;
    return runtime.cooldown.shouldThrottle(key, runtime.now().getTime());
}

function reply(ctx: BotContext, event: ChatCommandEvent, text: string): Promise<void> {
    return ctx.say(text, event.messageId, event.broadcasterId);
}

function registerAddCommand(ctx: BotContext, runtime: FunFactRuntime): void {
    ctx.command({
        trigger: 'addfunfact',
        allow: ['moderator', 'broadcaster'],
        description: 'Add a fun fact to the pool (broadcasters only).',
        handler: async (event, ctx) => {
            if (!canCurate(runtime, event)) return;
            const validation = validateFactText(event.argString);
            if (!validation.ok) {
                await reply(ctx, event, REJECTION_MESSAGES[validation.reason]);
                return;
            }
            const outcome = await runtime.store.add(
                scopeKeyFor(runtime, event),
                validation.text,
                event.chatterId,
                event.chatterDisplayName,
                event.broadcasterId,
                runtime.now(),
            );
            if (outcome.status === 'duplicate') {
                await reply(ctx, event, `That is already fun fact #${outcome.fact.id}.`);
                return;
            }
            if (outcome.status === 'full') {
                await reply(
                    ctx,
                    event,
                    `The fun fact pool is full (${MAX_FACTS}). Delete one first.`,
                );
                return;
            }
            await reply(ctx, event, `Added fun fact #${outcome.fact.id}.`);
        },
    });
}

function registerDeleteCommand(ctx: BotContext, runtime: FunFactRuntime): void {
    ctx.command({
        trigger: 'delfunfact',
        allow: ['moderator', 'broadcaster'],
        description: 'Delete a fun fact by id (broadcasters only).',
        handler: async (event, ctx) => {
            if (!canCurate(runtime, event)) return;
            const id = parseFactId(event.args[0]);
            if (id === null) {
                await reply(ctx, event, 'Usage: delfunfact <id>');
                return;
            }
            const removed = await runtime.store.remove(scopeKeyFor(runtime, event), id);
            const message = removed ? `Removed fun fact #${id}.` : `No fun fact #${id}.`;
            await reply(ctx, event, message);
        },
    });
}

function registerReadCommand(ctx: BotContext, runtime: FunFactRuntime): void {
    ctx.command({
        trigger: 'funfact',
        allow: ['everyone'],
        description: 'Post a random fun fact, or the one with the given id.',
        handler: async (event, ctx) => {
            if (isThrottled(runtime, event)) return;
            const scopeKey = scopeKeyFor(runtime, event);
            if (event.argString.length === 0) {
                const fact = runtime.store.pick(scopeKey, runtime.roll());
                await reply(ctx, event, fact ? renderFact(fact) : NO_FACTS_MESSAGE);
                return;
            }
            const id = parseFactId(event.args[0]);
            if (id === null) {
                await reply(ctx, event, BAD_ID_MESSAGE);
                return;
            }
            const fact = runtime.store.get(scopeKey, id);
            await reply(ctx, event, fact ? renderFact(fact) : `No fun fact #${id}.`);
        },
    });
}

function registerCountCommand(ctx: BotContext, runtime: FunFactRuntime): void {
    ctx.command({
        trigger: 'funfactcount',
        allow: ['everyone'],
        description: 'Report how many fun facts are stored.',
        handler: async (event, ctx) => {
            if (isThrottled(runtime, event)) return;
            const total = runtime.store.count(scopeKeyFor(runtime, event));
            const noun = total === 1 ? 'fun fact' : 'fun facts';
            await reply(ctx, event, `${total} ${noun} stored.`);
        },
    });
}

/**
 * Build the funfact plugin. `now` and `roll` are injectable so cooldown timing
 * and random selection are deterministically testable; production use relies on
 * the real clock and Math.random.
 */
export function createFunFactPlugin(
    now: () => Date = () => new Date(),
    roll: () => number = () => Math.random(),
): Plugin {
    let store: FunFactStore | null = null;
    return {
        name: 'funfact',
        version: '1.0.0',
        async init(ctx: BotContext): Promise<void> {
            const config = (ctx.config ?? {}) as FunFactConfig;
            const dataPath = resolveDataPath(config.dataPath, ctx.logger);
            store = new FunFactStore(dataPath, ctx.logger);
            await store.load();
            const runtime: FunFactRuntime = {
                store,
                cooldown: new CooldownGate(
                    resolveCooldownSeconds(config.cooldownSeconds, ctx.logger) * MS_PER_SECOND,
                ),
                elevationMap: buildElevationMap(config),
                shareAcrossChannels: resolveShareAcrossChannels(
                    config.shareAcrossChannels,
                    ctx.logger,
                ),
                now,
                roll,
            };
            registerAddCommand(ctx, runtime);
            registerDeleteCommand(ctx, runtime);
            registerReadCommand(ctx, runtime);
            registerCountCommand(ctx, runtime);
        },
        async dispose(ctx: BotContext): Promise<void> {
            await ctx.drain();
            await store?.flush();
        },
    };
}

const plugin = createFunFactPlugin();
export default plugin;
