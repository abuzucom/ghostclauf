# Security Policy

## Scope

This document describes the security architecture, defensive controls, threat
model, and vulnerability disclosure process for ghostclauf.

The policy applies to the ghostclauf source tree, the built bot, the built-in
plugins, and the core Twitch transport. It does not make the host operating
system, Docker host, Twitch, third-party plugins, or configured local services
secure by itself.

## Architecture

ghostclauf is a Node.js 20+ TypeScript application with an ESM runtime. The
startup path is:

1. Load and validate non-secret `config.yaml` and secret environment variables.
2. Load and validate the bot and broadcaster OAuth token stores.
3. Discover and initialize configured plugins.
4. Start the Twitch EventSub WebSocket and Helix transport.
5. Dispatch normalized events to plugins and gate chat commands by role.

The main security boundaries are:

- `src/core/auth.ts` owns OAuth providers, token validation, refresh, and token
  persistence.
- `src/core/twitch.ts` is the only module that imports Twurple. It owns the
  EventSub WebSocket, Helix calls, broadcaster identity checks, and chat sends.
- `src/core/permissions.ts` maps Twitch badges to the small role set used by
  command allow-lists.
- `src/core/commands.ts` applies command prefix matching and permission gates
  before invoking handlers.
- Plugins receive the narrow `BotContext` contract. They do not receive raw
  Twurple clients or OAuth credentials.
- `src/core/healthServer.ts` exposes liveness and readiness endpoints. It binds
  to `127.0.0.1` by default; configuring another host intentionally exposes
  operational data to that network.

Configured plugins are executable code, not data. Plugin directories must
therefore be treated as trusted code locations. The default discovery behavior
loads every discovered plugin unless an explicit allow-list or disabled list is
configured.

## Protected Assets

The primary assets are:

- Twitch client secrets and OAuth access and refresh tokens.
- Twitch account identities and configured channel relationships.
- Persisted viewer logins, IDs, display names, streaks, quotes, facts, and
  loyalty balances.
- Administrative command state and audit journals.
- Operational logs and readiness metrics.
- The integrity and availability of chat behavior and plugin state.

Tokens and secrets are credentials. They must never be committed, pasted into
public issues, or included in logs, bug reports, screenshots, or crash dumps.

## Defense Posture

### Credentials and OAuth

- Secrets are loaded from the environment. `.env`, `config.yaml`, token stores,
  and runtime data are excluded from version control.
- Bot and broadcaster tokens are checked for shape and required scopes at
  startup. Missing or invalid tokens fail with reauthorization guidance.
- OAuth callbacks bind to loopback and use a cryptographically random state
  value checked with a timing-safe comparison.
- The configured redirect URI must match the Twitch application registration.
- Token refreshes are persisted automatically. Token files are written with
  owner-only permissions (`0600`); operators must also restrict the containing
  directory and any mounted volume.
- The transport verifies that configured logins, resolved Twitch identities, and
  OAuth token identities match before connecting.

### Authorization and Isolation

- Commands declare an allow-list of roles. Unauthorized commands are rejected
  before their handlers run.
- Broadcaster-only administrative commands rely on the Twitch broadcaster
  badge. Treat every broadcaster in a shared pool as an equally trusted
  administrator when cross-channel sharing is enabled.
- Plugin handlers and event subscribers are isolated from one another by error
  handling. A broken plugin is logged and skipped rather than taking down the
  bot.
- Plugins access platform functionality through `BotContext`, which limits the
  public extension surface and keeps OAuth credentials in the core.

### Input, Output, and Availability

- Configuration, token stores, plugin configuration, and persisted plugin data
  are schema-validated or bounded before use.
- Twitch login values are restricted to Twitch's login character set before
  they are passed to authorization tooling.
- Chat sends use per-channel and global rate limits, a bounded queue, and the
  Twitch message length limit.
- Plugin and command cooldowns limit chat-triggered work and Helix usage.
- User-submitted content is normalized and bounded by the relevant plugin. Chat
  output that could begin with a command sigil is guarded by the applicable
  plugin logic.
- JSON state is written through temporary files and replacement renames, with a
  previous backup retained where supported. This reduces corruption after a
  crash but is not a backup or an access-control boundary.
- EventSub reconnect and token failure conditions are observable through
  structured logs, counters, and readiness status.

### Supply Chain and Operations

- Runtime and development dependencies are pinned in `package.json` and the
  lockfile. High and critical dependency audit findings are intended to fail
  CI.
- GitHub Actions are pinned to commit SHAs, and Dependabot is configured for
  update proposals.
