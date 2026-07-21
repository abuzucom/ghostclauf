# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Changed

- Broadcaster authorization (`npm run auth -- --broadcaster <login>`) now
  requests the `moderator:read:followers` scope, needed by the follower
  lookup. Existing broadcaster tokens must be re-authorized once; the
  `checkTokens` auto-repair flow now detects the missing scope and prompts
  the re-auth.

### Fixed

- Token stores are now shape-validated on read; a corrupted or malformed
  store fails fast with guidance to re-run `npm run auth` instead of
  surfacing confusing twurple errors later.

### Added

- Twitch chat sends now use a shared per-channel and per-account rate limiter,
  enforce Twitch's 500-character message limit, and log messages dropped by
  Twitch with their drop reason.
- EventSub socket disconnects, subscription failures, and revocations are
  logged with authorization context.
- Startup and reconnect live-state reconciliation recovers missed
  `stream.online` events without repeating going-live announcements.
- OAuth token stores now receive startup scope, format, and validation checks
  with reauthorization guidance.

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
