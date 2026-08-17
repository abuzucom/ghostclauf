# Tracking abuzucom/agents upstream

`AGENTS.md` and its compliance tooling (checkers, hooks, CI workflows,
pre-commit hooks, `Makefile` targets) were adopted from
[`abuzucom/agents`](https://github.com/abuzucom/agents), a portable
AI-agent-instructions template repo, and tailored to this repo's own
architecture and rules. See the README "AGENTS.md compliance checks" and
"Claude Code hooks" sections for what that tooling does day to day.
This document is for the next reintegration: what maps to what, where this
repo intentionally diverges from upstream, and how to bring in a future
upstream update.

Prior syncs: v1.7.0 (commit `b27101b`, "reintegrate abuzucom/agents"),
v1.10.0 (commit `257fe14`, "sync AGENTS.md conventions with abuzucom/agents
v1.10.0"), v1.11.0 (this sync, "sync AGENTS.md conventions with
abuzucom/agents v1.11.0").

## Sync mechanism

`AGENTS.md` is this repo's canonical source. `scripts/sync.py` (`make sync` /
`make check`) propagates it byte-identical to `CLAUDE.md`, `GEMINI.md`,
`CONVENTIONS.md`, `.cursorrules`, `.clinerules`, `.windsurfrules`,
`.copilot-instructions`, and `.github/copilot-instructions.md`. Upstream's
own repo works the same way. A reintegration is therefore a three-way
comparison: upstream's version as of the last sync, upstream's current
version, and this repo's tailored `AGENTS.md`. Diff upstream's `CHANGELOG.md`
between those two versions to find what changed; do not diff the rule text
directly, since this repo's copy already differs from upstream's (see the
mapping table below) and a direct diff conflates upstream's changes with
this repo's existing tailoring.

## File mapping

| Upstream                                                                     | This repo                                    | Status                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md` rule text                                                        | `AGENTS.md` (source) + 8 mirrors             | Tailored: repo-specific sections (Commands, Do not touch, Architecture, Public Site, Banned agents, Read before touching, Handoff) added; upstream's generic rule text carried close to verbatim                                                |
| `scripts/check_banned_agents.py`                                             | `scripts/check_banned_agents.py`             | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_branch_name.py`                                               | `scripts/check_branch_name.py`               | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_commit_message.py`                                            | `scripts/check_commit_message.py`            | Tailored: this repo's copy also skips merge commits (upstream's does not); tracks upstream's blocking/warning-only choice otherwise                                                                                                             |
| `scripts/check_persist_credentials.py`                                       | `scripts/check_persist_credentials.py`       | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_weak_hashing.py`                                              | `scripts/check_weak_hashing.py`              | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_dockerfile_root.py`                                           | `scripts/check_dockerfile_root.py`           | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_secrets_heuristic.py`                                         | `scripts/check_secrets_heuristic.py`         | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_ascii.py`                                                     | `scripts/check_ascii.py`                     | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_us_spelling.py`                                               | `scripts/check_us_spelling.py`               | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_english_only.py`                                              | `scripts/check_english_only.py`              | Verbatim                                                                                                                                                                                                                                        |
| `scripts/check_hedging.py`                                                   | `scripts/check_hedging.py`                   | Verbatim                                                                                                                                                                                                                                        |
| `scripts/lint_style.py`                                                      | (not adopted)                                | This repo's `check_ascii.py` covers the same ground and is what's actually wired in                                                                                                                                                             |
| `scripts/check_public_site.py`                                               | `scripts/check_public_site.py`               | This repo only; not from upstream, has no upstream counterpart                                                                                                                                                                                  |
| `hooks/block_destructive_bash.py`, `hooks/claude-code-settings.example.json` | same paths                                   | Verbatim, but wired active in `.claude/settings.json` (upstream ships the example inactive)                                                                                                                                                     |
| `hooks/enforce_branch_name.py`                                               | `hooks/enforce_branch_name.py`               | Verbatim, wired active in `.claude/settings.json` (`SessionStart` + `PreToolUse`); supersedes this repo's own undocumented `hooks/check_branch_name_session_start.py`, see decision log                                                         |
| `tests/test_enforce_branch_name.py`                                          | `tests/test_enforce_branch_name.py`          | Verbatim; new root-level `tests/` directory, distinct from this repo's existing `test/` (singular, Vitest TypeScript suite)                                                                                                                     |
| `plan/HANDOFF.md.example`                                                    | `plan/HANDOFF.md.example`                    | Verbatim, adopted                                                                                                                                                                                                                               |
| `CONTRIBUTING.md.example`                                                    | `CONTRIBUTING.md.example`                    | Adopted; install/test/lint placeholders filled with this repo's actual commands (`npm install`, `npm test`, `npm run lint`)                                                                                                                     |
| `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE.md`              | same paths                                   | Verbatim, adopted live (issue template's "Python version" line changed to "Node version", matching this repo's stack)                                                                                                                           |
| `SECURITY.md.example`                                                        | `security.md`                                | Not adopted: this repo's hand-written policy predates and exceeds the upstream skeleton template                                                                                                                                                |
| `.github/workflows/agents-compliance.yml` (reusable `workflow_call`)         | (not adopted)                                | This repo keeps a tailored copy-and-tailor workflow instead of consuming the reusable one; see decision log                                                                                                                                     |
| `.github/workflows/agents-md-compliance.yml` / `agents-compliance.yml`       | `.github/workflows/agents-md-compliance.yml` | Tailored: kept as a standalone 4-job workflow (banned-agents, branch-name, commit-message, static-checks) instead of upstream's thin-caller-of-reusable-workflow shape; picked up upstream's `concurrency` group and `ready_for_review` trigger |
| `.github/workflows/sync-check.yml`                                           | `.github/workflows/agents-sync.yml`          | Tailored: same purpose (verify the 9 mirror files match and lint `AGENTS.md`'s style), different name; no AgentLint step                                                                                                                        |
| AgentLint (`0xmariowu/AgentLint`)                                            | (not adopted)                                | Third-party dependency, declined                                                                                                                                                                                                                |
| `.pre-commit-config.yaml`                                                    | `.pre-commit-config.yaml`                    | Same shape as upstream's (which itself has not changed since v1.7.0): no pre-commit hook for `check_hedging.py` or the new template files, CI-only                                                                                              |
| README "Versioning" section                                                  | (not adopted)                                | Only relevant to a repo whose CI other repos consume via `uses:`; this repo is a consumer of `abuzucom/agents`, not a template distributor                                                                                                      |

## Decision log

Points where this repo's copy intentionally diverges from upstream. Do not
"fix" these back to upstream's default in a future sync without asking the
user first; they were deliberate calls, not oversights.

- **`security.md` instead of `SECURITY.md.example`.** This repo's policy
  document predates the upstream template and is more detailed. Adopting
  the upstream skeleton would be a downgrade, not an addition.
- **No reusable `agents-compliance.yml` workflow-call architecture.** This
  repo's `agents-md-compliance.yml` static-checks job already diverges from
  upstream's version (scans `security.md` not `SECURITY.md.example`, has no
  AgentLint step, has a separate `check_public_site.py` workflow).
  Switching to `uses: ./.github/workflows/agents-compliance.yml` would mean
  losing those or forking the reusable workflow anyway, which defeats the
  point of using it. Kept the tailored copy; ported the cheap hygiene wins
  from the reusable workflow instead (concurrency groups, `ready_for_review`
  trigger).
- **No AgentLint.** Third-party GitHub Action, a new dependency requiring
  authorization under Rule 9, and grants `pull-requests: write`. Declined
  as of this sync.
- **`github.actor != 'dependabot[bot]'` instead of upstream's
  `github.event.pull_request.user.login != 'dependabot[bot]'`.**
  Functionally equivalent for PR-triggered jobs (both key off the PR's
  author). Not worth the mechanical churn of switching.
- **`check_commit_message.py` skips merge commits**, which upstream's copy
  does not do. Predates this sync (see CHANGELOG's "Updated the
  commit-message checker to skip generated merge commits" entry); carried
  forward when porting upstream's blocking-to-warning-only change.
- **Superseded local branch-name hook.** This repo had independently built
  `hooks/check_branch_name_session_start.py` (`SessionStart`-only, no
  blocking) after the v1.10.0 sync, wired into `.claude/settings.json`, but
  it was never documented in this file's mapping table, had no README
  section, and had no test coverage. The v1.11.0 sync replaces it with
  upstream's `hooks/enforce_branch_name.py`, which adds the `PreToolUse`
  blocking half and the test suite this repo was missing.
- **Claude-Code-session branches.** Upstream's branch-naming rule bans
  `claude/`-prefixed branches outright, with no platform exemption, because
  upstream's own workflow never creates them. This repo's own commits and
  PRs are made on compliant `feat/`/`fix/`/`chore/`/`docs/`/`test/` branches,
  never on the platform-assigned `claude/...` branch a Claude Code session
  may start on, so no exemption was needed when adopting the rule verbatim.
  If that assumption ever changes (a workflow starts opening PRs directly
  from a `claude/...` branch), revisit this rule and its CI enforcement
  before it silently fails those PRs.

## Reintegration checklist (for the next upstream update)

1. Clone `abuzucom/agents` and read its `CHANGELOG.md` from the entry after
   this repo's last-synced version (see "Prior syncs" above).
2. Sort each changelog entry into one of these categories, and handle each
   accordingly:

- **Core rule text** (a new or changed `AGENTS.md` rule): port into this
  repo's `AGENTS.md`, adapting wording only where it conflicts with a
  section this repo already tailored, then run `make sync` and `make check`.
- **New checker backing a rule**: port the script and wire it at the same
  strictness upstream uses. If upstream changed an _existing_ checker's
  strictness (blocking to warning-only or the reverse), that changes current
  enforcement in this repo; ask the user before applying it, don't apply it
  silently.
- **New optional template**: upstream itself frames these as "propose to the
  user first" (see its own Adopting-section prose); do the same here.
- **New third-party dependency or Action**: needs explicit user
  authorization before inclusion (Rule 9), regardless of how upstream frames
  it (advisory-only, pinned tag, etc.).
- **Anything touching branch naming, commit format, or CI trigger
  conditions**: check for conflicts with how this repo's PRs actually get
  created (for example, platform-assigned agent branch names) before
  adopting verbatim. See the decision-log entry above for the current state
  of that check.

3. After applying changes, update this file's mapping table and decision
   log, add a "Prior syncs" entry with the new commit/PR reference, and run
   `make agents-lint` plus the full verification suite in the README's
   "AGENTS.md compliance checks" section before opening a PR.
