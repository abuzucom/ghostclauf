# ghostclauf

A lightweight, highly extensible chat bot. Its first deployment target is
**Twitch chat**, but the extensibility layer is transport-agnostic — behaviours
are added as drop-in **plugins**, not hard-coded against Twitch.

The design borrows the *spirit* of [eggdrop](https://github.com/eggheads/eggdrop)
(event bindings + modules) and [ub3r-b0t](https://github.com/moiph/ub3r-b0t)
(clean multi-command structure), but is written fresh — no fork, no vendored code.

## Contents

- [Features](#features-v1)
- [Attendance / watch streaks (`streak`)](#attendance--watch-streaks-streak-plugin)
- [Follow age (`followage`)](#follow-age-followage-plugin)
- [Lurk (`lurk`)](#lurk-lurk-plugin)
- [Shoutout (`shoutout`)](#shoutout-shoutout-plugin)
- [How it talks to Twitch](#how-it-talks-to-twitch)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Run](#run)
- [Configuration](#configuration)
- [Writing a plugin](#writing-a-plugin)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Features (v1)

- **`!ping` → `pong!`** — replies `pong!` when the **broadcaster, a moderator, a
  VIP, or a subscriber** types `!ping`. Non-privileged viewers are ignored.
- **Going-live announcement** — when the stream goes live, posts
  `<streamer> has gone live at <UTC timestamp>` (template configurable).
- **Attendance / watch streaks** — viewers `!checkin` while live to build a
  streak of consecutive stream days attended (see below).
- **Follow age** - `!followage` (or `!followage @user`) replies with how long
  the viewer has followed the channel the command was typed in (see below).
- **Lurk acknowledgement** — `!lurk` / `!unlurk` let viewers announce they're
  around without being active in chat (see below).
- **Shoutouts** — `!so` / `!shoutout @channel` (moderators and the
  broadcaster) plugs another streamer's channel (see below).

`ping` and `wentlive` are the reference examples for writing your own
(`src/plugins/ping`, `src/plugins/wentlive`); `src/plugins/streak` is the
larger worked example. All six built-in plugins live under `src/plugins/`.

## Attendance / watch streaks (`streak` plugin)

Tracks regular viewers with a chat check-in. A streak counts **consecutive
stream days** a viewer checked in: only calendar days on which the stream was
live count, so off-days are skipped rather than breaking a streak; missing a
check-in on a day the stream *was* live resets the streak to 1.

A day is marked "live" by the `stream.online` event, but recording the day
alone isn't enough to keep check-in open: with the default
`requireStreamDay: true`, the channel (or, when pooled, any channel in the
shared pool) must also be live *right now* — `!checkin` closes as soon as
`stream.offline` fires, rather than staying open for the rest of the day. If
the bot starts *after* the stream already went live (so it missed the
`stream.online` event), a broadcaster or moderator can run `!streakopen` to
mark the day and mark that channel live. Set `requireStreamDay: false` to
instead count any day a viewer checks in, with no live requirement at all.

Check-ins are anchored to when the current stream actually started, not the
wall-clock moment of the check-in — a viewer checking in at 1AM after an 11PM
stream start still counts toward the 11PM stream's day, for up to
`streamSessionHours` (default 18) after the stream began.

Running multiple broadcasters in `config.yaml`? By default (`shareAcrossChannels:
true`) all of them pool into one streak per viewer — handy when they're all the
same streamer's channels. Set `shareAcrossChannels: false` to keep each
channel's streaks fully independent instead.

Commands (trigger words configurable):

| Command | Who | Effect |
| ------- | --- | ------ |
| `!checkin` | everyone | Record attendance for today and extend the streak. |
| `!streak` | everyone | Show your streak; `!streak @user` looks up another viewer. |
| `!streakreset @user` | broadcaster only | Reset a viewer's streak to 0. |
| `!streakset @user <n>` | broadcaster / mod | Set a viewer's streak to a value. |
| `!streakopen` | broadcaster / mod | Mark today a stream day and the channel live, if `stream.online` was missed. |

State persists to `dataPath` (default `./data/streaks.json`). Day boundaries use
the configured `timezone` (IANA name, default `UTC`). A channel-point redeem is
planned; when added it will reuse the same check-in path. See
[`config.example.yaml`](config.example.yaml) for all options.

## Follow age (`followage` plugin)

`!followage` tells a viewer how long they have followed the channel, e.g.
`Viewer has been following itsjustatank for 3 years, 2 months.` Anyone can run
it; `!followage @user` looks up another viewer instead. The bot is
multi-channel aware: the command answers for the broadcaster of the chat it
was typed in, so the same viewer can get different answers in different
configured channels.

Each chatter is rate-limited (`cooldownSeconds`, default 10); repeats inside
the window are silently ignored so chat floods cannot burn the shared Helix
API budget. Set `0` to disable.

The lookup uses the Helix *Get Channel Followers* endpoint, which requires the
**broadcaster's** token to carry the `moderator:read:followers` scope. Tokens
authorized before this plugin existed do not have it — re-run
`npm run auth -- --broadcaster <login>` once per broadcaster to grant it.

## Lurk (`lurk` plugin)

`!lurk` announces a viewer is lurking (`Thanks for the lurk, @user! We see
you.`); `!unlurk` welcomes them back. Repeating `!lurk` while already lurking
gets a different acknowledgement instead of a duplicate reply. State (who's
currently lurking) is tracked per channel, in memory only, and capped so it
can't grow unbounded under chatter churn. The broadcaster's own messages are
ignored so a streamer testing chat commands doesn't announce themselves as
lurking.

Each chatter is rate-limited (`cooldownSeconds`, default 10) per command
(`!lurk` and `!unlurk` cooldown independently), and every message is
configurable. See the `lurk:` block in
[`config.example.yaml`](config.example.yaml).

## Shoutout (`shoutout` plugin)

`!so @channel` (alias `!shoutout @channel`, moderators and the broadcaster
only) posts a configurable plug — by default `Go check out @channel at
twitch.tv/channel! They were last seen playing <game>.` — using the target's
last-played category, falling back to `fallbackGame` when the channel has no
category set.

When `sendNativeShoutout` is true (the default), it also issues Twitch's
native shoutout via Helix, which requires the **broadcaster's** token to
carry the `moderator:manage:shoutouts` scope (the same re-auth as
`followage`, above, covers this). A failed native shoutout is logged as a
warning but doesn't block the chat reply. See the `shoutout:` block in
[`config.example.yaml`](config.example.yaml) for message/template overrides.

## How it talks to Twitch

Twitch now recommends **[EventSub](https://dev.twitch.tv/docs/eventsub/) for
reading chat + the [Helix Send Chat Message API](https://dev.twitch.tv/docs/chat/send-receive-messages/)
for writing**, replacing legacy IRC. ghostclauf opens a **single EventSub
WebSocket** that carries *both* required events:

| Requirement            | EventSub subscription   |
| ---------------------- | ----------------------- |
| Chat commands          | `channel.chat.message`  |
| Going-live announcement, streak live-gating | `stream.online`  |
| Streak live-gating (close on end)  | `stream.offline` |

All Twitch specifics live in [`src/core/twitch.ts`](src/core/twitch.ts) (built on
[@twurple](https://twurple.js.org)); everything else is platform-neutral.

Outbound messages use a shared queue that stays within Twitch's conservative
chat limits (one message per channel per second and 20 messages per 30 seconds
per bot account). The transport reports dropped messages and EventSub
authorization or connection failures through structured logs. On startup and
after a reconnect it checks the current stream state to recover missed
`stream.online`/`stream.offline` events; recovery updates stateful plugins
without repeating a going-live announcement.

Plugins subscribe to either event via `ctx.on(...)` (see
[Writing a plugin](#writing-a-plugin)): `streamOnline` (`BotEvents.streamOnline`)
fires when a channel goes live, `streamOffline` (`BotEvents.streamOffline`)
when it ends.

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
    streak/             !checkin / !streak / admin commands, live-gated
    followage/          !followage - Helix follower lookup
    lurk/               !lurk / !unlurk
    shoutout/           !so / !shoutout - Helix user lookup + native shoutout
  tools/
    authFlow.ts         one-time OAuth to mint an account's initial token
    checkTokens.ts      reports missing/under-scoped token stores (used by run.bat)
    configureAccounts.ts  writes real Twitch logins into config.yaml (used by run.bat)
```

**Plugins never import twurple.** They receive a `BotContext` and use only:
`ctx.command({...})`, `ctx.on(event, handler)`, `ctx.say(text, replyToId?, broadcasterId?)`,
`ctx.config`, and `ctx.logger`.

## Prerequisites

1. A **Twitch application** — register at
   <https://dev.twitch.tv/console/apps>. Note the **Client ID** and
   **Client Secret**, and add `http://localhost:3000/callback` as a redirect URI.
2. One or more **broadcaster accounts** whose channels the bot will monitor
   (the examples throughout this README use two, but any number works — see
   [Configuration](#configuration)).
3. A **bot account** (a separate Twitch account the bot posts as).
4. In each broadcaster's channel, make the bot a **moderator**, *or* have the
   broadcaster grant the `channel:bot` scope — either lets the bot post.

The bot account authorizes these scopes: `user:read:chat`, `user:write:chat`,
`user:bot`. Each broadcaster authorizes a user token for its EventSub
WebSocket (`stream.online`/`stream.offline` need no extra scope) plus two
scopes used by plugins: `moderator:read:followers` (the `followage` lookup)
and `moderator:manage:shoutouts` (native shoutouts from the `shoutout`
plugin). `npm run auth -- --broadcaster <login>` requests all of a
broadcaster's required scopes together.

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
refresh automatically. On POSIX systems, token files are written with owner-only
permissions (`0o600`); existing token files are tightened when they are written.
For Docker bind mounts or shared volumes, configure host filesystem ownership
and ACLs to restrict access as well.

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
    ctx.on('streamOffline', (e) => ctx.logger.info({ e }, 'stream ended'));
  },
};

export default plugin;
```

It's enabled automatically — every plugin discovered in `plugins.directories`
runs by default. To turn a specific plugin off, add its `name` to
`plugins.disabled` in `config.yaml` (or set `plugins.enabled` to an explicit
list to switch to an allow-list instead). Discovery, loading, and errors are
isolated per-plugin — a broken plugin is logged and skipped, never crashing
the bot.

## Testing

```bash
npm test          # vitest unit tests (core + all six plugins)
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

## Troubleshooting

**A plugin's commands don't respond at all, but `!ping` works.** The plugin
either isn't enabled or failed to start. Check `plugins.disabled` (or
`plugins.enabled`, if you're using the explicit allow-list) in `config.yaml`,
and check the startup log for `initialized N plugin(s)` (lists which plugins
actually loaded) or a `plugin init threw, skipping` error naming the plugin.

**`!followage` replies "Couldn't look up followage right now."** The
broadcaster's token for that channel is missing `moderator:read:followers`.
Re-run `npm run auth -- --broadcaster <login>` for that channel; `run.bat`
also detects and prompts for this automatically via `checkTokens`.

**`!so`/`!shoutout` posts the chat message but no native Twitch shoutout
happens.** Same cause as above, but for `moderator:manage:shoutouts` — check
the log for a `Twitch native shoutout call failed or was rate limited`
warning, then re-authorize that broadcaster.

**`!checkin` replies "check-in is not open yet."** Either the channel hasn't
gone live yet this session (the bot needs the real `stream.online` event, or
a broadcaster/mod running `!streakopen`), or the stream already ended
(`stream.offline` closes check-in even if the day was already recorded — see
[Attendance / watch streaks](#attendance--watch-streaks-streak-plugin)). Set
`requireStreamDay: false` if you want check-ins to work regardless of live
status.

## License

MIT
