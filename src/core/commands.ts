import { isAllowed } from './permissions.js';
import type {
  BotContext,
  ChatCommandEvent,
  ChatMessageEvent,
  CommandDefinition,
  Logger,
} from './types.js';

interface RegisteredCommand extends CommandDefinition {
  /** Owning plugin name (for diagnostics). */
  pluginName: string;
  /** The context to pass to the handler (bound to the owning plugin). */
  ctx: BotContext;
}

/**
 * Holds all registered chat commands and dispatches incoming messages to them,
 * applying the command prefix match and the per-command permission gate.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, RegisteredCommand>();

  constructor(
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {}

  /** Register a command. Throws on a duplicate trigger. */
  register(pluginName: string, def: CommandDefinition, ctx: BotContext): void {
    const trigger = def.trigger.toLowerCase();
    const existing = this.commands.get(trigger);
    if (existing) {
      throw new Error(
        `command "${trigger}" already registered by plugin "${existing.pluginName}" ` +
          `(attempted by "${pluginName}")`,
      );
    }
    this.commands.set(trigger, { ...def, trigger, pluginName, ctx });
    this.logger.debug({ trigger, plugin: pluginName, allow: def.allow }, 'command registered');
  }

  /**
   * Parse a chat message into a matched command + args, or null if it isn't a
   * command for us. Pure — no side effects — so it's easy to unit-test.
   */
  match(
    message: ChatMessageEvent,
  ): { command: RegisteredCommand; event: ChatCommandEvent } | null {
    const text = message.text.trimStart();
    if (!text.startsWith(this.prefix)) return null;

    const body = text.slice(this.prefix.length);
    const rawTrigger = body.split(/\s+/, 1)[0];
    if (!rawTrigger) return null;

    const command = this.commands.get(rawTrigger.toLowerCase());
    if (!command) return null;

    const argString = body.slice(rawTrigger.length).trim();
    const args = argString.length ? argString.split(/\s+/) : [];
    return { command, event: { ...message, command: command.trigger, args, argString } };
  }

  /**
   * Match and, if permitted, invoke the command. Returns true if a command was
   * matched (whether or not permission allowed it), false if the message was
   * not a command.
   */
  async handle(message: ChatMessageEvent): Promise<boolean> {
    const matched = this.match(message);
    if (!matched) return false;

    const { command, event } = matched;
    if (!isAllowed(event.roles, command.allow)) {
      this.logger.debug(
        { trigger: command.trigger, chatter: event.chatterName },
        'command denied by permissions',
      );
      return true;
    }

    try {
      await command.handler(event, command.ctx);
    } catch (err) {
      this.logger.error(
        { err, trigger: command.trigger, plugin: command.pluginName },
        'command handler threw',
      );
    }
    return true;
  }

  /** Number of registered commands (used in tests/introspection). */
  get size(): number {
    return this.commands.size;
  }
}
