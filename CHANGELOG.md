# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added a reviewed static GitHub Pages artifact for public fun facts, quotes,
  and esports dollars leaderboard data. Added an allowlisted exporter, static
  site validation, and a Pages deployment workflow for `ghost.clauf.org`.
- Added `publish-site.sh` and `publish-site.bat` to export and validate a
  reviewed public snapshot in one step before publishing.
- Added a startup connectivity check that posts and deletes a short test
  message in each configured channel, proving both the EventSub receive
  path and the Helix chat-send path work before the bot reports itself
  online. Failures raise `startup_reception_check_failed` /
  `startup_send_check_failed` alerts without blocking startup. Requires
  the bot account to hold the new `moderator:manage:chat_messages` scope;
  `run.sh`/`run.bat` detect and fix a missing scope automatically, headless
  deployments need `npm run auth -- --bot` once after upgrading.
- Added `hooks/check_branch_name_session_start.py`, a Claude Code
  SessionStart hook (opt-in via `.claude/settings.json`, see
  `hooks/claude-code-settings.example.json`) that runs
  `scripts/check_branch_name.py` against the current branch and, on a
  mismatch, injects a warning into the session's context telling the
  assistant to stop and get the branch renamed before committing or
  pushing. Added because a session-assigned branch name (e.g. a
  harness-provided `claude/<slug>` branch) can conflict with this repo's
  own `<type>/<kebab-description>` convention, and that conflict had
  repeatedly gone unnoticed until CI failed on an already-opened PR.

### Fixed

- `src/index.ts`'s fatal-startup handler now logs through the structured
  logger instead of `console.error`, clearing a `no-console` lint warning;
  the logger is created at module scope (it depends on no config that could
  fail to load) so the handler can reach it. Scoped `no-console` off for
  `src/tools/**` in `eslint.config.mjs`, since those CLI entrypoints use
  console output as their actual interface (interactive prompts, or, for
  `checkTokens.ts`, stdout that `run.sh`/`run.bat` parse line by line), not
  application logging.

### Changed

