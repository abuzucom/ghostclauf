# ghostclauf

A lightweight, highly extensible chat bot. Its first deployment target is
**Twitch chat**, but the extensibility layer is transport-agnostic — behaviours
are added as drop-in **plugins**, not hard-coded against Twitch.

The design borrows the *spirit* of [eggdrop](https://github.com/eggheads/eggdrop)
(event bindings + modules) and [ub3r-b0t](https://github.com/moiph/ub3r-b0t)
(clean multi-command structure), but is written fresh — no fork, no vendored code.

## Features (v1)

- **`!ping` → `pong!`** — replies `pong!` when the **broadcaster, a moderator, a
  VIP, or a subscriber** types `!ping`. Non-privileged viewers are ignored.
- **Going-live announcement** — when the stream goes live, posts
  `<streamer> has gone live at <UTC timestamp>` (template configurable).
- **Attendance / watch streaks** — viewers `!checkin` while live to build a
  streak of consecutive stream days attended (see below).

The first two are shipped as plugins (`src/plugins/ping`, `src/plugins/wentlive`)
and are the reference examples for writing your own; `src/plugins/streak` is the
larger worked example.

## Attendance / watch streaks (`streak` plugin)

Tracks regular viewers with a chat check-in. A streak counts **consecutive
stream days** a viewer checked in: only calendar days on which the stream was
live count, so off-days are skipped rather than breaking a streak; missing a
check-in on a day the stream *was* live resets the streak to 1.

A day is marked "live" by the `stream.online` event. If the bot starts *after*
the stream already went live (so it missed that event), a broadcaster or
moderator can run `!streakopen` to open check-in for the day. Set
`requireStreamDay: false` to instead count any day a viewer checks in.

Commands (trigger words configurable):

| Command | Who | Effect |
| ------- | --- | ------ |
| `!checkin` | everyone | Record attendance for today and extend the streak. |
| `!streak` | everyone | Show your streak; `!streak @user` looks up another viewer. |
| `!streakreset @user` | broadcaster / mod | Reset a viewer's streak to 0. |
| `!streakset @user <n>` | broadcaster / mod | Set a viewer's streak to a value. |
| `!streakopen` | broadcaster / mod | Mark today a stream day if `stream.online` was missed. |

State persists to `dataPath` (default `./data/streaks.json`). Day boundaries use
the configured `timezone` (IANA name, default `UTC`). A channel-point redeem is
planned; when added it will reuse the same check-in path. See
[`config.example.yaml`](config.example.yaml) for all options.

## How it talks to Twitch

Twitch now recommends **[EventSub](https://dev.twitch.tv/docs/eventsub/) for
reading chat + the [Helix Send Chat Message API](https://dev.twitch.tv/docs/chat/send-receive-messages/)
for writing**, replacing legacy IRC. ghostclauf opens a **single EventSub
WebSocket** that carries *both* required events:

| Requirement            | EventSub subscription   |
| ---------------------- | ----------------------- |
| `!ping` command        | `channel.chat.message`  |
| Going-live announcement| `stream.online`         |

All Twitch specifics live in [`src/core/twitch.ts`](src/core/twitch.ts) (built on
[@twurple](https://twurple.js.org)); everything else is platform-neutral.

## Architecture

```
src/
  index.ts              entrypoint: config -> auth -> plugins -> transport
  core/
    types.ts            the plugin contract (Plugin, BotContext, Role, events)
    config.ts           load + validate config.yaml and env secrets (zod)
    logger.ts           pino structured logging
    permissions.ts      badges -> roles; allow-list check (pure, unit-tested)
    eventBus.ts         typed event bus (errors isolated per handler)
    commands.ts         command registry: prefix match + permission gate
    context.ts          builds the BotContext handed to each plugin
    pluginManager.ts    discover / import / validate / init plugins
    auth.ts             RefreshingAuthProvider + token persistence
    twitch.ts           EventSub WS + Helix sender (the only twurple code)
  plugins/
    ping/               !ping -> pong!
    wentlive/           stream.online -> announcement
  tools/
    authFlow.ts         one-time OAuth to mint the bot's initial token
```

**Plugins never import twurple.** They receive a `BotContext` and use only:
`ctx.command({...})`, `ctx.on(event, handler)`, `ctx.say(text, replyToId?, broadcasterId?)`,
`ctx.config`, and `ctx.logger`.

## Prerequisites

1. A **Twitch application** — register at
   <https://dev.twitch.tv/console/apps>. Note the **Client ID** and
   **Client Secret**, and add `http://localhost:3000/callback` as a redirect URI.
2. Two **broadcaster accounts** whose channels the bot will monitor.
3. A **bot account** (a separate Twitch account the bot posts as).
4. In each broadcaster's channel, make the bot a **moderator**, *or* have the
   broadcaster grant the `channel:bot` scope — either lets the bot post.

The bot account authorizes these scopes: `user:read:chat`, `user:write:chat`,
`user:bot`. Each broadcaster also authorizes a user token for its EventSub
WebSocket. (`stream.online` needs no extra scope.)

## Setup

```bash
cp .env.example .env            # fill in TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET
cp config.example.yaml config.yaml   # set both broadcasters and bot.login
npm install
npm run build
npm run auth -- --bot
npm run auth -- --broadcaster first_streamer_login
npm run auth -- --broadcaster second_streamer_login
```

### Windows one-click setup

1. Double-click `setup.bat` in the project folder.
2. Edit `.env` with your Twitch application's Client ID and Client Secret
   (register one at <https://dev.twitch.tv/console/apps>).
3. Double-click `run.bat` to start the bot.

`setup.bat` does not overwrite an existing `.env` or `config.yaml`, and does
not ask for account logins or touch OAuth — that all happens in `run.bat` the
first time it runs:

- If `config.yaml` still has the `config.example.yaml` placeholder logins,
  `run.bat` prompts for the real bot and broadcaster Twitch logins and saves
  them into `config.yaml` (comments and formatting preserved).
- It then checks which of those accounts still need authorization - including
  the bot token existing but missing a required scope (e.g. `user:write:chat`)
  - and opens the OAuth flow for each one automatically.
- No manual `npm run auth` commands. Once every account is configured and
  authorized, later runs skip straight to starting the bot, and it keeps its
  window open if the bot stops.

Every run of `run.bat` also rebuilds (`npm run build`) before starting, so
`git pull`-ing an update and double-clicking `run.bat` is enough - you never
need to manually rebuild before it picks up new code.

**Authorize accounts.** Log into Twitch as the account being authorized, then run
the matching command:

```bash
npm run auth -- --bot
npm run auth -- --broadcaster first_streamer_login
npm run auth -- --broadcaster second_streamer_login
```

Open the printed URL, approve, and the token (access + refresh) is written to
the configured token store. The bot token uses `TOKEN_STORE_PATH`; each
broadcaster token uses its `tokenStorePath` in `config.yaml`. Thereafter tokens
refresh automatically.

## Run

**Locally:**

```bash
npm start                       # or: npm run dev  (watch mode)
# pretty logs: npm start | npx pino-pretty
```

**Docker:**

```bash
# 1) authorize the bot and both broadcasters (each command is one time)
docker compose run --rm --service-ports ghostclauf node dist/tools/authFlow.js --bot
docker compose run --rm --service-ports ghostclauf node dist/tools/authFlow.js --broadcaster first_streamer_login
docker compose run --rm --service-ports ghostclauf node dist/tools/authFlow.js --broadcaster second_streamer_login
# 2) run
docker compose up -d
```

## Configuration

Secrets live in `.env`; everything else in `config.yaml`. See
[`config.example.yaml`](config.example.yaml) for the annotated reference.
The modern configuration uses `broadcasters` with one `tokenStorePath` per
channel. The legacy single `broadcaster` block is still accepted.
Key `wentlive` options:

```yaml
plugins:
  config:
    wentlive:
      template: "{streamer} has gone live at {timestamp}"
      timestampFormat: "iso"   # or "utc"
```

## Writing a plugin

Create `src/plugins/<name>/index.ts` (or drop a compiled `.js` into a directory
listed under `plugins.directories`) and export a default `Plugin`:

```ts
import type { Plugin } from '../../core/types.js';

const plugin: Plugin = {
  name: 'hello',
  version: '1.0.0',
  init(ctx) {
    ctx.command({
      trigger: 'hello',
      allow: ['everyone'],          // or ['broadcaster','moderator','vip','subscriber']
      handler: (event, ctx) => ctx.say(
        `hi @${event.chatterDisplayName}!`,
        event.messageId,
        event.broadcasterId,
      ),
    });

    ctx.on('streamOnline', (e) => ctx.logger.info({ e }, 'we are live'));
  },
};

export default plugin;
```

Then add its `name` to `plugins.enabled` in `config.yaml`. Discovery, loading,
and errors are isolated per-plugin — a broken plugin is logged and skipped, never
crashing the bot.

## Testing

```bash
npm test          # vitest unit tests (permissions, commands, both plugins)
npm run typecheck # tsc --noEmit
```

### Local end-to-end without going live

Use the [Twitch CLI](https://dev.twitch.tv/docs/cli/) mock EventSub server to
trigger events against a running bot — no live stream needed:

```bash
twitch event websocket start-server
# point the bot at the mock, then in another terminal:
twitch event trigger channel.chat.message --transport=websocket
twitch event trigger stream.online       --transport=websocket
```

## License

MIT
