// One-time OAuth authorization-code flow to mint a bot or broadcaster token.
// The target account is selected with `--bot` or `--broadcaster <login>`.

import 'dotenv/config';
import { createServer } from 'node:http';
import { exchangeCode } from '@twurple/auth';
import { loadFileConfig, loadSecrets } from '../core/config.js';
import { BOT_SCOPES, writeTokenStore } from '../core/auth.js';

async function main(): Promise<void> {
  const file = loadFileConfig();
  const secrets = loadSecrets();
  const target = resolveAuthTarget(file, secrets, process.argv.slice(2));
  const redirect = new URL(secrets.redirectUri);
  const port = Number(redirect.port || '80');

  const authorizeUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  authorizeUrl.searchParams.set('client_id', secrets.clientId);
  authorizeUrl.searchParams.set('redirect_uri', secrets.redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  if (target.scopes.length) authorizeUrl.searchParams.set('scope', target.scopes.join(' '));
  // `force_verify` ensures you can pick the bot account even if already logged in.
  authorizeUrl.searchParams.set('force_verify', 'true');

  await new Promise<void>((resolveDone, rejectDone) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', secrets.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end('Not found');
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error) {
        res
          .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          .end('Authorization failed. Check the terminal.');
        server.close();
        rejectDone(new Error(`authorization denied: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400).end('Missing authorization code.');
        return;
      }

      exchangeCode(secrets.clientId, secrets.clientSecret, code, secrets.redirectUri)
        .then(async (token) => {
          await writeTokenStore(target.tokenStorePath, token);
          res.writeHead(200, { 'content-type': 'text/plain' }).end(
            'Ghostclauf authorized. Token saved — you can close this tab.',
          );
          server.close();
          console.log(`\n✓ Token written to ${target.tokenStorePath}`);
          resolveDone();
        })
        .catch((err: unknown) => {
          res.writeHead(500).end('Token exchange failed. Check the terminal.');
          server.close();
          rejectDone(err instanceof Error ? err : new Error(String(err)));
        });
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`\nGhostclauf — one-time ${target.label} authorization`);
      console.log(`1. Make sure you are logged into Twitch as ${target.label} (${target.login}).`);
      console.log('2. Open this URL in your browser:\n');
      console.log(`   ${authorizeUrl.toString()}\n`);
      console.log(`Waiting for the redirect to ${secrets.redirectUri} ...`);
    });
  });
}

interface AuthTarget {
  label: 'bot' | 'broadcaster';
  login: string;
  tokenStorePath: string;
  scopes: string[];
}

function resolveAuthTarget(
  file: ReturnType<typeof loadFileConfig>,
  secrets: ReturnType<typeof loadSecrets>,
  args: string[],
): AuthTarget {
  const mode = args[0] ?? '--bot';
  if (mode === '--bot') {
    return {
      label: 'bot',
      login: file.bot.login,
      tokenStorePath: secrets.tokenStorePath,
      scopes: BOT_SCOPES,
    };
  }

  const broadcasterLogin = mode === '--broadcaster'
    ? args[1]
    : mode.startsWith('--broadcaster=')
      ? mode.slice('--broadcaster='.length)
      : undefined;
  if (!broadcasterLogin) {
    throw new Error(
      'Usage: npm run auth -- --bot | npm run auth -- --broadcaster <configured-login>',
    );
  }

  const broadcaster = file.broadcasters.find(
    (candidate) => candidate.login.toLowerCase() === broadcasterLogin.toLowerCase(),
  );
  if (!broadcaster) {
    throw new Error(
      `Broadcaster "${broadcasterLogin}" is not configured. ` +
        `Choose one of: ${file.broadcasters.map(({ login }) => login).join(', ')}`,
    );
  }
  return {
    label: 'broadcaster',
    login: broadcaster.login,
    tokenStorePath: broadcaster.tokenStorePath,
    scopes: [],
  };
}

main().catch((err: unknown) => {
  console.error('\nAuthorization failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
