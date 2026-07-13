import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PluginManager } from '../src/core/pluginManager.js';
import { CommandRegistry } from '../src/core/commands.js';
import { EventBus } from '../src/core/eventBus.js';
import type { FileConfig } from '../src/core/config.js';
import { makeMessage, makeSpyLogger, spySender } from './helpers.js';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pluginManager');

function baseFileConfig(overrides: Partial<FileConfig['plugins']>): FileConfig {
  return {
    broadcaster: { login: 'streamer' },
    bot: { login: 'bot' },
    chat: { commandPrefix: '!' },
    plugins: {
      directories: [],
      enabled: [],
      config: {},
      ...overrides,
    },
  };
}

function setup(overrides: Partial<FileConfig['plugins']>) {
  const registry = new CommandRegistry('!', makeSpyLogger().logger);
  const bus = new EventBus(makeSpyLogger().logger);
  const spy = makeSpyLogger();
  const pm = new PluginManager({
    file: baseFileConfig(overrides),
    logger: spy.logger,
    registry,
    bus,
    sender: spySender(),
  });
  return { pm, registry, spy };
}

describe('PluginManager', () => {
  it('skips a plugin whose init() throws and still initializes the other plugins', async () => {
    const dir = join(fixturesRoot, 'plugins');
    const { pm, spy } = setup({
      directories: [dir],
      enabled: ['fixture-good-a', 'fixture-throws-init'],
    });
    await pm.loadAll();

    expect(pm.active).toContain('fixture-good-a');
    expect(pm.active).not.toContain('fixture-throws-init');
    expect(spy.error).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: 'fixture-throws-init' }),
      'plugin init threw, skipping',
    );
  });

  it('skips a module that does not export a valid Plugin', async () => {
    const dir = join(fixturesRoot, 'plugins');
    const { pm, spy } = setup({
      directories: [dir],
      enabled: ['fixture-good-a', 'fixture-invalid-export'],
    });
    await pm.loadAll();

    expect(pm.active).toEqual(['fixture-good-a']);
    expect(spy.error).toHaveBeenCalledWith(
      expect.objectContaining({
        entryPath: expect.stringContaining('invalid-export'),
      }),
      'failed to import plugin, skipping',
    );
  });

  it('skips the second of two plugins sharing the same name and warns', async () => {
    const { pm, spy } = setup({
      directories: [join(fixturesRoot, 'dup-a'), join(fixturesRoot, 'dup-b')],
      enabled: ['fixture-dup'],
    });
    await pm.loadAll();

    expect(pm.active).toEqual(['fixture-dup']);
    expect(spy.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        plugin: 'fixture-dup',
        entryPath: expect.stringContaining('dup-b'),
      }),
      'duplicate plugin name, skipping',
    );
  });

  it('discovers but does not initialize a plugin absent from plugins.enabled', async () => {
    const dir = join(fixturesRoot, 'plugins');
    const { pm, registry } = setup({
      directories: [dir],
      enabled: ['fixture-good-a'],
    });
    await pm.loadAll();

    expect(pm.active).toEqual(['fixture-good-a']);
    expect(registry.match(makeMessage('!fixture-b'))).toBeNull();
  });

  it('warns when an enabled plugin name matches nothing discovered', async () => {
    const dir = join(fixturesRoot, 'plugins');
    const { pm, spy } = setup({
      directories: [dir],
      enabled: ['fixture-good-a', 'totally-unknown'],
    });
    await pm.loadAll();

    expect(pm.active).toEqual(['fixture-good-a']);
    expect(spy.warn).toHaveBeenCalledWith(
      { plugin: 'totally-unknown' },
      'enabled plugin was not found in any plugin directory',
    );
  });

  it('handles a missing plugin directory without throwing', async () => {
    const { pm } = setup({
      directories: [join(fixturesRoot, 'does-not-exist')],
      enabled: ['fixture-good-a'],
    });
    await expect(pm.loadAll()).resolves.toBeUndefined();
    expect(pm.active).toEqual([]);
  });
});