- Synced `AGENTS.md` (and its tool-specific copies) with upstream
  `abuzucom/agents` through v1.10.0 (previously synced through v1.7.0):
  added the `claude/`-branch-prefix ban and the Dependabot exemption to
  Branch naming conventions; added the "No hedging, fluff,
  self-justification, or self-narration" Style rule, backed by the new
  `scripts/check_hedging.py` (warning only, wired into
  `agents-sync.yml` and `make agents-lint`); extended "Comment the why"
  to ban historical narration referencing removed code or prior
  implementations; added a "## Handoff" section pointing at the newly
  adopted `plan/HANDOFF.md.example`. Downgraded `check_commit_message.py`
  from blocking to warning-only, matching upstream, while keeping this
  repo's existing merge-commit skip (not present upstream). Added
  `concurrency: cancel-in-progress` groups and, on
  `agents-md-compliance.yml`, an explicit `ready_for_review` pull-request
  trigger type, both matching upstream's CI hygiene. Adopted three
  upstream opt-in templates: `plan/HANDOFF.md.example`,
  `CONTRIBUTING.md.example` (install/test/lint placeholders filled with
  this repo's own commands), and the live `.github/PULL_REQUEST_TEMPLATE.md`
  / `.github/ISSUE_TEMPLATE.md`. Added a `check_hedging.py` row and updated
  `check_commit_message.py`'s exit-code entry in README's Checker
  reference table, and added "Handoff file example" / "Contributing guide
  example" / "Pull request and issue templates" README sections. Added
  `docs/agents-upstream-sync.md`, a mapping table, decision log, and
  reintegration checklist for the next upstream sync. Declined two
  upstream additions: `SECURITY.md.example` (this repo's own hand-written
  `security.md` already covers and exceeds it) and AgentLint
  (third-party GitHub Action; new dependency and `pull-requests: write`
  grant, not authorized).
- Updated all CodeQL Action SARIF uploads to v4.37.6. This removes the
  deprecated Node 20 runtime from the affected GitHub Actions workflows.
- Added architecture, plugin-authoring, and operations guides. Cross-linked
  README, configuration, and security documentation. Added targeted code
  documentation for lifecycle, persistence, and recovery behavior.
- Updated `AGENTS.md` and its synchronized tool copies to match the current
  lint command, dependency versions, architecture, and plugin inventory.
  Normalized README and changelog prose to the repository's ASCII and American
  English style rules. Added blocking documentation checks to the Makefile,
  pre-commit configuration, and compliance workflow.
- Updated the commit-message checker to skip generated merge commits while
  continuing to validate ordinary commit subjects.

- Migrated `zod` 3.25.76 -> 4.4.3 (previously deferred from PR #67, which
  broke typecheck). Two breaks, both fixed: `src/core/config.ts`'s
  `plugins.config` schema used v3's single-argument `z.record(valueSchema)`
  shorthand, which v4 no longer accepts (`z.record` is now strictly
  2-arity); switched to the explicit `z.record(z.string(), ...)` form.
  Separately, an identical config-field-validation helper
  (`resolveField`) was independently copy-pasted into all four plugins
  that read their own config block (`announce`, `funfact`, `loyalty`,
  `quotes`); v4's reworked generic inference broke its indexed-access
  pattern (`CONFIG_FIELD_SCHEMAS[field].safeParse(...)` no longer narrows
  to the right output type) in all four identically. Rather than patch
  each copy, extracted a single shared `resolveConfigField` into the new
  `src/core/configField.ts`, which takes the schema directly instead of
  indexing a heterogeneous map by generic key (sidestepping the inference
  break) and removes the duplication. Added a regression test
  (`test/config.test.ts`) covering a populated, multi-level
  `plugins.config` block, since the existing coverage only exercised the
  empty-object default. Verified: typecheck, lint, `npm test` (572/572),
  `npm run build`, and `npm audit --audit-level=high` all clean.

### Added

- Added four GitHub code-scanning workflows, adapted from itsjustatank's
  draft PRs (#63-#66) with fixes: `.github/workflows/ossar.yml` (OSSAR
  static analysis), `.github/workflows/powershell.yml` (PSScriptAnalyzer),
  `.github/workflows/osv-scanner.yml` (OSV-Scanner dependency
  vulnerability scanning), and `.github/workflows/scorecard.yml` (OpenSSF
  Scorecard). Fixes applied: added `persist-credentials: false` to the
  two checkout steps that were missing it (Rule 11); SHA-pinned every
  action that was still on a mutable tag (`actions/checkout`,
  `github/ossar-action`, `github/codeql-action/upload-sarif`); bumped the
  `google/osv-scanner-action` reusable-workflow pin from v1.7.1 to v2.5.0,
  since v1.7.1's `scan-pr` job unconditionally failed (it called the
  now-hard-deprecated `actions/upload-artifact@v3`); corrected the
  `powershell.yml` header comment, which linked a repo name
  (`microsoft/action-psscriptanalyzer`) different from the one the `uses:`
  line actually references (`microsoft/psscriptanalyzer-action`).

### Changed

- Merged the 3 open dependabot PRs whose CI was green: `postcss` 8.5.21
  -> 8.5.26 (dev-only, via vite; also clears the pre-existing moderate
  `npm audit` finding GHSA-fxqj-rqcc-2cmp), `vitest` 3.2.7 -> 4.1.10. Also
  merged `@twurple/api` 7.4.0 -> 8.1.4 (PR #70), but bumped `@twurple/auth`
  and `@twurple/eventsub-ws` to 8.1.4 alongside it: the PR as opened only
  bumped `@twurple/api`, which broke `npm ci` outright (ERESOLVE: `@twurple/api@8.1.4`
  peer-requires `@twurple/auth@8.1.4`) and violated this repo's own
  "@twurple/* packages ... keep them in lockstep" rule (see Gotchas).
  Verified after all three bumps: typecheck, lint, `npm test` (571/571),
  and `npm run build` all pass. The previously deferred Zod migration is now
  recorded in the top entry of this Unreleased section.

- Added ten `scripts/check_*.py` checkers from `abuzucom/agents`, wired into
  two CI workflows and `.pre-commit-config.yaml`: `check_banned_agents.py`
  (commit author/committer/`Co-authored-by` trailers and PR author against
  the xAI/Grok denylist), `check_branch_name.py`, `check_commit_message.py`,
  `check_persist_credentials.py` (Rule 11), `check_weak_hashing.py`
  (Rule 7), `check_dockerfile_root.py` (Rule 12), `check_secrets_heuristic.py`
  (Rule 8), `check_ascii.py` (dash/ASCII style, `AGENTS.md` only), and the
  warning-only `check_us_spelling.py` / `check_english_only.py` (also
  `AGENTS.md` only). `.github/workflows/agents-md-compliance.yml` is new
  (banned-agents, branch-name, and commit-message checks run on pull
  requests only, since they need a base/head commit range; the
  security/style static checks run on every push and pull request);
  `agents-sync.yml` gained the three `AGENTS.md`-scoped style checks. Added
  a `make agents-lint` target running everything locally, and a README
  "AGENTS.md compliance checks" section documenting each script.
- Added `user: node` to the `ghostclauf` service in `docker-compose.yml`,
  making the container's already-non-root runtime user (`Dockerfile`'s
  `USER node`) explicit at the compose level too; `check_dockerfile_root.py`
  checks each compose service independently of the image's own `USER`.