- The systemd service template applies restrictions including
  `NoNewPrivileges`, `ProtectSystem`, `ProtectHome`, restricted address
  families, and a limited writable path.
- The health server is loopback-only by default. Do not expose it externally
  without an authenticated, access-controlled reverse proxy or equivalent
  network controls.

## Threat Model

The design considers the following threats:

- **Credential theft:** a local user, backup process, container peer, leaked log,
  or committed secret obtains a client secret or OAuth token.
- **OAuth authorization attacks:** an attacker attempts to inject or replay an
  authorization callback or causes the operator to authorize the wrong Twitch
  account.
- **Privilege escalation:** a chatter attempts to invoke broadcaster or
  moderator commands without the corresponding Twitch role, or a trusted
  operator configures a shared channel pool with an untrusted broadcaster.
- **Command and content abuse:** chatters flood commands, consume Helix or chat
  budgets, store unbounded content, or cause bot output to be interpreted as a
  command.
- **Plugin compromise:** a malicious or tampered plugin executes with the
  privileges of the bot process or abuses the context exposed to plugins.
- **State corruption:** a crash, concurrent write, malformed file, or partial
  update damages persisted viewer or administrative state.
- **Dependency or build compromise:** a vulnerable package, mutable CI action,
  or modified build input reaches a deployment.
- **Operational exposure:** a network-exposed health endpoint leaks metrics, or
  a weakly protected host, volume, service account, or Docker configuration
  exposes local data.
- **Twitch or network failure:** EventSub revocation, API errors, reconnects, or
  rate limits cause missed events or degraded availability.

The following are outside the application's control and are not assumed to be
prevented by these controls:

- A compromised host, container runtime, operator account, or deployment
  pipeline.
- Compromise of Twitch accounts, Twitch infrastructure, or the configured Twitch
  application.
- Intentional behavior by a plugin that the operator has chosen to install and
  enable.
- Denial of service against Twitch, the host, the network, or a local service.
- Unauthorized access caused by exposing token stores, `.env`, `config.yaml`,
  or the health server through operator configuration.

## Operator Responsibilities

Operators must:

- Keep `.env`, `config.yaml`, token stores, and `data/` readable only by the bot
  account and trusted administrators.
- Use a dedicated least-privilege service account and keep the host, Node.js,
  Docker image, dependencies, and deployment tooling updated.
- Review every plugin before placing it in a configured plugin directory. Prefer
  `plugins.enabled` as an explicit allow-list for deployments with external
  plugins.
- Treat shared-channel configuration as one administrative trust boundary.
- Keep `AUTH_REDIRECT_URI` exact and use the loopback callback for the one-time
  local authorization flow.
- Never expose `/readyz` publicly without compensating access controls.
- Revoke and reauthorize affected Twitch tokens and rotate the Twitch client
  secret if either is suspected to be exposed.
- Keep encrypted, access-controlled backups of important plugin state. The
  `.bak` files maintained by the application are recovery snapshots, not secure
  backups.

## Responsible Disclosure

### Reporting

Report suspected vulnerabilities privately through GitHub Security Advisories:

<https://github.com/abuzucom/ghostclauf/security/advisories/new>

Do not open a public issue for an unpatched vulnerability. If the report itself
contains a secret, token, personal data, or other sensitive material, do not
include the material. Revoke or rotate exposed credentials first when possible,
then describe the exposure privately.

Include:

- A concise description and security impact.
- Affected version, commit, package, configuration, or deployment mode.
- Reproduction steps or a minimal proof of concept.
- Preconditions, required permissions, and the expected versus observed
  behavior.
- Sanitized logs, stack traces, or screenshots when they clarify the issue.
- A preferred contact method for follow-up.

### Research Rules

Researchers should:

- Test only installations and accounts they own or have explicit permission to
  assess.
- Avoid accessing, modifying, or exfiltrating other users' data.
- Avoid disrupting Twitch channels, bot availability, OAuth services, or
  production deployments.
- Avoid spam, destructive commands, credential attacks, social engineering,
  and tests against third-party infrastructure.
- Stop testing after the issue is demonstrated and provide the smallest useful
  proof of concept.

The maintainers will assess reports, communicate through the private advisory,
and coordinate remediation and public disclosure when appropriate. No fixed
response or remediation time is promised. Please allow reasonable time for a
fix before public disclosure.

## Security Updates

Security fixes and material changes to this policy are recorded in
[`CHANGELOG.md`](CHANGELOG.md). Operators should review dependency and release
updates before deploying them.
