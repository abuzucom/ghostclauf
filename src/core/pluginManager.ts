import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext } from './context.js';
import type { CommandRegistry } from './commands.js';
import type { EventBus } from './eventBus.js';
import type { FileConfig } from './config.js';
import type { Logger, MessageSender, Plugin } from './types.js';

export interface PluginManagerDeps {
  file: FileConfig;
  logger: Logger;
  registry: CommandRegistry;
  bus: EventBus;
  sender: MessageSender;
}

/**
 * Discovers plugins across the configured directories, dynamically imports them,
 * validates the `Plugin` contract, and initializes the ones listed in
 * `plugins.enabled`. Discovery and load are isolated per-plugin: a broken plugin
 * is logged and skipped, never crashing the bot.
 *
 * A "plugin" is either a directory containing an `index.js`, or a standalone
 * `.js`/`.mjs` file, inside one of the configured directories.
 */
export class PluginManager {
  private readonly loaded = new Map<string, Plugin>();

  constructor(private readonly deps: PluginManagerDeps) {}

  /** The names of plugins that were successfully initialized. */
  get active(): string[] {
    return [...this.loaded.keys()];
  }

  async loadAll(): Promise<void> {
    const { file, logger } = this.deps;
    const enabled = new Set(file.plugins.enabled);

    for (const dir of file.plugins.directories) {
      const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
      const entries = await this.discover(abs);
      for (const entryPath of entries) {
        await this.loadOne(entryPath, enabled);
      }
    }

    // Warn about anything enabled but never found.
    for (const name of enabled) {
      if (!this.loaded.has(name)) {
        logger.warn({ plugin: name }, 'enabled plugin was not found in any plugin directory');
      }
    }

    logger.info({ plugins: this.active }, `initialized ${this.loaded.size} plugin(s)`);
  }

  /** Return candidate module paths inside a directory (non-recursive). */
  private async discover(dir: string): Promise<string[]> {
    const { logger } = this.deps;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      logger.debug({ dir }, 'plugin directory not present, skipping');
      return [];
    }

    const candidates: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        const index = join(full, 'index.js');
        if (await this.exists(index)) candidates.push(index);
      } else if (/\.(mjs|js)$/.test(entry) && !/\.d\.js$/.test(entry)) {
        candidates.push(full);
      }
    }
    return candidates;
  }

  private async loadOne(entryPath: string, enabled: ReadonlySet<string>): Promise<void> {
    const { logger, file, bus, registry, sender } = this.deps;
    let plugin: Plugin;
    try {
      const mod = (await import(pathToFileURL(entryPath).href)) as {
        default?: unknown;
      } & Record<string, unknown>;
      const candidate = (mod.default ?? mod) as unknown;
      plugin = assertPlugin(candidate, entryPath);
    } catch (err) {
      logger.error({ err, entryPath }, 'failed to import plugin, skipping');
      return;
    }

    if (!enabled.has(plugin.name)) {
      logger.debug({ plugin: plugin.name, entryPath }, 'plugin discovered but not enabled');
      return;
    }
    if (this.loaded.has(plugin.name)) {
      logger.warn({ plugin: plugin.name, entryPath }, 'duplicate plugin name, skipping');
      return;
    }

    const pluginConfig = file.plugins.config[plugin.name] ?? {};
    const ctx = createContext({
      pluginName: plugin.name,
      config: pluginConfig,
      logger: logger.child({ plugin: plugin.name }),
      bus,
      registry,
      sender,
    });

    try {
      await plugin.init(ctx);
      this.loaded.set(plugin.name, plugin);
      logger.info({ plugin: plugin.name, version: plugin.version }, 'plugin initialized');
    } catch (err) {
      logger.error({ err, plugin: plugin.name }, 'plugin init threw, skipping');
    }
  }

  private async exists(path: string): Promise<boolean> {
    return (await stat(path).catch(() => null)) !== null;
  }
}

function assertPlugin(value: unknown, source: string): Plugin {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Plugin).name === 'string' &&
    typeof (value as Plugin).version === 'string' &&
    typeof (value as Plugin).init === 'function'
  ) {
    return value as Plugin;
  }
  throw new Error(
    `module "${source}" does not export a valid Plugin (need { name, version, init })`,
  );
}
