// Announce plugin: posts a templated chat message when this channel is
// raided, gets a new subscriber, or receives a cheer. Each event has its own
// enable toggle and template, independently configurable, mirroring
// wentlive's "EventSub -> templated chat post" pattern but bundled into one
// plugin since the three events share one concern (celebrating chat
// activity) and one config surface.
//
// channel.subscribe requires channel:read:subscriptions and channel.cheer
// requires bits:read on the broadcaster token. Both are in
// BROADCASTER_SCOPES (src/core/auth.ts), so `npm run auth -- --broadcaster
// <login>` (and the checkTokens-driven re-auth prompt in run.sh/run.bat)
// requests them for every broadcaster, whether or not this plugin is
// enabled - a deliberate tradeoff to reuse the existing all-or-nothing
// scope machinery instead of building per-plugin conditional scopes. If a
// broadcaster's token predates this and hasn't been through that prompt
// yet, the corresponding EventSub subscription just fails to create
// (already logged) and that event never fires; it does not stop the bot
// from starting (see README).

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
/** Twitch's chat message limit; a cheer's free-form message can push a
 * rendered announcement past it, so every render is truncated before send. */
const MAX_CHAT_MESSAGE_LENGTH = 500;

const DEFAULT_RAID_TEMPLATE = '{raider} raided with {viewers} viewers!';
const DEFAULT_SUBSCRIBE_TEMPLATE = '{user} subscribed at tier {tier}{giftNote}!';
const DEFAULT_CHEER_TEMPLATE = '{user} cheered {bits} bits: {message}';
const DEFAULT_MIN_BITS = 100;
const ANONYMOUS_CHEERER = 'Someone';

/**
 * Twitch chat interprets a leading "/" or "." as a chat command. Defined here
 * rather than shared with funfact/quotes so plugins stay independent of one
 * another; those two reject such text at submission, this one defuses it.
 */
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

/**
 * Collapse untrusted chatter text to a single trimmed line, matching
 * funfact's `sanitizeFactText`. Applied to a cheer's free-form message, the
 * only field here a chatter writes directly; display names come from Twitch
 * and cannot carry control characters.
 */
export function sanitizeChatterText(raw: string): string {
    const stripped = [...raw].map((ch) => (isControlCharacter(ch) ? ' ' : ch)).join('');
    return stripped.replace(WHITESPACE_RUN, ' ').trim();
}

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
        .replaceAll('{message}', sanitizeChatterText(event.message));
}

/** Truncate to Twitch's chat message limit, counting by code point so a
 * multi-byte character is never split. `ctx.say` throws past this limit. */
export function truncateForChat(text: string): string {
    const codePoints = [...text];
    if (codePoints.length <= MAX_CHAT_MESSAGE_LENGTH) return text;
    return codePoints.slice(0, MAX_CHAT_MESSAGE_LENGTH).join('');
}

/**
 * Prefix that neutralizes a leading command sigil. Zero width, so the
 * announcement still reads correctly in chat.
 */
export const ZERO_WIDTH_SPACE = '\u200B';

/**
 * Finalize a rendered announcement for sending.
 *
 * A cheer's free-form message is untrusted chatter input, and a broadcaster
 * template may place it first (e.g. "{message}"), so the rendered text can
 * start with a sigil a chat client would run as a command. `funfact` and
 * `quotes` reject such text at submission; an announcement has no submitter
 * to reject, so the sigil is defused instead of dropping the announcement.
 *
 * The text is trimmed before the sigil check so what is inspected is what is
 * sent: chat strips leading whitespace, so " /ban" would otherwise slip past
 * a check on the raw first character and still reach chat as a command.
 *
 * Neutralizing runs before truncation so the added prefix cannot push the
 * result past the 500 code-point limit that `ctx.say` enforces.
 */
export function formatForChat(text: string): string {
    const trimmed = text.trim();
    const defused = COMMAND_SIGILS.includes(trimmed[0] ?? '')
        ? `${ZERO_WIDTH_SPACE}${trimmed}`
        : trimmed;
    return truncateForChat(defused);
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
                    await ctx.say(
                        formatForChat(renderRaid(raid.template, event)),
                        undefined,
                        event.broadcasterId,
                    );
                });
            }
            if (subscribe.enabled) {
                ctx.on('subscribe', async (event) => {
                    await ctx.say(
                        formatForChat(renderSubscribe(subscribe.template, event)),
                        undefined,
                        event.broadcasterId,
                    );
                });
            }
            if (cheer.enabled) {
                ctx.on('cheer', async (event) => {
                    if (event.bits < minBits) return;
                    await ctx.say(
                        formatForChat(renderCheer(cheer.template, event)),
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
