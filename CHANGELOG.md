# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Pin transitive dependency `ws` to 8.21.1 via `overrides`, fixing a
  memory-exhaustion DoS (CVE-2026-62389) in `ws`'s WebSocket fragment
  receiver. Pulled in through `@twurple/eventsub-ws`.
- CI: `actions/checkout` steps now set `persist-credentials: false`, since
  neither job pushes back to the repository.

### Added

- `followage` plugin: `!followage` (everyone) replies with how long the
  caller (or `!followage @user`, another viewer) has followed the channel
  the command was typed in. Multi-channel aware: each configured channel
  answers for its own broadcaster.
- `followage` plugin: per-chatter `!followage` cooldown (`cooldownSeconds`,
  default 10). Repeats inside the window are silently ignored so chat floods
  cannot burn the shared Helix API rate budget. Set `0` to disable.
- `BotContext.helix`: a narrow, transport-agnostic lookup surface for plugins
  (`getUserByLogin`, `getFollowage`); twurple stays confined to
  `src/core/twitch.ts`.
- Shared `CooldownGate` and login-parsing helpers in `src/core`; the streak
  and followage plugins now use them instead of per-plugin copies.
- Twitch chat sends now use a shared per-channel and per-account rate limiter,
  enforce Twitch's 500-character message limit, and log messages dropped by
  Twitch with their drop reason.
- EventSub socket disconnects, subscription failures, and revocations are
  logged with authorization context.
- Startup and reconnect live-state reconciliation recovers missed
  `stream.online` events without repeating going-live announcements.
- OAuth token stores now receive startup scope, format, and validation checks
  with reauthorization guidance.
- `lurk` plugin: `!lurk` / `!unlurk` acknowledgements with configurable
  messages and a per-chatter cooldown (`cooldownSeconds`, default 10). Lurk
  state is tracked per channel and bounded in memory.
- `shoutout` plugin: `!so` / `!shoutout @channel` (moderators and the
  broadcaster) posts a shoutout message and optionally issues Twitch's native
  shoutout (`sendNativeShoutout`, requires the `moderator:manage:shoutouts`
  broadcaster scope).
- `stream.offline` is now a first-class transport event (`BotContext.on`),
  wired end-to-end alongside `stream.online`, including startup/reconnect
  reconciliation.

### Changed

- Broadcaster authorization (`npm run auth -- --broadcaster <login>`) now
  requests the `moderator:read:followers` and `moderator:manage:shoutouts`
  scopes, needed by the follower lookup and native shoutouts. Existing
  broadcaster tokens must be re-authorized once; the `checkTokens`
  auto-repair flow detects the missing scopes and prompts the re-auth.

### Fixed

- Token stores are now shape-validated on read; a corrupted or malformed
  store fails fast with guidance to re-run `npm run auth` instead of
  surfacing confusing twurple errors later.
- `config.example.yaml` had a duplicate `plugins.config.followage` key that
  made the file unparseable; the blocks are merged and a test now guards the
  example config against parse regressions.
- `lurk` plugin: lurk state was shared across all channels and grew without
  bound; it is now per channel, capped in memory, and rate limited.
- `followage` plugin: removed an unreachable "legacy" code path (and its
  `messages` config keys, which had no effect) that duplicated the live
  implementation without its cooldown.
- `BotContext.helix`: removed the duplicate `getFollowAge` method (unreleased)
  that mirrored `getFollowage` with swapped parameters and skipped the
  configured-broadcaster guard; `getFollowage` is required again.
- `streak` plugin: `!checkin` no longer stays open for the rest of the day
  once a stream has started; it now also requires the channel (or, when
  pooled, any channel in the shared pool) to be live right now, closing on
  the new `stream.offline` event.
- `streak` plugin store: a read failure other than "file does not exist"
  (e.g. a permission or I/O error) is now logged and rethrown instead of
  being treated as an empty database, so a transient failure can no longer
  cause a later check-in to overwrite real history. The on-disk shape check
  also validates nested channel/viewer records, not just the top-level
  envelope.

## [0.4.0] - 2026-07-21

### Added

- `streak` plugin: per-chatter `!checkin` cooldown (`checkinCooldownSeconds`,
  default 10). Repeat attempts inside the window are silently ignored so chat
  floods cannot hammer the persistence layer. Set `0` to disable.

### Changed

- `streak` plugin: `!streakset` is now broadcaster only (previously
  broadcaster or moderator), matching `!streakreset`.
- `streak` plugin: disk persistence now coalesces concurrent writes (at most
  one in flight and one queued), so a burst of check-ins costs at most two
  full-file writes instead of one per check-in. Writes stay strictly
  serialized on a single chain and each uses a unique temp filename, so
  overlapping writes can never corrupt the data file.

## [0.3.1] - 2026-07-21

### Changed

- Upgrade dev dependency `vitest` from 2.1.9 to 3.2.7, clearing all
  `npm audit` advisories in the vitest/vite/esbuild chain (dev-only;
  production audit was already clean).
- Pin GitHub Actions in CI workflows to full commit SHAs instead of
  mutable tags.
## [0.3.0] - 2026-07-21

### Added

- `streak` plugin: check-ins now pool across every configured broadcaster by
  default (`shareAcrossChannels`, default `true`) - useful when multiple
  channels belong to the same streamer. Set `shareAcrossChannels: false` to
  keep channels fully independent as before.
- `streak` plugin: check-ins are now anchored to when the current stream
  actually started rather than the wall-clock moment of the check-in
  (`streamSessionHours`, default 18), so a stream that runs past midnight no
  longer splits a viewer's attendance across two different stream days.

## [0.2.1] - 2026-07-21

### Changed

- `streak` plugin: `!streakreset` is now broadcaster only (previously
  broadcaster or moderator). `!streakset` and `!streakopen` are unchanged.

## [0.2.0] - 2026-07-20

### Added

- `streak` plugin: an attendance / watch-streak system. Viewers `!checkin`
  while live to build a streak of consecutive stream days attended; only days
  the stream was live count. Includes `!streak` self/other lookup, admin
  `!streakreset` / `!streakset`, and `!streakopen` for when the `stream.online`
  event was missed. State persists to `./data/streaks.json` (atomic, serialized
  writes); day boundaries use a configurable IANA timezone.
- `luxon` dependency for timezone-aware day-boundary handling.

## [0.1.0]

### Added

- Plugin-based, transport-agnostic chat bot core with a Twitch EventSub
  transport, config/secrets loading, permission model, command registry, and
  event bus.
- `ping` and `wentlive` reference plugins.
