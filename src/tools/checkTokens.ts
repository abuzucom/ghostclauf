// Reports which configured accounts (bot, broadcasters) still have
// config.example.yaml placeholder logins, or have no token store yet, so
// run.bat can fix config.yaml and authorize automatically instead of
// crashing at runtime with "broadcaster ... not found on Twitch".
//
// Output: one line per issue, machine-parsed by run.bat -
//   PLACEHOLDER LOGIN
//   MISSING BOT
//   MISSING BROADCASTER <login>
// PLACEHOLDER LOGIN is reported at most once and takes priority: run.bat
// resolves it (via configureAccounts) before re-checking for missing tokens,
// since a placeholder login means the token check below can't be trusted yet.
// A thrown error (invalid .env / config.yaml) exits non-zero with the message
// on stderr, distinct from "config is fine, just needs logins or tokens".

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { loadFileConfig, loadSecrets } from '../core/config.js';

const PLACEHOLDER_LOGIN = /^your[_-].*login$/i;

function main(): void {
  const file = loadFileConfig();
  const secrets = loadSecrets();

  const hasPlaceholderLogin =
    PLACEHOLDER_LOGIN.test(file.bot.login) ||
    file.broadcasters.some((broadcaster) => PLACEHOLDER_LOGIN.test(broadcaster.login));
  if (hasPlaceholderLogin) {
    console.log('PLACEHOLDER LOGIN');
    return;
  }

  if (!existsSync(secrets.tokenStorePath)) {
    console.log('MISSING BOT');
  }
  for (const broadcaster of file.broadcasters) {
    if (!existsSync(broadcaster.tokenStorePath)) {
      console.log(`MISSING BROADCASTER ${broadcaster.login}`);
    }
  }
}

main();
