import { DateTime } from 'luxon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoyaltyPlugin } from '../src/plugins/loyalty/index.js';
import { LoyaltyStore, SHARED_SCOPE_KEY } from '../src/plugins/loyalty/store.js';
import type { PluginConfig, Role } from '../src/core/types.js';
import { makeHarness, makeMessage, testLogger } from './helpers.js';

const START = DateTime.utc(2026, 8, 4, 12, 0, 0);

const TARGET_USER = { id: '10', login: 'target', displayName: 'Target' };

describe('loyalty admin commands', () => {
    let dir: string;
    let dataPath: string;
    let clock: DateTime;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-loyalty-admin-'));
        dataPath = join(dir, 'loyalty.json');
        clock = START;
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function setup(config: PluginConfig = {}) {
        const plugin = createLoyaltyPlugin(() => clock);
        const harness = makeHarness(
            'loyalty',
            { dataPath, ...config },
            {
                getUserByLogin: async (login: string) =>
                    login === TARGET_USER.login
                        ? {
                              id: TARGET_USER.id,
                              login: TARGET_USER.login,
                              displayName: TARGET_USER.displayName,
                          }
                        : null,
            },
        );
        await plugin.init(harness.ctx);
        return { plugin, ...harness };
    }

    function commandFrom(text: string, roles: Role[], chatterId = '1') {
        return makeMessage(text, roles, {
            chatterId,
            chatterDisplayName: chatterId === '1' ? 'Broadcaster' : 'Chatter',
            broadcasterId: '1',
            broadcasterName: 'streamer',
        });
    }

    const NON_BROADCASTER_ROLE_SETS: Array<[string, Role[]]> = [
        ['moderator', ['everyone', 'moderator']],
        ['vip', ['everyone', 'vip']],
        ['subscriber', ['everyone', 'subscriber']],
        ['plain viewer', ['everyone']],
    ];

    const ADMIN_COMMANDS = [
        '!setESD @target 100',
        '!giveESD @target 100',
        '!takeESD @target 100',
        '!undosetESD @target',
        '!undogiveESD @target',
        '!undotakeESD @target',
    ];

    describe('lockout', () => {
        it.each(NON_BROADCASTER_ROLE_SETS)(
            'refuses all six admin commands for a %s',
            async (_label, roles) => {
                const { registry, say } = await setup();
                for (const command of ADMIN_COMMANDS) {
                    await registry.handle(commandFrom(command, roles, '99'));
                }
                expect(say).not.toHaveBeenCalled();
            },
        );

        it('allows the broadcaster to run all six admin commands', async () => {
            const { registry, say } = await setup();
            for (const command of ADMIN_COMMANDS) {
                await registry.handle(commandFrom(command, ['everyone', 'broadcaster']));
            }
            expect(say).toHaveBeenCalledTimes(ADMIN_COMMANDS.length);
        });
    });

    describe('case-insensitivity', () => {
        it('dispatches regardless of trigger or @user casing', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!SetESD @Target 50', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenCalledWith("Set Target's esports dollars to 50.", 'msg-1', '1');
        });
    });

    describe('!setESD', () => {
        it('sets the balance exactly and reports it', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 250', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenCalledWith("Set Target's esports dollars to 250.", 'msg-1', '1');

            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            expect(store.getBalance(SHARED_SCOPE_KEY, TARGET_USER.id)).toBe(250);
        });

        it('replies with usage on a malformed amount', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 10+5', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenCalledWith('Usage: !setESD @user <amount>', 'msg-1', '1');
        });

        it('replies with unknown user for an unresolvable login', async () => {
            const { registry, say } = await setup();
            await registry.handle(
                commandFrom('!setESD @nosuchuser 10', ['everyone', 'broadcaster']),
            );
            expect(say).toHaveBeenCalledWith(
                'Could not find a Twitch user named nosuchuser.',
                'msg-1',
                '1',
            );
        });
    });

    describe('!giveESD', () => {
        it('adds to the balance', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 100', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!giveESD @target 50', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Gave 50 esports dollars to Target. New balance: 150.',
                'msg-1',
                '1',
            );
        });

        it('clamps at MAX_BALANCE and reports the clamp', async () => {
            const { registry, say } = await setup();
            await registry.handle(
                commandFrom('!setESD @target 999999999', ['everyone', 'broadcaster']),
            );
            await registry.handle(commandFrom('!giveESD @target 100', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Gave 1 esports dollars to Target (clamped). New balance: 1000000000.',
                'msg-1',
                '1',
            );
        });
    });

    describe('!takeESD', () => {
        it('subtracts from the balance', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 100', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!takeESD @target 30', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Took 30 esports dollars from Target. New balance: 70.',
                'msg-1',
                '1',
            );
        });

        it('taking more than the balance removes exactly the balance, clamped at 0', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 30', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!takeESD @target 50', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Took 30 esports dollars from Target (clamped). New balance: 0.',
                'msg-1',
                '1',
            );

            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            expect(store.getBalance(SHARED_SCOPE_KEY, TARGET_USER.id)).toBe(0);
        });
    });

    describe('argument parsing - digits only', () => {
        const badAmounts = [
            '10+5',
            '1e3',
            '0x10',
            '1.0',
            '+5',
            '',
            'Infinity',
            '5abc',
            'one',
            '-3',
        ];

        it.each(badAmounts)('rejects %s and leaves the balance unchanged', async (token) => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 100', ['everyone', 'broadcaster']));
            await registry.handle(
                commandFrom(`!giveESD @target ${token}`, ['everyone', 'broadcaster']),
            );
            expect(say).toHaveBeenLastCalledWith('Usage: !giveESD @user <amount>', 'msg-1', '1');

            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            expect(store.getBalance(SHARED_SCOPE_KEY, TARGET_USER.id)).toBe(100);
        });
    });

    describe('undo', () => {
        it('!undogiveESD after a give-then-take leaves the take standing', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 200', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!giveESD @target 50', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!takeESD @target 30', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!undogiveESD @target', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Undid the last !giveESD for Target. New balance: 170 esports dollars.',
                'msg-1',
                '1',
            );

            const store = new LoyaltyStore(dataPath, testLogger);
            await store.load();
            expect(store.getBalance(SHARED_SCOPE_KEY, TARGET_USER.id)).toBe(170);
        });

        it('marks the decision undone so a second undo of the same kind reports nothing to undo', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!setESD @target 100', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!undosetESD @target', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!undosetESD @target', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Nothing to undo: no applied !setESD found for Target.',
                'msg-1',
                '1',
            );
        });

        it('undoing one kind does not consume the undo availability of another kind', async () => {
            const { registry, say } = await setup();
            await registry.handle(commandFrom('!giveESD @target 50', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!takeESD @target 20', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!undotakeESD @target', ['everyone', 'broadcaster']));
            await registry.handle(commandFrom('!undogiveESD @target', ['everyone', 'broadcaster']));
            expect(say).toHaveBeenLastCalledWith(
                'Undid the last !giveESD for Target. New balance: 0 esports dollars.',
                'msg-1',
                '1',
            );
        });
    });
});
