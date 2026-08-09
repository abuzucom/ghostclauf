# Plugin Authoring

Plugins extend ghostclauf without importing Twitch libraries. Start from
`src/plugins/ping` or `src/plugins/wentlive` for a small example.

## Module Contract

Export a default `Plugin` from `src/plugins/<name>/index.ts`. The build emits
the `index.js` that the plugin manager discovers.

```ts
import type { Plugin } from '../../core/types.js';

const plugin: Plugin = {
    name: 'hello',
    version: '1.0.0',
    init(ctx) {
        ctx.command({
            trigger: 'hello',
            allow: ['everyone'],
            description: 'Reply with a greeting.',
            handler: (event, commandContext) =>
                commandContext.say(`Hello, @${event.chatterDisplayName}!`, event.messageId),
        });
    },
};

export default plugin;
```

Keep plugin names unique. The manager skips duplicate names and logs the source
module that lost the conflict.

## Commands And Events

Command triggers do not include the configured prefix. Define `allow` precisely.
Use `everyone` only when every chatter may run the command. A command handler
receives parsed `args`, an `argString`, resolved roles, and the current channel.

Subscribe through `ctx.on` for normalized events such as `streamOnline`,
`streamOffline`, `raid`, `subscribe`, and `cheer`. Treat `streamOffline` with
`verified: false` as uncertain. Do not discard user state or apply penalties.

## Configuration

Plugin configuration is the `plugins.config.<name>` object. Treat every value
as untrusted configuration. Validate type and range, log a safe warning, and
fall back to a documented default. Reuse `resolveConfigField` when its behavior
fits the plugin.

## Persistence And Cleanup

Store data only in the configured `data/` path. Bound collection sizes and
validate data on load. Use an atomic writer for persisted JSON. When a plugin
starts timers, listeners, or queued writes, implement `dispose`:

1. Stop future work such as timers.
2. Await `ctx.drain()`.
3. Flush persistent state.

This order prevents an event handler from writing after shutdown flushes.

## Testing

Keep formatting, parsing, and state transitions in named pure functions where
possible. Export a factory with injected time or randomness when tests need
deterministic behavior. Test command permissions, bad configuration, malformed
stored data, expected recovery, and disposal behavior.

## Boundaries

Never import `@twurple/*` from a plugin. Do not access token stores or raw
transport clients. Use only `BotContext`; expand it only through a compatible
core change with tests and documentation.
