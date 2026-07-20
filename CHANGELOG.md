# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
