# ghostclauf

A lightweight, highly extensible chat bot. Its first deployment target is
**Twitch chat**, but the extensibility layer is transport-agnostic — behaviours
are added as drop-in **plugins**, not hard-coded against Twitch.

The design borrows the _spirit_ of [eggdrop](https://github.com/eggheads/eggdrop)
(event bindings + modules) and [ub3r-b0t](https://github.com/moiph/ub3r-b0t)
(clean multi-command structure), but is written fresh — no fork, no vendored code.

## Contents

- [Features](#features-v1)
- [Attendance / watch streaks (`streak`)](#attendance--watch-streaks-streak-plugin)
- [Follow age (`followage`)](#follow-age-followage-plugin)
- [Lurk (`lurk`)](#lurk-lurk-plugin)
- [Shoutout (`shoutout`)](#shoutout-shoutout-plugin)
- [Announce (`announce`)](#announce-announce-plugin)
- [Fun facts (`funfact`)](#fun-facts-funfact-plugin)
- [Quotes (`quotes`)](#quotes-quotes-plugin)
- [Loyalty (`loyalty`)](#loyalty-loyalty-plugin)
- [Now playing (`nowplaying`)](#now-playing-nowplaying-plugin)
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
- **Announcements** — posts a templated message on raid, subscribe, and
  cheer, each independently toggleable (see below).
- **Fun facts** - the broadcaster curates a pool with `!addfunfact` /
  `!delfunfact`, and anyone can pull one with `!funfact` (see below).
- **Quotes** - the broadcaster curates a pool of community quotes with
  `!addquote` / `!delquote`, and anyone can pull one with `!quote` (see below).
- **Loyalty** - viewers passively earn a configurable currency for chat
  activity while live; `!wallet` / `!economy` (see below).
- **Now playing** — `!nowplaying` reports the track(s) currently on air from a
  local DJ overlay server (see below).

`ping` and `wentlive` are the reference examples for writing your own
(`src/plugins/ping`, `src/plugins/wentlive`); `src/plugins/streak` is the
larger worked example. All built-in plugins live under `src/plugins/`.

## Attendance / watch streaks (`streak` plugin)

Tracks regular viewers with a chat check-in. Legacy mode counts consecutive
recorded stream days. The `all-broadcasters` policy keeps one shared viewer
streak while tracking each broadcaster's sessions independently: missing only
one broadcaster is forgiven, and a streak breaks only after qualifying misses
from every configured broadcaster. Days without streams never count.

`dayBoundaryHour` moves the local attendance rollover away from midnight.
`reconnectGraceMinutes` keeps a same-broadcaster restart on its original
logical day. `minimumQualifyingSessionMinutes` protects absent viewers from
brief failed streams; one uninterrupted session must reach that duration to
become missable, while viewers who checked in during a shorter stream keep
their credit.

Check-in is local to the channel receiving the command even when viewer streaks
are shared. EventSub offline notifications are confirmed against Helix before
continuity is broken. Ambiguous confirmation failures do not create viewer
penalties. `!streakopen` manually starts the invoking broadcaster's session.

The primary JSON store keeps one previous `.bak` snapshot. Automatic penalties
are auditable and repairable with `!fixstreak`; authoritative `!streakset`
decisions use a separate journal and can be reversed latest-first with
`!undostreakset`. Manual sets and undos use write-ahead transaction IDs in both
files; startup reconciliation completes or aborts operations interrupted by a
process crash.

Commands (trigger words configurable):

| Command                | Who               | Effect                                                                       |
| ---------------------- | ----------------- | ---------------------------------------------------------------------------- |
| `!checkin`             | everyone          | Record attendance for today and extend the streak.                           |
| `!streak`              | everyone          | Show your streak; `!streak @user` looks up another viewer.                   |
| `!streakreset @user`   | broadcaster only  | Reset a viewer's streak to 0.                                                |
| `!streakset @user <n>` | broadcaster only  | Set a viewer's streak to a canonical value.                                  |
| `!fixstreak @user`     | broadcaster only  | Restore the latest unrepaired automatic penalty.                             |
| `!undostreakset @user` | broadcaster only  | Reverse the latest authoritative manual set.                                 |
| `!streakopen`          | broadcaster / mod | Mark today a stream day and the channel live, if `stream.online` was missed. |

**Pooled channels share one administrative trust boundary.** With
`shareAcrossChannels: true` (the default) the admin commands above act on the
shared pool, so the broadcaster of _any_ configured channel can reset, set,
repair, or undo streaks that every pooled channel sees. This is intended - the
pool exists for one streamer's own channels - so only pool broadcasters you
trust equally. Set `shareAcrossChannels: false` to give each channel its own
independent streaks and its own administrators.

State persists to `dataPath` (default `./data/streaks.json`) with a previous
snapshot at `<dataPath>.bak`. Both files are written owner-only (0600), since
they hold viewer logins and IDs. Manual decisions persist to `decisionPath`.
Resolved penalties and decisions are trimmed to the 50 most recent per viewer
at startup; unrepaired penalties and reversible sets are never trimmed. Day
boundaries use the configured IANA `timezone`. See
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

The lookup uses the Helix _Get Channel Followers_ endpoint, which requires the
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

## Announce (`announce` plugin)

Posts a templated chat message when the channel is raided, gets a new
subscriber, or receives a cheer. Each event has its own enable toggle and
template, all off the same `announce:` config block:

| Event     | Default template                              | Placeholders                                                    |
| --------- | --------------------------------------------- | --------------------------------------------------------------- |
| Raid      | `{raider} raided with {viewers} viewers!`     | `{raider}`, `{viewers}`                                         |
| Subscribe | `{user} subscribed at tier {tier}{giftNote}!` | `{user}`, `{tier}` (1/2/3), `{giftNote}` (` (gifted)` or empty) |
| Cheer     | `{user} cheered {bits} bits: {message}`       | `{user}` (`Someone` if anonymous), `{bits}`, `{message}`        |

Cheers below `cheer.minBits` (default 100) are not announced, to avoid chat
spam from small cheers. Raids need no extra scope; subscribe requires
`channel:read:subscriptions` and cheer requires `bits:read` on the
**broadcaster's** token - re-run `npm run auth -- --broadcaster <login>` to
grant them if the broadcaster authorized before this plugin existed. A
missing scope only disables that event's subscription (logged as a
warning); it does not stop the bot from starting. See the `announce:` block
in [`config.example.yaml`](config.example.yaml).

## Fun facts (`funfact` plugin)

A curated pool of one-liners about the channel, stored on disk under `data/`.

| Command              | Who      | Effect                                            |
| -------------------- | -------- | ------------------------------------------------- |
| `!addfunfact <text>` | curators | Adds a fact and replies with its id.              |
| `!delfunfact <id>`   | curators | Removes that fact. Ids are never reused.          |
| `!funfact`           | everyone | Posts a random fact with its id and who added it. |
| `!funfact <id>`      | everyone | Posts that specific fact.                         |
| `!funfactcount`      | everyone | Reports how many facts are stored.                |

Curators are the broadcaster of the channel the command was typed in, plus any
chatter listed for that channel under `treatAsBroadcaster` - the same
cross-channel pattern the `ping` plugin uses, so streamers who moderate each
other's channels can curate in both. Moderators who are not listed cannot add
or delete, and their attempts are ignored silently.

Reads are rate limited to one reply per chatter per channel every
`cooldownSeconds` (default 30); the broadcaster and moderators are exempt, and
throttled invocations get no reply at all so a chat flood cannot be amplified.

Facts are pooled across every configured broadcaster by default
(`shareAcrossChannels: true`), so a fact added in one channel is served in all
of them. Set it to false to keep each channel's pool independent. Submitted
text is collapsed to a single line, capped at 300 characters, rejected if it
starts with `/` or `.`, and deduplicated case-insensitively; the pool holds at
most 500 facts. See the `funfact:` block in
[`config.example.yaml`](config.example.yaml).

## Quotes (`quotes` plugin)

A curated pool of community quotes, stored on disk under `data/`. Distinct
from `funfact`: quotes carry an optional speaker attribution, separate from
who added them.

| Command                          | Who      | Effect                                                               |
| -------------------------------- | -------- | -------------------------------------------------------------------- |
| `!addquote <text> [- <speaker>]` | curators | Adds a quote and replies with its id.                                |
| `!delquote <id>`                 | curators | Removes that quote. Ids are never reused.                            |
| `!quote`                         | everyone | Posts a random quote, with its id, speaker if any, and who added it. |
| `!quote <id>`                    | everyone | Posts that specific quote.                                           |
| `!quotecount`                    | everyone | Reports how many quotes are stored.                                  |

`!addquote` splits on the last `-` (space-hyphen-space) in the argument, so
`!addquote well, actually - Tank` stores the text "well, actually" with
speaker "Tank"; text with no `-` separator - including text that merely
contains a hyphen with no surrounding spaces - has no speaker. Curators are
the broadcaster of the channel the
command was typed in, plus any chatter listed for that channel under
`treatAsBroadcaster` - the same cross-channel pattern `funfact` and `ping`
use. Moderators who are not listed cannot add or delete, and their attempts
are ignored silently.

Reads are rate limited to one reply per chatter per channel every
`cooldownSeconds` (default 30); the broadcaster and moderators are exempt, and
throttled invocations get no reply at all so a chat flood cannot be amplified.

Quotes are pooled across every configured broadcaster by default
(`shareAcrossChannels: true`), so a quote added in one channel is served in
all of them. Set it to false to keep each channel's pool independent.
Submitted text is collapsed to a single line, capped at 300 characters (the
speaker at 50), rejected if it starts with `/` or `.`, and deduplicated
case-insensitively on text and speaker together; the pool holds at most 500
quotes. See the `quotes:` block in [`config.example.yaml`](config.example.yaml).

## Loyalty (`loyalty` plugin)

Viewers passively earn a configurable currency (`esports dollars` by default) for
being active in chat while the channel is live.

| Command        | Who         | Effect                                                                      |
| -------------- | ----------- | --------------------------------------------------------------------------- |
| `!wallet`      | everyone    | Report your balance.                                                        |
| `!economy`     | everyone    | Show the top `leaderboardSize` balances (default 5).                        |
| `!setESD`      | broadcaster | `!setESD @user <amount>` - set a viewer's balance exactly.                  |
| `!giveESD`     | broadcaster | `!giveESD @user <amount>` - add to a viewer's balance.                      |
| `!takeESD`     | broadcaster | `!takeESD @user <amount>` - subtract from a viewer's balance, clamped at 0. |
| `!undosetESD`  | broadcaster | Reverse a viewer's most recent `!setESD`.                                   |
| `!undogiveESD` | broadcaster | Reverse a viewer's most recent `!giveESD`.                                  |
| `!undotakeESD` | broadcaster | Reverse a viewer's most recent `!takeESD`.                                  |

**Earning is a chat-activity proxy, not real Twitch watch-time.** Every
`tickIntervalMinutes` (default 5), each chatter who sent at least one chat
message since the last tick, while their channel was live, is awarded
`dollarsPerTick` (default 1). The bot only sees chat messages - it has no
access to the viewer list - so this measures chat participation, not
whether someone is actually watching. There is no earn command; earning is
entirely passive. Reads (`!wallet`/`!economy`) are rate limited to one
reply per chatter per channel every `cooldownSeconds` (default 10);
broadcasters and moderators are exempt.

Balances are pooled across every configured broadcaster by default
(`shareAcrossChannels: true`); set it to false to keep each channel's
balances independent. With pooling on, a `!setESD`/`!giveESD`/`!takeESD` run
in one channel changes the balance everywhere - the same tradeoff already
documented for the `streak` plugin's shared pool. There is no
spend/redemption yet. See the `loyalty:` block in
[`config.example.yaml`](config.example.yaml).

`!setESD`, `!giveESD`, and `!takeESD` write straight into a balance and are
gated on the broadcaster badge alone - no secondary allowlist. **This is
safe only because every broadcaster configured above is assumed to be the
operator's own channel or persona.** If a third party's channel is ever
added to this bot's config, that broadcaster gains the ability to set
balances in the shared pool, and a handler-level allowlist would need to be
added.

The amount argument accepts a plain decimal integer only - no arithmetic, no
scientific notation, no alternate bases. `!giveESD`/`!takeESD` clamp at the
balance cap and report when they did.

Each undo command reverses only the matching kind's most recent applied
change, by delta rather than by restoring an absolute value - so
`!undogiveESD` after a `!giveESD` followed by a `!takeESD` leaves the
`!takeESD` standing rather than discarding it. There are no refunds for
`!redeem` (not yet implemented); `!setESD` is the correction path for any
mistake in a viewer's balance.

## Now playing (`nowplaying` plugin)

Reports the track(s) currently on air, by polling a local `1a2n-track-id`
overlay server (a Traktor Pro 4 deck/track tracker for DJ streams) on demand.
It never holds a persistent connection, so it can't interfere with that
server's own auto-shutdown.

| Command       | Who      | Effect                                       |
| ------------- | -------- | -------------------------------------------- |
| `!nowplaying` | everyone | Posts the track(s) currently on air, if any. |

The broadcaster and moderators can use it any time, unlimited. Everyone else
is limited to once every 3 minutes per chatter per channel (fixed, not
configurable). If the overlay server is unreachable or nothing is on air, the
command replies with nothing rather than an error. `baseUrl` defaults to
`http://127.0.0.1:8080` (same machine as the bot) but can be pointed anywhere
reachable. See the `nowplaying:` block in
[`config.example.yaml`](config.example.yaml).

## How it talks to Twitch

Twitch now recommends **[EventSub](https://dev.twitch.tv/docs/eventsub/) for
reading chat + the [Helix Send Chat Message API](https://dev.twitch.tv/docs/chat/send-receive-messages/)
for writing**, replacing legacy IRC. ghostclauf opens a **single EventSub
WebSocket** that carries _both_ required events:

| Requirement                                 | EventSub subscription  |
| ------------------------------------------- | ---------------------- |
| Chat commands                               | `channel.chat.message` |
| Going-live announcement, streak live-gating | `stream.online`        |
| Streak live-gating (close on end)           | `stream.offline`       |
| Announce plugin: raid                       | `channel.raid`         |
| Announce plugin: subscribe                  | `channel.subscribe`    |
| Announce plugin: cheer                      | `channel.cheer`        |

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

## Operational visibility

The bot serves two HTTP endpoints for external supervisors (systemd, Docker
healthcheck, uptime monitors), reusing the port opened for the one-time OAuth
callback (`AUTH_REDIRECT_URI`, default `3000` - the OAuth flow and the running
bot never listen at the same time):

- `GET /healthz` - always `200` once the process is listening (liveness).
- `GET /readyz` - `200` once the EventSub transport has started and no
  configured broadcaster's token has been revoked, `503` otherwise
  (readiness). The response body also includes a snapshot of in-process
  counters: `eventsub_reconnects`, `eventsub_revocations`,
  `chat_send_failures`, `rate_limit_drops`, `token_refresh_failures`.

Token-refresh failures and EventSub subscription revocations also emit a
structured, greppable log line (`{ alert: true, kind: ... }`) so an ops log
pipeline can alert on them without polling `/readyz`.

Both endpoints bind loopback-only (`127.0.0.1`) by default, since `/readyz`'s
metrics snapshot is operational data that should not be reachable off-box
just because a container publishes the port - a same-host healthcheck
(`docker exec`, systemd) reaches loopback fine.

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
    metrics.ts          in-process counter registry
    alerts.ts           structured alert log helper
    healthServer.ts     /healthz + /readyz HTTP endpoints
  plugins/
    ping/               !ping -> pong!
    wentlive/           stream.online -> announcement
    streak/             !checkin / !streak / admin commands, live-gated
    followage/          !followage - Helix follower lookup
    lurk/               !lurk / !unlurk
    shoutout/           !so / !shoutout - Helix user lookup + native shoutout
    announce/           raid / subscribe / cheer -> templated announcement
    funfact/            !addfunfact / !funfact - curated fact pool on disk
    quotes/             !addquote / !quote - curated quote pool on disk
    loyalty/            !wallet / !economy - passive chat-activity currency
    nowplaying/         !nowplaying - polls a local DJ overlay server
  tools/
    authFlow.ts         one-time OAuth to mint an account's initial token
    checkTokens.ts      reports missing/under-scoped token stores (used by run.sh / run.bat)
    configureAccounts.ts  writes real Twitch logins into config.yaml (used by run.sh / run.bat)
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
4. In each broadcaster's channel, make the bot a **moderator**, _or_ have the
   broadcaster grant the `channel:bot` scope — either lets the bot post.

The bot account authorizes these scopes: `user:read:chat`, `user:write:chat`,
`user:bot`. Each broadcaster authorizes a user token for its EventSub
WebSocket (`stream.online`/`stream.offline`/raids need no extra scope) plus
scopes used by plugins: `moderator:read:followers` (the `followage` lookup),
`moderator:manage:shoutouts` (native shoutouts from the `shoutout` plugin),
`channel:read:subscriptions` (the `announce` plugin's subscribe event), and
`bits:read` (the `announce` plugin's cheer event).
`npm run auth -- --broadcaster <login>` requests all of a broadcaster's
required scopes together.

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

### One-click setup & launch scripts

**Linux (Ubuntu) and macOS:**

1. Run `./setup.sh` in terminal.
2. Edit `.env` with your Twitch application's Client ID and Client Secret
   (register one at <https://dev.twitch.tv/console/apps>).
3. Run `./run.sh` to start the bot.

**Windows:**

1. Double-click `setup.bat` in the project folder.
2. Edit `.env` with your Twitch application's Client ID and Client Secret
   (register one at <https://dev.twitch.tv/console/apps>).
3. Double-click `run.bat` to start the bot.

`setup.sh` / `setup.bat` does not overwrite an existing `.env` or `config.yaml`, and does
not ask for account logins or touch OAuth — that all happens in `run.sh` / `run.bat` the
first time it runs:

- If `config.yaml` still has the `config.example.yaml` placeholder logins,
  `run.sh` / `run.bat` prompts for the real bot and broadcaster Twitch logins and saves
  them into `config.yaml` (comments and formatting preserved).
- It then checks which of those accounts still need authorization - including
  the bot token existing but missing a required scope (e.g. `user:write:chat`)
    - and opens the OAuth flow for each one automatically.
- No manual `npm run auth` commands. Once every account is configured and
  authorized, later runs skip straight to starting the bot.

Every run of `run.sh` / `run.bat` also rebuilds (`npm run build`) before starting, so
`git pull`-ing an update and running `./run.sh` (or `run.bat`) is enough - you never
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

**Running as a service:**

Both templates run `node dist/index.js` directly rather than `npm start`, so
editing a `package.json` script cannot change what the service executes.

- **Linux (Ubuntu - systemd):** Copy `scripts/ghostclauf.service` to `~/.config/systemd/user/ghostclauf.service`, update `WorkingDirectory` and `ReadWritePaths`, then enable and start it:
    ```bash
    systemctl --user daemon-reload
    systemctl --user enable --now ghostclauf
    ```
    The unit ships with `ProtectSystem=strict`, `ProtectHome=read-only`, and
    `NoNewPrivileges`, and can only write `ReadWritePaths`. If you move
    `WorkingDirectory` under `$HOME`, drop `ProtectHome` and repoint
    `ReadWritePaths`, or the bot cannot persist its OAuth tokens.
- **macOS (launchd):** Copy `scripts/com.ghostclauf.bot.plist` to `~/Library/LaunchAgents/com.ghostclauf.bot.plist`, replace every `CHANGE_ME` with your short user name, then load it:
    ```bash
    launchctl load ~/Library/LaunchAgents/com.ghostclauf.bot.plist
    ```
    Install the bot under your own home directory, not `/Users/Shared`: that
    directory is world-writable, so any local account could read the token
    store under `data/` or claim the install path first.

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
            template: '{streamer} has gone live at {timestamp}'
            timestampFormat: 'iso' # or "utc"
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
            allow: ['everyone'], // or ['broadcaster','moderator','vip','subscriber']
            handler: (event, ctx) =>
                ctx.say(`hi @${event.chatterDisplayName}!`, event.messageId, event.broadcasterId),
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
npm test          # vitest unit tests (core + every plugin)
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