- Added `hooks/block_destructive_bash.py` and
  `hooks/claude-code-settings.example.json` from `abuzucom/agents` v1.7.0: a
  Claude Code `PreToolUse` hook blocking `rm -rf /`/`~`/`$HOME`, a bare
  `git push --force`/`-f`, and `git reset --hard`. Wired it into
  `.claude/settings.json` so it runs for this repo's Claude Code sessions,
  and extended `check_weak_hashing.py` / `check_secrets_heuristic.py`'s
  scanned globs (in `Makefile`, `.pre-commit-config.yaml`, and
  `agents-md-compliance.yml`) to cover `hooks/`. Added a README "Claude Code
  hook example" section documenting it.

### Changed

- Synced `AGENTS.md` (and its tool-specific copies) with upstream
  `abuzucom/agents` through v1.7.0: four new non-negotiable rules (verify
  state before assuming workflow intent, `persist-credentials: false` on
  GitHub Actions checkout steps, non-root Docker containers by default, back
  every enforcement claim with a real check); a "No suppressing checks"
  workflow rule; a history-safety rule against rewriting pushed commits on a
  shared branch without consent; a stricter dash rule banning `--`, `---`,
  and spaced-hyphen substitutes for em/en dashes, alongside a "No run-on
  sentences" rule; American English spelling and English-only style rules;
  and replaced the emoji Bad/Good markers throughout with ASCII text,
  matching the repo's own no-emoji rule. Corrected the Banned agents
  section's enforcement claim, which cited CI enforcement this repo did not
  have; now that `check_banned_agents.py` is wired into CI (see Added), the
  claim is accurate. Fixed a pre-existing markdown-escaping bug in the
  SQL/shell injection example (an unescaped backtick inside a
  single-backtick code span, present since the file was first adopted)
  using double-backtick delimiters. Also added `persist-credentials: false`
  to the `agents-sync.yml` checkout step, which predates the new rule and
  was the one workflow missing it. Reworded the remaining spaced-hyphen
  asides in the Commands/Do not touch/Gotchas sections (semicolons or
  colons instead), since those now sit in a file `check_ascii.py` lints as
  blocking.

### Fixed

- `.github/dependabot.yml`: ignore `typescript` versions `>=6.1.0`. The
  pinned `typescript-eslint@8.65.0` peer-depends on typescript 4.8.4
  through 6.0.x; dependabot's PR #59 (5.9.3 -> 7.0.2, skipping the 6.x
  line entirely) violated that range and failed every CI build/test job.
- `.github/workflows/agents-md-compliance.yml`: the `branch-name` and
  `commit-message` jobs now skip when `github.actor == 'dependabot[bot]'`.
  Dependabot's branch names and commit subjects never match the
  human-authored conventions those checks enforce, so every dependabot PR
  failed them regardless of the dependency change's own merit.

### Changed

