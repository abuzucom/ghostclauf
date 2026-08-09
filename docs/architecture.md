# Architecture

ghostclauf is a plugin-based Twitch chat bot. The core owns Twitch-specific
work. Plugins receive a narrow, transport-agnostic `BotContext`.

## Startup

`src/index.ts` starts the bot in this order:

1. Load `config.yaml` and environment secrets.
2. Load and validate bot and broadcaster OAuth token stores.
3. Create the command registry, event bus, and metrics registry.
4. Discover and initialize enabled plugins.
5. Create and start the EventSub and Helix transport.
6. Start the loopback health server.

Plugins initialize before the transport. Their `ctx.say` and `ctx.helix`
references are late-bound, so registration can complete before Twitch clients
exist. Plugins must not invoke those references from `init`.

## Event Flow

`src/core/twitch.ts` is the only module that imports `@twurple/*`. It converts
Twitch events into the types in `src/core/types.ts`, then calls the handlers
provided by `src/index.ts`.

`src/index.ts` forwards normalized stream and event notifications to `EventBus`.
Chat messages go to both `EventBus` and `CommandRegistry`. The registry parses
the configured prefix, checks the command's allowed roles, and isolates handler
errors. EventBus similarly isolates plugin handler errors.

Offline events are provisional. The transport waits, confirms the state through
Helix, retries one failed confirmation, then emits a verified or unverified
offline event. Stateful plugins must not penalize viewers after an unverified
offline event.

## Plugin Model

`PluginManager` scans configured directories for standalone `.js` or `.mjs`
modules and directories containing `index.js`. If `plugins.enabled` is set, it
is an allow-list. Otherwise every discovered plugin runs except names in
`plugins.disabled`.

Each plugin receives a plugin-scoped logger and configuration block. A plugin
that fails to import, validate, or initialize is logged and skipped. It cannot
stop the remaining plugins or the transport.

Plugins may use only `BotContext`:

- `ctx.command(...)` registers a command.
- `ctx.on(...)` subscribes to normalized events.
- `ctx.say(...)` posts a message.
- `ctx.helix` performs the small supported set of Twitch lookups.
- `ctx.drain()` waits for event handlers before persistent state is flushed.

## Persistence

Plugin stores own their data under `data/`. `AtomicJsonFile` writes a temporary
file, then renames it over the target. It keeps one `.bak` snapshot and applies
owner-only permissions. The writer retries transient Windows rename contention.

Stateful plugins serialize writes through their own promise chains. Journals
record administrative decisions alongside state changes so interrupted work can
be reconciled on startup. Do not change persisted fields or journal ordering
without a compatible reader and migration.

## Shutdown

On `SIGINT` or `SIGTERM`, the bot disposes plugins in reverse initialization
order, stops the transport, and closes the health server. Plugin disposal calls
`ctx.drain()` before flushing stores. This prevents asynchronous event handlers
from writing after the final flush.

## Operational Signals

`GET /healthz` reports whether the HTTP server is listening. `GET /readyz`
also requires a started transport with no revoked broadcaster subscription.
The readiness response includes in-process counters. Token-refresh failures and
EventSub revocations emit structured alerts for external log pipelines.
