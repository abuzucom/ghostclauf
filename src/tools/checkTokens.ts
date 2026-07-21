// Reports which configured accounts (bot, broadcasters) still have
// config.example.yaml placeholder logins, have no token store yet, or have a
// token missing a required scope - so run.bat can fix config.yaml and
// (re-)authorize automatically instead of crashing at runtime.
//
// Output: one line per issue, machine-parsed by run.bat:
//   PLACEHOLDER LOGIN
//   MISSING BOT
//   MISSING BROADCASTER <login>
// PLACEHOLDER LOGIN is reported at most once and takes priority: run.bat
// resolves it (via configureAccounts) before re-checking for missing tokens.
// MISSING BOT covers "bot token exists but is missing a required scope" - the
// fix is the same: re-run `npm run auth -- --bot`, which overwrites the store.
// MISSING BROADCASTER covers "token absent OR missing a required scope".
// A thrown error (invalid .env / config.yaml) exits non-zero with the message
// on stderr, distinct from "config is fine, just needs logins or tokens".

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { BOT_SCOPES, BROADCASTER_SCOPES, readTokenStore } from '../core/auth.js';
import { loadFileConfig, loadSecrets } from '../core/config.js';

const PLACEHOLDER_LOGIN = /^your[_-].*login$/i;

async function main(): Promise<void> {
  const file = loadFileConfig();
  const secrets = loadSecrets();

  const hasPlaceholderLogin =
    PLACEHOLDER_LOGIN.test(file.bot.login) ||
    file.broadcasters.some((broadcaster) => PLACEHOLDER_LOGIN.test(broadcaster.login));
  if (hasPlaceholderLogin) {
    console.log('PLACEHOLDER LOGIN');
    return;
  }

  if (await botTokenNeedsReauth(secrets.tokenStorePath)) {
    console.log('MISSING BOT');
  }
  for (const broadcaster of file.broadcasters) {
    if (await broadcasterTokenNeedsReauth(broadcaster.tokenStorePath)) {
      console.log(`MISSING BROADCASTER ${broadcaster.login}`);
    }
  }
}

async function botTokenNeedsReauth(tokenStorePath: string): Promise<boolean> {
  return tokenNeedsReauth(tokenStorePath, BOT_SCOPES);
}

/** True when the token store is absent, unreadable, or missing a scope. */
async function tokenNeedsReauth(
  tokenStorePath: string,
  requiredScopes: readonly string[],
): Promise<boolean> {
  if (!existsSync(tokenStorePath)) return true;
  try {
    const token = await readTokenStore(tokenStorePath);
    return !requiredScopes.every((scope) => token.scope.includes(scope));
  } catch {
    return true;
  }
}

/** True if the broadcaster token is absent or missing any required scope. */
async function broadcasterTokenNeedsReauth(tokenStorePath: string): Promise<boolean> {
  if (!existsSync(tokenStorePath)) return true;
  try {
    const token = await readTokenStore(tokenStorePath);
    return !BROADCASTER_SCOPES.every((scope) => token.scope.includes(scope));
  } catch {
    return true;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
