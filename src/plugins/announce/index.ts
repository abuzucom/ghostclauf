// Announce plugin: posts a templated chat message when this channel is
// raided, gets a new subscriber, or receives a cheer. Each event has its own
// enable toggle and template, independently configurable, mirroring
// wentlive's "EventSub -> templated chat post" pattern but bundled into one
// plugin since the three events share one concern (celebrating chat
// activity) and one config surface.
//
// channel.subscribe requires channel:read:subscriptions and channel.cheer
// requires bits:read on the broadcaster token; neither is in the
// unconditionally-required BROADCASTER_SCOPES list (adding either there
// would break startup for every existing deployment). A broadcaster who
// wants these events must re-run `npm run auth -- --broadcaster <login>`
// after granting the scope; until then, EventSub subscription creation
// fails and is logged, and the event simply never fires (see README).

import { z } from 'zod';
import type {
    BotContext,
    CheerEvent,
    Plugin,
    RaidEvent,
    SubscribeEvent,
} from '../../core/types.js';

const MAX_TEMPLATE_LENGTH = 500;
const MAX_MIN_BITS = 1_000_000;

const DEFAULT_RAID_TEMPLATE = '{raider} raided with {viewers} viewers!';
const DEFAULT_SUBSCRIBE_TEMPLATE = '{user} subscribed at tier {tier}{giftNote}!';
const DEFAULT_CHEER_TEMPLATE = '{user} cheered {bits} bits: {message}';
const DEFAULT_MIN_BITS = 100;
const ANONYMOUS_CHEERER = 'Someone';

interface EventConfig {
    enabled: boolean;
    template: string;
}

const CONFIG_FIELD_SCHEMAS = {
    enabled: z.boolean(),
    template: z.string().trim().min(1).max(MAX_TEMPLATE_LENGTH),
    minBits: z.number().int().min(0).max(MAX_MIN_BITS),
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
        'invalid announce config value; falling back to default',
    );
    return fallback;
}

function resolveEventConfig(
    raw: unknown,
    defaultTemplate: string,
    logger: BotContext['logger'],
): EventConfig {
    const block = (raw ?? {}) as Record<string, unknown>;
    return {
        enabled: resolveField('enabled', block.enabled, true, logger),
        template: resolveField('template', block.template, defaultTemplate, logger),
    };
}

export function renderRaid(template: string, event: RaidEvent): string {
    return template
        .replaceAll('{raider}', event.raidingBroadcasterDisplayName)
        .replaceAll('{viewers}', String(event.viewers));
}

/** Twitch's subscription tier codes, mapped to the number chat expects. */
const TIER_LABELS: Readonly<Record<string, string>> = {
    '1000': '1',
    '2000': '2',
    '3000': '3',
};

export function renderSubscribe(template: string, event: SubscribeEvent): string {
    return template
        .replaceAll('{user}', event.userDisplayName)
        .replaceAll('{tier}', TIER_LABELS[event.tier] ?? event.tier)
        .replaceAll('{giftNote}', event.isGift ? ' (gifted)' : '');
}

export function renderCheer(template: string, event: CheerEvent): string {
    return template
        .replaceAll('{user}', event.userDisplayName ?? ANONYMOUS_CHEERER)
        .replaceAll('{bits}', String(event.bits))
        .replaceAll('{message}', event.message);
}

/** Build the announce plugin. No cooldown/state: each event fires once, driven by EventSub. */
export function createAnnouncePlugin(): Plugin {
    return {
        name: 'announce',
        version: '1.0.0',
        init(ctx: BotContext): void {
            const config = ctx.config ?? {};
            const raid = resolveEventConfig(config.raid, DEFAULT_RAID_TEMPLATE, ctx.logger);
            const subscribe = resolveEventConfig(
                config.subscribe,
                DEFAULT_SUBSCRIBE_TEMPLATE,
                ctx.logger,
            );
            const cheer = resolveEventConfig(config.cheer, DEFAULT_CHEER_TEMPLATE, ctx.logger);
            const cheerBlock = (config.cheer ?? {}) as Record<string, unknown>;
            const minBits = resolveField(
                'minBits',
                cheerBlock.minBits,
                DEFAULT_MIN_BITS,
                ctx.logger,
            );

            if (raid.enabled) {
                ctx.on('raid', async (event) => {
                    await ctx.say(renderRaid(raid.template, event), undefined, event.broadcasterId);
                });
            }
            if (subscribe.enabled) {
                ctx.on('subscribe', async (event) => {
                    await ctx.say(
                        renderSubscribe(subscribe.template, event),
                        undefined,
                        event.broadcasterId,
                    );
                });
            }
            if (cheer.enabled) {
                ctx.on('cheer', async (event) => {
                    if (event.bits < minBits) return;
                    await ctx.say(
                        renderCheer(cheer.template, event),
                        undefined,
                        event.broadcasterId,
                    );
                });
            }
        },
    };
}

const plugin = createAnnouncePlugin();
export default plugin;
