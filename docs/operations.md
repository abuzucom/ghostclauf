# Operations

## Configuration And Authorization

Copy `config.example.yaml` to `config.yaml` and `.env.example` to `.env`.
Keep client secrets only in `.env`. Keep token stores and `data/` readable only
by the bot account and trusted administrators.

Authorize the bot once with `npm run auth -- --bot`. Authorize every configured
broadcaster with `npm run auth -- --broadcaster <login>`. Reauthorize an account
after a missing-scope error, suspected token exposure, or client-secret rotation.

## Multi-Broadcaster Deployments

Each broadcaster has a separate token store. Plugins can pool state across
channels. A pooled store is one administrative trust boundary: a broadcaster
with an administrative command can affect shared state from every pooled
channel. Disable pooling when broadcasters should remain independent.

## Runtime Checks

Use `GET /healthz` to verify that the process is listening. Use `GET /readyz`
for deployment readiness. A ready response requires an active transport and no
revoked broadcaster subscription. Both endpoints bind to loopback by default.

Monitor structured alerts for token refresh failures and EventSub subscription
revocations. Reauthorize the affected account when an alert indicates revoked
access or missing scopes.

## Persistence And Recovery

Plugin JSON files use atomic replacement and retain one `.bak` snapshot. The
snapshot is a recovery aid, not a complete backup. Back up `data/` using
encrypted, access-controlled storage. Preserve file ownership and permissions
when restoring.

Do not edit journals or token stores while the bot is running. Stop the bot,
back up the original file, then investigate malformed or corrupted state. A
store that cannot validate data should fail safely instead of overwriting it.

## Deployments

`run.sh` and `run.bat` rebuild before starting. Docker runs as the non-root
`node` user. The systemd and launchd templates run `node dist/index.js` directly.
Keep the health server loopback-only unless an authenticated reverse proxy
provides the required access controls.

## Incident Response

If a secret or token is exposed, revoke or rotate it first. Reauthorize the
affected account, inspect logs without copying secrets, and review access to
`.env`, token stores, configuration, and mounted volumes. Report product
vulnerabilities through the private process in `security.md`.
