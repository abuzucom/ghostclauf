import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RefreshingAuthProvider } from '@twurple/auth';
import type { AccessToken } from '@twurple/auth';
import type { Secrets } from './config.js';
import type { Logger } from './types.js';

/** Scopes the bot account must grant. See README for broadcaster-side setup. */
export const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];

/**
 * Build a RefreshingAuthProvider for the bot account from a persisted token,
 * auto-persisting refreshed tokens back to disk.
 *
 * Returns the provider plus the bot's resolved user id (needed to subscribe to
 * chat and to send messages). Throws with guidance if no token exists yet.
 */
export async function createAuthProvider(
  secrets: Secrets,
  logger: Logger,
): Promise<{ authProvider: RefreshingAuthProvider; botUserId: string }> {
  const initialToken = await readTokenStore(secrets.tokenStorePath);

  const authProvider = new RefreshingAuthProvider({
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
  });

  authProvider.onRefresh(async (userId, newToken) => {
    await writeTokenStore(secrets.tokenStorePath, newToken);
    logger.debug({ userId }, 'access token refreshed and persisted');
  });
  authProvider.onRefreshFailure((userId, error) => {
    logger.error({ userId, err: error }, 'token refresh failed; re-run `npm run auth`');
  });

  // `chat` intent marks this user as the sender/reader for chat operations.
  const botUserId = await authProvider.addUserForToken(initialToken, ['chat']);
  return { authProvider, botUserId };
}

export async function readTokenStore(path: string): Promise<AccessToken> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No token store at "${path}". Run \`npm run auth\` once to authorize the bot account.`,
    );
  }
  return JSON.parse(raw) as AccessToken;
}

export async function writeTokenStore(path: string, token: AccessToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(token, null, 2), 'utf8');
}
