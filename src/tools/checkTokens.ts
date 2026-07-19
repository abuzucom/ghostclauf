// Reports which configured accounts (bot, broadcasters) have no token store
// yet, so run.bat can authorize them automatically instead of crashing.
//
// Output: one line per missing account, machine-parsed by run.bat -
//   MISSING BOT
//   MISSING BROADCASTER <login>
// A thrown error (invalid .env / config.yaml) exits non-zero with the message
// on stderr, distinct from "config is fine, tokens are just missing".

import 'dotenv/config';
import { existsSync } from 'node:fs';
import { loadFileConfig, loadSecrets } from '../core/config.js';

function main(): void {
  const file = loadFileConfig();
  const secrets = loadSecrets();

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