- Merged the 6 open dependabot PRs whose CI was green: `dotenv` 16.6.1 ->
  17.4.2, `pino` 9.14.0 -> 10.3.1, `@types/node` 22.20.1 -> 26.1.2, `tsx`
  4.23.0 -> 4.23.9, `actions/checkout` v4.3.1 -> v7.0.1 (all four
  workflows), and `actions/setup-node` v4.4.0 -> v7.0.0 (`ci.yml`). The
  `typescript` 7.0.2 bump (PR #59) is excluded; see Fixed above.

### Security

- Added `security.md` documenting the security architecture, defense posture,
  threat model, operator responsibilities, and GitHub-based responsible
  disclosure process.
- Pin transitive dependency `nanoid` to 3.3.18 via `overrides`, clearing a
  high-severity advisory (GHSA-2v37-7h3g-55p8: custom generators can loop
  indefinitely when size is zero). Reached only through `vitest` ->
  `vite` -> `postcss`, so it is a dev-only dependency and never shipped in
  the bot, but it failed the `npm audit --audit-level=high` CI gate on
  every branch.
- Pin transitive dependency `brace-expansion` to 5.0.9 via `overrides`,
  clearing a high-severity DoS advisory (GHSA-rgw5-rvv9-x895) that bypassed
  the CVE-2026-14257 mitigation. Reached only through `eslint` ->
  `minimatch`, so it is a dev-only dependency and never shipped in the bot,
  but it failed the `npm audit --audit-level=high` CI gate on every branch.
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

- `loyalty` plugin: on-disk schema v2. Adds per-viewer `grants` (idempotency
  keys for one-shot and time-bucketed bonuses), `spent`, and `redeemed`
  counters, plus `decisions` and `redemptions` audit journals. These are the shapes the
  upcoming admin-override and redemption commands write to. A version 1 file
  migrates in place with balances intact; the migration is lazy, so a bot that
  starts and earns nothing leaves the file untouched. Before the first v2
  write, the pristine v1 file is copied once to `<dataPath>.v1` and never
  overwritten, so a rollback to a v1 build can recover rather than quarantining
  a file it cannot parse. Grant keys are pruned to the newest 64 per viewer at
  load, except `follow:` keys, which are never pruned. The follow bonus pays
  once ever, so letting its key age out would reopen an unfollow/refollow farm.
- `loyalty` plugin: broadcaster-only balance overrides. `!setESD @user
<amount>` sets a viewer's balance exactly; `!giveESD`/`!takeESD` adjust it
  by an amount, clamped to `[0, MAX_BALANCE]` and reporting when they clamp.
  Each has a matching undo (`!undosetESD`/`!undogiveESD`/`!undotakeESD`) that
  reverses only its own kind's most recent applied change, and reverses it by
  delta rather than restoring an absolute value. Undoing a `!giveESD`
  leaves an intervening `!takeESD` (or earnings since) standing rather than
  discarding it. All six commands are gated on the broadcaster badge alone,
  since every configured broadcaster is assumed to be the operator's own
  channel or persona. See the README for the caveat if a third party's
  channel is ever added. The amount argument accepts a plain decimal integer
  only; arithmetic, scientific notation, hex, and similar are rejected rather
  than partially parsed. Every override and undo is journaled in the same
  atomic write as the balance change it makes, in the `decisions` array added
  by the schema v2 migration above. The `@user` target is resolved via Helix
  (`ctx.helix.getUserByLogin`), so an admin command can target any Twitch
  user, not only one the bot has already seen chat from.
- `loyalty` plugin (v1: earn + balance + leaderboard, no spend/redemption
  yet): viewers passively earn a configurable currency (`esports dollars` by
  default) for chat activity while the channel is live. Every
  `tickIntervalMinutes` (default 5), each chatter who sent at least one
  chat message since the last tick is awarded `dollarsPerTick` (default 1).
  This is a chat-activity proxy, not real Twitch watch-time. The bot has
  no access to the viewer list. `!wallet` reports a balance; `!economy`
  shows the top `leaderboardSize` earners (default 5). All date and time
  handling uses `luxon`, matching `streak`/`followage`/`wentlive`. Reads are rate
  limited to one reply per chatter per channel every `cooldownSeconds`
  (default 10), with broadcasters and moderators exempt. Balances are
  pooled across channels by default (`shareAcrossChannels`). Balances,
  the plugin's config block, and the on-disk pool are all validated at
  runtime against bounded zod schemas.
- `announce` plugin: posts a templated chat message on raid, subscribe, and
  cheer, each independently toggleable with its own template. Cheers below
  `minBits` (default 100) are not announced. Added new normalized
  `raid`/`subscribe`/`cheer` events (`BotEvents`) backed by new
  `channel.raid`/`channel.subscribe`/`channel.cheer` EventSub subscriptions
  in `src/core/twitch.ts`. `channel:read:subscriptions` and `bits:read` were
  added to `BROADCASTER_SCOPES`, so `npm run auth -- --broadcaster <login>`
  now requests them; existing broadcaster tokens are unaffected until
  re-authorized (a missing scope only disables that event's subscription
  and is logged, not a startup failure). A rendered announcement that would
  begin with a chat command sigil (`/` or `.`) is prefixed with a zero-width
  space before sending, so a cheer's free-form message cannot lead the
  message the bot posts with a command. The check runs on the trimmed text,
  since chat strips leading whitespace. A cheer's message is also collapsed
  to a single trimmed line with control characters removed, matching
  `funfact`'s handling of submitted text.
- `quotes` plugin: a curated pool of community quotes persisted under
  `data/`, distinct from `funfact` in that a quote carries an optional
  speaker attribution separate from who added it. Broadcasters (and the
  chatters listed under `treatAsBroadcaster`) add and remove entries with
  `!addquote <text> [- <speaker>]` / `!delquote`; everyone can pull one with
  `!quote`, fetch a specific entry with `!quote <id>`, and check the size
  with `!quotecount`. Reads are rate limited to one reply per chatter per
  channel every `cooldownSeconds` (default 30), with broadcasters and
  moderators exempt. Quotes are pooled across channels by default
  (`shareAcrossChannels`). Submitted text, the plugin's config block, and
  the on-disk pool are all validated at runtime against bounded zod
  schemas; an invalid config field falls back to its default, and an
  invalid curator map falls back to empty so only the broadcaster can
  curate.
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

- `loyalty` plugin: `streamOffline` no longer discards pending tick activity
  on an unverified offline. `event.verified === false` means Twitch
  verification failed and the channel may still be live; treating it as a
  real offline dropped `activeSinceLastTick` unconditionally, costing every
  active chatter up to a full tick of earned dollars for what could be a
  transient verification failure. Absent `verified` is still optimistically
  treated as verified, matching how `streak` already handles this same
  field. Pre-existing since the `loyalty` plugin's initial merge (#42).
- Tests: `!streakset` is pinned to whole-number arguments only. The parser
  already rejected arithmetic, scientific notation, hex, fractions, and
  partial matches, but nothing asserted it. A refactor to `parseInt` would
  have silently accepted `10+5` as 10 and `5abc` as 5, and bare `Number()`
  would have accepted `1e3` as 1000. Behavior is unchanged; the guard is new.
- Tests: `flush()` now drains the event bus instead of sleeping a fixed 10ms,
  so async event handlers are deterministically settled before assertions. The
  delay-only version failed on a loaded CI runner as a wrong assertion rather
  than a timeout, because a handler that had not finished writing left stale
  state for the next assertion to read. The four store tests that fill a pool
  to its cap get an explicit timeout, since that work is I/O-bound rather than
  hung and an aborted run surfaced as a confusing `ENOTEMPTY` from the
  temp-directory cleanup.
- `AtomicJsonFile`: a rename onto a momentarily locked target is retried
  (bounded, with backoff) instead of failing the write. Windows fails rather
  than replaces when anything else holds the target open. Defender, the
  search indexer, or a backup agent caused intermittent `EPERM`
  write failures on Windows only. Errors that are not lock contention still
  fail immediately.
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

## [0.4.0] (2026-07-21)

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

## [0.3.1] (2026-07-21)

### Changed

- Upgrade dev dependency `vitest` from 2.1.9 to 3.2.7, clearing all
  `npm audit` advisories in the vitest/vite/esbuild chain (dev-only;
  production audit was already clean).
- Pin GitHub Actions in CI workflows to full commit SHAs instead of
  mutable tags.

## [0.3.0] (2026-07-21)

### Added

- `streak` plugin: check-ins now pool across every configured broadcaster by
  default (`shareAcrossChannels`, default `true`). This is useful when multiple
  channels belong to the same streamer. Set `shareAcrossChannels: false` to
  keep channels fully independent as before.
- `streak` plugin: check-ins are now anchored to when the current stream
  actually started rather than the wall-clock moment of the check-in
  (`streamSessionHours`, default 18), so a stream that runs past midnight no
  longer splits a viewer's attendance across two different stream days.

## [0.2.1] (2026-07-21)

### Changed

- `streak` plugin: `!streakreset` is now broadcaster only (previously
  broadcaster or moderator). `!streakset` and `!streakopen` are unchanged.

## [0.2.0] (2026-07-20)

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
