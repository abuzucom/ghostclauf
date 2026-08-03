import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQuotesPlugin } from '../src/plugins/quotes/index.js';
import { MAX_QUOTE_TEXT_LENGTH, MAX_SPEAKER_LENGTH } from '../src/plugins/quotes/quote.js';
import { QuoteStore, SHARED_SCOPE_KEY } from '../src/plugins/quotes/store.js';
import type { PluginConfig, Role } from '../src/core/types.js';
import { makeHarness, makeMessage, testLogger } from './helpers.js';

const START = new Date('2026-08-02T18:00:00.000Z');
const COOLDOWN_MS = 30_000;

/** dj1a2n moderates itsjustatank's channel and vice versa. */
const ELEVATION = {
    itsjustatank: ['dj1a2n'],
    dj1a2n: ['itsjustatank'],
};

describe('quotes plugin', () => {
    let dir: string;
    let dataPath: string;
    let clock: Date;
    let roll: number;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-quotes-'));
        dataPath = join(dir, 'quotes.json');
        clock = new Date(START);
        roll = 0;
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(config: PluginConfig = {}) {
        const plugin = createQuotesPlugin(
            () => clock,
            () => roll,
        );
        const harness = makeHarness('quotes', { dataPath, ...config });
        await plugin.init(harness.ctx);
        return { plugin, ...harness };
    }

    /** Send a chat command as the broadcaster of channel 1 (itsjustatank). */
    function broadcasterMessage(text: string) {
        return makeMessage(text, ['everyone', 'broadcaster'], {
            chatterId: '10',
            chatterName: 'itsjustatank',
            chatterDisplayName: 'itsjustatank',
            broadcasterName: 'itsjustatank',
        });
    }

    function viewerMessage(text: string, chatterId = '100', roles: Role[] = ['everyone']) {
        return makeMessage(text, roles, {
            chatterId,
            broadcasterName: 'itsjustatank',
        });
    }

    function advance(ms: number): void {
        clock = new Date(clock.getTime() + ms);
    }

    describe('addquote', () => {
        it('stores a quote with no speaker and reports its id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote just vibing'));
            expect(say).toHaveBeenCalledWith('Added quote #1.', 'msg-1', '1');

            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)).toMatchObject({
                text: 'just vibing',
                speaker: null,
                addedByChatterId: '10',
                addedByDisplayName: 'itsjustatank',
                addedInBroadcasterId: '1',
                addedAt: START.toISOString(),
            });
        });

        it('splits "<text> - <speaker>" on the last separator', async () => {
            const { registry } = await setup();
            await registry.handle(
                broadcasterMessage('!addquote well - actually - it works - Tank'),
            );
            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)).toMatchObject({
                text: 'well - actually - it works',
                speaker: 'Tank',
            });
        });

        it('treats text with no " - " as having no speaker', async () => {
            const { registry } = await setup();
            await registry.handle(broadcasterMessage('!addquote no dash here'));
            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)).toMatchObject({
                text: 'no dash here',
                speaker: null,
            });
        });

        it('accepts a configured cross-channel curator', async () => {
            const { registry, say } = await setup({ treatAsBroadcaster: ELEVATION });
            const message = makeMessage('!addquote dj quote', ['everyone', 'moderator'], {
                chatterId: '20',
                chatterName: 'dj1a2n',
                chatterDisplayName: 'dj1a2n',
                broadcasterName: 'itsjustatank',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Added quote #1.', 'msg-1', '1');
        });

        it('silently ignores a moderator who is not a configured curator', async () => {
            const { registry, say } = await setup({ treatAsBroadcaster: ELEVATION });
            const message = makeMessage('!addquote sneaky', ['everyone', 'moderator'], {
                chatterId: '30',
                chatterName: 'randommod',
                broadcasterName: 'itsjustatank',
            });
            await registry.handle(message);
            expect(say).not.toHaveBeenCalled();
        });

        it('never reaches the handler for a viewer', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!addquote nope'));
            expect(say).not.toHaveBeenCalled();
        });

        it('rejects empty, overlong text, overlong speaker, and chat-command text', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote'));
            expect(say).toHaveBeenLastCalledWith(
                'Usage: addquote <text> [- <speaker>]',
                'msg-1',
                '1',
            );

            await registry.handle(broadcasterMessage(`!addquote ${'x'.repeat(301)}`));
            expect(say).toHaveBeenLastCalledWith(
                `Quotes are limited to ${MAX_QUOTE_TEXT_LENGTH} characters.`,
                'msg-1',
                '1',
            );

            await registry.handle(broadcasterMessage(`!addquote text here - ${'x'.repeat(51)}`));
            expect(say).toHaveBeenLastCalledWith(
                `Speaker names are limited to ${MAX_SPEAKER_LENGTH} characters.`,
                'msg-1',
                '1',
            );

            await registry.handle(broadcasterMessage('!addquote /timeout viewer 600'));
            expect(say).toHaveBeenLastCalledWith(
                'Quotes cannot start with "/" or ".".',
                'msg-1',
                '1',
            );

            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        });

        it('strips control characters from stored text', async () => {
            const { registry } = await setup();
            await registry.handle(broadcasterMessage('!addquote one\u0007two\u0000 three'));
            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)?.text).toBe('one two three');
        });

        it('reports a duplicate instead of storing it twice', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote Repeated Quote - Tank'));
            await registry.handle(broadcasterMessage('!addquote repeated quote - tank'));
            expect(say).toHaveBeenLastCalledWith('That is already quote #1.', 'msg-1', '1');
        });
    });

    describe('quote', () => {
        async function seeded(config: PluginConfig = {}) {
            const harness = await setup(config);
            await harness.registry.handle(broadcasterMessage('!addquote first quote - Tank'));
            await harness.registry.handle(broadcasterMessage('!addquote second quote'));
            harness.say.mockClear();
            return harness;
        }

        it('posts the quote selected by the injected roll, with attribution', async () => {
            const { registry, say } = await seeded();
            roll = 0;
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledWith(
                'Quote #1: "first quote" - Tank (added by itsjustatank)',
                'msg-1',
                '1',
            );
        });

        it('omits the attribution dash when there is no speaker', async () => {
            const { registry, say } = await seeded();
            roll = 0.75;
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledWith(
                'Quote #2: "second quote" (added by itsjustatank)',
                'msg-1',
                '1',
            );
        });

        it('reports an empty pool', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledWith('No quotes yet.', 'msg-1', '1');
        });

        it('fetches a quote by id and reports unknown ids', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!quote 1'));
            expect(say).toHaveBeenLastCalledWith(
                'Quote #1: "first quote" - Tank (added by itsjustatank)',
                'msg-1',
                '1',
            );

            await registry.handle(viewerMessage('!quote 9', '101'));
            expect(say).toHaveBeenLastCalledWith('No quote #9.', 'msg-1', '1');

            await registry.handle(viewerMessage('!quote banana', '102'));
            expect(say).toHaveBeenLastCalledWith('That is not a quote id.', 'msg-1', '1');
        });

        it('throttles a viewer to one quote per cooldown window', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(COOLDOWN_MS - 1);
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(1);
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('throttles each viewer independently', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!quote', '100'));
            await registry.handle(viewerMessage('!quote', '200'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('exempts broadcasters and moderators', async () => {
            const { registry, say } = await seeded();
            await registry.handle(broadcasterMessage('!quote'));
            await registry.handle(broadcasterMessage('!quote'));
            await registry.handle(viewerMessage('!quote', '300', ['everyone', 'moderator']));
            await registry.handle(viewerMessage('!quote', '300', ['everyone', 'moderator']));
            expect(say).toHaveBeenCalledTimes(4);
        });

        it('keeps the quote and quotecount cooldowns separate', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!quote'));
            await registry.handle(viewerMessage('!quotecount'));
            expect(say).toHaveBeenCalledTimes(2);
            expect(say).toHaveBeenLastCalledWith('2 quotes stored.', 'msg-1', '1');
        });
    });

    describe('delquote', () => {
        it('removes by id and refuses to reuse the id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote first quote'));
            await registry.handle(broadcasterMessage('!delquote 1'));
            expect(say).toHaveBeenLastCalledWith('Removed quote #1.', 'msg-1', '1');

            await registry.handle(broadcasterMessage('!delquote 1'));
            expect(say).toHaveBeenLastCalledWith('No quote #1.', 'msg-1', '1');

            await registry.handle(broadcasterMessage('!addquote later quote'));
            expect(say).toHaveBeenLastCalledWith('Added quote #2.', 'msg-1', '1');
        });

        it('rejects a missing or malformed id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!delquote'));
            expect(say).toHaveBeenLastCalledWith('Usage: delquote <id>', 'msg-1', '1');
            await registry.handle(broadcasterMessage('!delquote banana'));
            expect(say).toHaveBeenLastCalledWith('Usage: delquote <id>', 'msg-1', '1');
        });

        it('silently ignores a viewer', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote first quote'));
            say.mockClear();
            await registry.handle(viewerMessage('!delquote 1'));
            expect(say).not.toHaveBeenCalled();
        });
    });

    describe('quotecount', () => {
        it('uses the singular for one quote', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote only quote'));
            await registry.handle(viewerMessage('!quotecount'));
            expect(say).toHaveBeenLastCalledWith('1 quote stored.', 'msg-1', '1');
        });
    });

    describe('config validation', () => {
        async function addAsDjInTankChannel(config: PluginConfig) {
            const { registry, say } = await setup(config);
            await registry.handle(
                makeMessage('!addquote dj quote', ['everyone', 'moderator'], {
                    chatterId: '20',
                    chatterName: 'dj1a2n',
                    chatterDisplayName: 'dj1a2n',
                    broadcasterName: 'itsjustatank',
                }),
            );
            return say;
        }

        const malformedCuratorMaps: ReadonlyArray<[string, unknown]> = [
            ['a bare string instead of a list', { itsjustatank: 'dj1a2n' }],
            ['a non-login channel key', { 'not a login!': ['dj1a2n'] }],
            ['a non-login curator', { itsjustatank: ['not a login!'] }],
            ['a list of non-strings', { itsjustatank: [42] }],
            ['a non-object value', 'itsjustatank'],
        ];

        it.each(malformedCuratorMaps)(
            'denies curation when treatAsBroadcaster has %s',
            async (_label, treatAsBroadcaster) => {
                const say = await addAsDjInTankChannel({ treatAsBroadcaster });
                expect(say).not.toHaveBeenCalled();
            },
        );

        it('trims a padded dataPath instead of writing to a spaced path', async () => {
            const { registry } = await setup({ dataPath: `  ${dataPath}  ` });
            await registry.handle(broadcasterMessage('!addquote padded path quote'));
            const store = new QuoteStore(dataPath, testLogger);
            await store.load();
            expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
        });

        it('falls back to the default cooldown when cooldownSeconds is invalid', async () => {
            const { registry, say } = await setup({ cooldownSeconds: -5 });
            await registry.handle(broadcasterMessage('!addquote a quote'));
            say.mockClear();

            await registry.handle(viewerMessage('!quote'));
            advance(COOLDOWN_MS - 1);
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(1);
            await registry.handle(viewerMessage('!quote'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('falls back to a shared pool when shareAcrossChannels is invalid', async () => {
            const { registry, say } = await setup({ shareAcrossChannels: 'yes' });
            await registry.handle(broadcasterMessage('!addquote shared quote'));
            await registry.handle(
                makeMessage('!quote', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith(
                'Quote #1: "shared quote" (added by itsjustatank)',
                'msg-1',
                '2',
            );
        });
    });

    describe('scoping', () => {
        it('shares the pool across channels by default', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addquote shared quote'));
            await registry.handle(
                makeMessage('!quote', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith(
                'Quote #1: "shared quote" (added by itsjustatank)',
                'msg-1',
                '2',
            );
        });

        it('keeps channels independent when sharing is off', async () => {
            const { registry, say } = await setup({ shareAcrossChannels: false });
            await registry.handle(broadcasterMessage('!addquote channel one quote'));
            await registry.handle(
                makeMessage('!quote', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith('No quotes yet.', 'msg-1', '2');
        });
    });

    it('flushes pending writes on dispose', async () => {
        const { plugin, registry, ctx } = await setup();
        await registry.handle(broadcasterMessage('!addquote durable quote'));
        await plugin.dispose?.(ctx);

        const store = new QuoteStore(dataPath, testLogger);
        await store.load();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
    });
});
