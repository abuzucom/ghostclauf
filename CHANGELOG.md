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
- CI: GitHub Actions are now pinned to full commit SHAs instead of mutable
  tags, ensuring workflow immutability.
- macOS service template no longer defaults to world-writable
  `/Users/Shared`, where any local account could read the OAuth token store
  under `data/`. It now uses a `CHANGE_ME` home-directory path and sets
  `Umask` to 0077.
- systemd unit runs confined: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `RestrictAddressFamilies`, and a `ReadWritePaths`
  limited to the data directory.
- Both service templates run `node dist/index.js` directly instead of
  `npm start`, so editing a `package.json` script cannot change what the
  service executes.
- `streak` plugin: the streak database, its `.bak` snapshot, and the decision
  journal are written owner-only (0600); they hold viewer logins and IDs.
- `config.yaml` bot and broadcaster logins are validated against Twitch's
  login charset, since `run.sh` passes them to `npm run auth`. The
  `config.example.yaml` placeholders are still accepted so `run.sh` can
  replace them interactively.
- CI: added an `npm audit --audit-level=high` step so high/critical
  dependency vulnerabilities fail the build instead of relying on manual
  review.
- Added `.github/dependabot.yml` for weekly automated `npm` and
  `github-actions` update pull requests.
- Added `test/atomicFile.test.ts`, direct coverage of `AtomicJsonFile`
  (owner-only file permissions, `.bak` snapshotting, concurrent-write
  safety, parent-directory auto-creation), previously exercised only
  transitively through the `streak` and `funfact` store tests.

### Added

- Operational visibility: `GET /healthz` (liveness) and `GET /readyz`
  (readiness, `503` while any configured broadcaster's EventSub subscription
  is revoked) HTTP endpoints, reusing the port already opened for the
  one-time OAuth callback. `/readyz` includes an in-process counter
  snapshot (`eventsub_reconnects`, `eventsub_revocations`,
  `chat_send_failures`, `rate_limit_drops`, `token_refresh_failures`).
  Token-refresh failures and EventSub revocations now also emit a
  structured, greppable `{ alert: true, kind: ... }` log line instead of a
  plain log message. No new dependency; built on `node:http` the same way
  `tools/authFlow.ts` already builds its OAuth callback server. Shutdown
  drops open health-server connections rather than waiting on them, so a
  local socket that never completes a request cannot stall exit.
- `nowplaying` plugin: `!nowplaying` (everyone) reports the track(s)
  currently on air by polling a local `1a2n-track-id` overlay server
  (Traktor Pro 4 deck/track tracker for DJ streams) on demand. Never holds a
  persistent connection to the overlay server. Broadcasters and moderators
  are unlimited; everyone else is limited to one request per chatter every 3
  minutes. Replies with nothing when the overlay is unreachable or nothing
  is on air. `baseUrl` (default `http://127.0.0.1:8080`) and
  `requestTimeoutMs` (default 1500) are configurable.
- `funfact` plugin: a curated pool of channel fun facts persisted under
  `data/`. Broadcasters (and the chatters listed under `treatAsBroadcaster`)
  add and remove entries with `!addfunfact` / `!delfunfact`; everyone can pull
  one with `!funfact`, fetch a specific entry with `!funfact <id>`, and check
  the size with `!funfactcount`. Reads are rate limited to one reply per
  chatter per channel every `cooldownSeconds` (default 30), with broadcasters
  and moderators exempt. Facts are pooled across channels by default
  (`shareAcrossChannels`). Submitted text, the plugin's config block, and the
  on-disk pool are all validated at runtime against bounded zod schemas; an
  invalid config field falls back to its default, and an invalid curator map
  falls back to empty so only the broadcaster can curate.
- `AtomicJsonFile` moved from the `streak` plugin to `src/core/atomicFile.ts`
  so plugins can share the crash-safe writer. The old module path still
  re-exports it.
- Linux and macOS support: added POSIX shell scripts (`setup.sh`, `run.sh`) and service configurations (`scripts/ghostclauf.service` for systemd on Linux and `scripts/com.ghostclauf.bot.plist` for launchd on macOS).
- CI workflow expansion: extended `.github/workflows/ci.yml` matrix to build and test on `ubuntu-latest`, `macos-latest`, and `windows-latest`.
- `EventBus.drain()` & `BotContext.drain()`: introduced in-flight handler tracking in `EventBus` so plugins can await pending async event handlers before shutdown or store flushing.
- CI lint tooling: ESLint (with `@typescript-eslint`) and Prettier are now
  configured and enforced, and devDependencies are strictly version-pinned.
- Graceful shutdown lifecycle: `PluginManager.disposeAll()` cleans up plugins
  in reverse-init order, and `StreakStore.flush()` ensures in-flight disk
  writes finish before exit.

### Fixed

- `streak` plugin: fixed a race condition in `handleOffline` by committing `lastOfflineAt` to session state before yielding to `qualifyCurrentInterval()`, preventing rapid reconnects from failing `isReconnect` checks.
- Prettier line ending compatibility: configured `endOfLine: "auto"` in `.prettierrc` to support cross-platform line endings across POSIX and Windows checkouts in CI.
- `setup.sh` and `run.sh` are committed executable, so the documented
  `./setup.sh` entry point works on a fresh clone.
- `streak` plugin: penalty records are validated on their nullable audit
  fields. A record missing `restoredAt` previously loaded as valid and read as
  "already repaired", hiding the penalty from `!fixstreak`.
- `streak` plugin: resolved penalties and decisions are trimmed to the 50 most
  recent per viewer at startup, bounding two journals that grew forever and
  were rewritten in full on every check-in. Unrepaired penalties and
  reversible sets are never trimmed.
- `streak` plugin: `!checkin` reports check-in closed when a broadcaster is
  live but has no persisted logical day, instead of relying on non-null
  assertions that would write an undefined day key into viewer records.
- `wentlive` plugin: an invalid stream start timestamp now throws instead of
  announcing the string "null".

- `streak` plugin: optional shared-audience policy with broadcaster-local
  sessions, a configurable local rollover hour, reconnect grace, and a minimum
  uninterrupted duration before a stream can count against absent viewers.
- `streak` plugin: viewer-friendly EventSub offline confirmation, automatic
  penalty recovery through `!fixstreak`, and authoritative manual-set recovery
  through `!undostreakset` and a separate decision journal.
- `streak` plugin: version-2 persistence with version-1 migration and one
  previous atomic JSON snapshot for both streak and decision data.
- `streak` plugin: write-ahead manual-set and undo transactions reconcile the
  decision journal with primary viewer state after an interrupted process.

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

- `plugins.enabled` in `config.yaml` is now optional: every discovered
  plugin is enabled by default, so adding a new plugin no longer requires
  editing `config.yaml` to turn it on. Use the new `plugins.disabled` list
  to turn specific plugins off. Setting `plugins.enabled` explicitly still
  works exactly as before (an allow-list restricted to just those names,
  and `plugins.disabled` is ignored in that case).
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
