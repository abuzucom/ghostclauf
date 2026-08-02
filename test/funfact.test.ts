import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFunFactPlugin } from '../src/plugins/funfact/index.js';
import { MAX_FACT_LENGTH } from '../src/plugins/funfact/fact.js';
import { FunFactStore, SHARED_SCOPE_KEY } from '../src/plugins/funfact/store.js';
import type { PluginConfig, Role } from '../src/core/types.js';
import { makeHarness, makeMessage, testLogger } from './helpers.js';

const START = new Date('2026-08-02T18:00:00.000Z');
const COOLDOWN_MS = 30_000;

/** dj1a2n moderates itsjustatank's channel and vice versa. */
const ELEVATION = {
    itsjustatank: ['dj1a2n'],
    dj1a2n: ['itsjustatank'],
};

describe('funfact plugin', () => {
    let dir: string;
    let dataPath: string;
    let clock: Date;
    let roll: number;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-funfact-'));
        dataPath = join(dir, 'funfacts.json');
        clock = new Date(START);
        roll = 0;
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(config: PluginConfig = {}) {
        const plugin = createFunFactPlugin(
            () => clock,
            () => roll,
        );
        const harness = makeHarness('funfact', { dataPath, ...config });
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

    describe('addfunfact', () => {
        it('stores a fact for the broadcaster and reports its id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact tank solders live'));
            expect(say).toHaveBeenCalledWith('Added fun fact #1.', 'msg-1', '1');

            const store = new FunFactStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)).toMatchObject({
                text: 'tank solders live',
                addedByChatterId: '10',
                addedByDisplayName: 'itsjustatank',
                addedInBroadcasterId: '1',
                addedAt: START.toISOString(),
            });
        });

        it('accepts a configured cross-channel curator', async () => {
            const { registry, say } = await setup({ treatAsBroadcaster: ELEVATION });
            const message = makeMessage('!addfunfact dj fact', ['everyone', 'moderator'], {
                chatterId: '20',
                chatterName: 'dj1a2n',
                chatterDisplayName: 'dj1a2n',
                broadcasterName: 'itsjustatank',
            });
            await registry.handle(message);
            expect(say).toHaveBeenCalledWith('Added fun fact #1.', 'msg-1', '1');
        });

        it('silently ignores a moderator who is not a configured curator', async () => {
            const { registry, say } = await setup({ treatAsBroadcaster: ELEVATION });
            const message = makeMessage('!addfunfact sneaky', ['everyone', 'moderator'], {
                chatterId: '30',
                chatterName: 'randommod',
                broadcasterName: 'itsjustatank',
            });
            await registry.handle(message);
            expect(say).not.toHaveBeenCalled();
        });

        it('never reaches the handler for a viewer', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!addfunfact nope'));
            expect(say).not.toHaveBeenCalled();
        });

        it('rejects empty, overlong, and chat-command text', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact'));
            expect(say).toHaveBeenLastCalledWith('Usage: addfunfact <text>', 'msg-1', '1');

            await registry.handle(broadcasterMessage(`!addfunfact ${'x'.repeat(301)}`));
            expect(say).toHaveBeenLastCalledWith(
                `Fun facts are limited to ${MAX_FACT_LENGTH} characters.`,
                'msg-1',
                '1',
            );

            await registry.handle(broadcasterMessage('!addfunfact /timeout viewer 600'));
            expect(say).toHaveBeenLastCalledWith(
                'Fun facts cannot start with "/" or ".".',
                'msg-1',
                '1',
            );

            const store = new FunFactStore(dataPath, testLogger);
            await store.load();
            expect(store.count(SHARED_SCOPE_KEY)).toBe(0);
        });

        it('strips control characters from stored text', async () => {
            const { registry } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact one\u0007two\u0000 three'));
            const store = new FunFactStore(dataPath, testLogger);
            await store.load();
            expect(store.get(SHARED_SCOPE_KEY, 1)?.text).toBe('one two three');
        });

        it('reports a duplicate instead of storing it twice', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact Repeated Fact'));
            await registry.handle(broadcasterMessage('!addfunfact repeated fact'));
            expect(say).toHaveBeenLastCalledWith('That is already fun fact #1.', 'msg-1', '1');
        });
    });

    describe('funfact', () => {
        async function seeded(config: PluginConfig = {}) {
            const harness = await setup(config);
            await harness.registry.handle(broadcasterMessage('!addfunfact first fact'));
            await harness.registry.handle(broadcasterMessage('!addfunfact second fact'));
            harness.say.mockClear();
            return harness;
        }

        it('posts the fact selected by the injected roll', async () => {
            const { registry, say } = await seeded();
            roll = 0.75;
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledWith(
                'Fun fact #2: second fact (added by itsjustatank)',
                'msg-1',
                '1',
            );
        });

        it('reports an empty pool', async () => {
            const { registry, say } = await setup();
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledWith('No fun facts yet.', 'msg-1', '1');
        });

        it('fetches a fact by id and reports unknown ids', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!funfact 1'));
            expect(say).toHaveBeenLastCalledWith(
                'Fun fact #1: first fact (added by itsjustatank)',
                'msg-1',
                '1',
            );

            await registry.handle(viewerMessage('!funfact 9', '101'));
            expect(say).toHaveBeenLastCalledWith('No fun fact #9.', 'msg-1', '1');

            await registry.handle(viewerMessage('!funfact banana', '102'));
            expect(say).toHaveBeenLastCalledWith('That is not a fun fact id.', 'msg-1', '1');
        });

        it('throttles a viewer to one fact per cooldown window', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(COOLDOWN_MS - 1);
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(1);
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('throttles each viewer independently', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!funfact', '100'));
            await registry.handle(viewerMessage('!funfact', '200'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('exempts broadcasters and moderators', async () => {
            const { registry, say } = await seeded();
            await registry.handle(broadcasterMessage('!funfact'));
            await registry.handle(broadcasterMessage('!funfact'));
            await registry.handle(viewerMessage('!funfact', '300', ['everyone', 'moderator']));
            await registry.handle(viewerMessage('!funfact', '300', ['everyone', 'moderator']));
            expect(say).toHaveBeenCalledTimes(4);
        });

        it('keeps the funfact and funfactcount cooldowns separate', async () => {
            const { registry, say } = await seeded();
            await registry.handle(viewerMessage('!funfact'));
            await registry.handle(viewerMessage('!funfactcount'));
            expect(say).toHaveBeenCalledTimes(2);
            expect(say).toHaveBeenLastCalledWith('2 fun facts stored.', 'msg-1', '1');
        });
    });

    describe('delfunfact', () => {
        it('removes by id and refuses to reuse the id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact first fact'));
            await registry.handle(broadcasterMessage('!delfunfact 1'));
            expect(say).toHaveBeenLastCalledWith('Removed fun fact #1.', 'msg-1', '1');

            await registry.handle(broadcasterMessage('!delfunfact 1'));
            expect(say).toHaveBeenLastCalledWith('No fun fact #1.', 'msg-1', '1');

            await registry.handle(broadcasterMessage('!addfunfact later fact'));
            expect(say).toHaveBeenLastCalledWith('Added fun fact #2.', 'msg-1', '1');
        });

        it('rejects a missing or malformed id', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!delfunfact'));
            expect(say).toHaveBeenLastCalledWith('Usage: delfunfact <id>', 'msg-1', '1');
            await registry.handle(broadcasterMessage('!delfunfact banana'));
            expect(say).toHaveBeenLastCalledWith('Usage: delfunfact <id>', 'msg-1', '1');
        });

        it('silently ignores a viewer', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact first fact'));
            say.mockClear();
            await registry.handle(viewerMessage('!delfunfact 1'));
            expect(say).not.toHaveBeenCalled();
        });
    });

    describe('funfactcount', () => {
        it('uses the singular for one fact', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact only fact'));
            await registry.handle(viewerMessage('!funfactcount'));
            expect(say).toHaveBeenLastCalledWith('1 fun fact stored.', 'msg-1', '1');
        });
    });

    describe('config validation', () => {
        async function addAsDjInTankChannel(config: PluginConfig) {
            const { registry, say } = await setup(config);
            await registry.handle(
                makeMessage('!addfunfact dj fact', ['everyone', 'moderator'], {
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
            await registry.handle(broadcasterMessage('!addfunfact padded path fact'));
            const store = new FunFactStore(dataPath, testLogger);
            await store.load();
            expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
        });

        it('falls back to the default cooldown when cooldownSeconds is invalid', async () => {
            const { registry, say } = await setup({ cooldownSeconds: -5 });
            await registry.handle(broadcasterMessage('!addfunfact a fact'));
            say.mockClear();

            await registry.handle(viewerMessage('!funfact'));
            advance(COOLDOWN_MS - 1);
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledTimes(1);

            advance(1);
            await registry.handle(viewerMessage('!funfact'));
            expect(say).toHaveBeenCalledTimes(2);
        });

        it('falls back to a shared pool when shareAcrossChannels is invalid', async () => {
            const { registry, say } = await setup({ shareAcrossChannels: 'yes' });
            await registry.handle(broadcasterMessage('!addfunfact shared fact'));
            await registry.handle(
                makeMessage('!funfact', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith(
                'Fun fact #1: shared fact (added by itsjustatank)',
                'msg-1',
                '2',
            );
        });
    });

    describe('scoping', () => {
        it('shares the pool across channels by default', async () => {
            const { registry, say } = await setup();
            await registry.handle(broadcasterMessage('!addfunfact shared fact'));
            await registry.handle(
                makeMessage('!funfact', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith(
                'Fun fact #1: shared fact (added by itsjustatank)',
                'msg-1',
                '2',
            );
        });

        it('keeps channels independent when sharing is off', async () => {
            const { registry, say } = await setup({ shareAcrossChannels: false });
            await registry.handle(broadcasterMessage('!addfunfact channel one fact'));
            await registry.handle(
                makeMessage('!funfact', ['everyone'], {
                    broadcasterId: '2',
                    broadcasterName: 'dj1a2n',
                }),
            );
            expect(say).toHaveBeenLastCalledWith('No fun facts yet.', 'msg-1', '2');
        });
    });

    it('flushes pending writes on dispose', async () => {
        const { plugin, registry, ctx } = await setup();
        await registry.handle(broadcasterMessage('!addfunfact durable fact'));
        await plugin.dispose?.(ctx);

        const store = new FunFactStore(dataPath, testLogger);
        await store.load();
        expect(store.count(SHARED_SCOPE_KEY)).toBe(1);
    });
});
