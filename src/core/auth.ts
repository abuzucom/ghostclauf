import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RefreshingAuthProvider } from '@twurple/auth';
import type { AccessToken } from '@twurple/auth';
import type { BroadcasterConfig, Secrets } from './config.js';
import type { Logger } from './types.js';

/** Scopes the bot account must grant. See README for broadcaster-side setup. */
export const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];
const TOKEN_STORE_MODE = 0o600;

/**
 * Build a RefreshingAuthProvider for the bot and broadcaster accounts from
 * persisted tokens, auto-persisting refreshed tokens back to disk.
 *
 * Returns the provider plus the bot's resolved user id (needed to subscribe to
 * chat and to send messages). Throws with guidance if no token exists yet.
 */
export async function createAuthProvider(
  secrets: Secrets,
  logger: Logger,
  broadcasters: readonly BroadcasterConfig[] = [],
): Promise<{
  authProvider: RefreshingAuthProvider;
  botUserId: string;
  broadcasterUserIds: string[];
}> {
  const botToken = await readTokenStore(secrets.tokenStorePath);
  const authProvider = new RefreshingAuthProvider({
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
  });

  const userIdsByTokenPath = new Map<string, string>();
  const tokenPathsByUserId = new Map<string, string>();
  let pendingTokenPath: string | undefined;
  authProvider.onRefresh(async (userId, newToken) => {
    const tokenPath = tokenPathsByUserId.get(userId) ?? pendingTokenPath;
    if (!tokenPath) {
      logger.warn({ userId }, 'token refreshed but its token store path is unknown');
      return;
    }
    await writeTokenStore(tokenPath, newToken);
    logger.debug({ userId }, 'access token refreshed and persisted');
  });
  authProvider.onRefreshFailure((userId, error) => {
    logger.error({ userId, err: error }, 'token refresh failed; re-run `npm run auth`');
  });

  const addToken = async (
    tokenPath: string,
    intents?: string[],
    loadedToken?: AccessToken,
    authCommand = 'npm run auth -- --bot',
  ): Promise<string> => {
    const existingUserId = userIdsByTokenPath.get(tokenPath);
    if (existingUserId) return existingUserId;

    const initialToken = loadedToken ?? (await readTokenStore(tokenPath, authCommand));
    pendingTokenPath = tokenPath;
    try {
      const userId = await authProvider.addUserForToken(initialToken, intents);
      userIdsByTokenPath.set(tokenPath, userId);
      tokenPathsByUserId.set(userId, tokenPath);
      return userId;
    } finally {
      pendingTokenPath = undefined;
    }
  };

  // `chat` intent marks the bot user as the sender/reader for chat operations.
  const botUserId = await addToken(secrets.tokenStorePath, ['chat'], botToken);
  const broadcasterUserIds: string[] = [];
  for (const broadcaster of broadcasters) {
    broadcasterUserIds.push(
      await addToken(
        broadcaster.tokenStorePath,
        undefined,
        undefined,
        `npm run auth -- --broadcaster ${broadcaster.login}`,
      ),
    );
  }

  return { authProvider, botUserId, broadcasterUserIds };
}

export async function readTokenStore(
  path: string,
  authCommand = 'npm run auth -- --bot',
): Promise<AccessToken> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `No token store at "${path}". Run \`${authCommand}\` once to authorize this account.`,
    );
  }
  return JSON.parse(raw) as AccessToken;
}

export async function writeTokenStore(path: string, token: AccessToken): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await chmod(path, TOKEN_STORE_MODE);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  await writeFile(path, JSON.stringify(token, null, 2), {
    encoding: 'utf8',
    mode: TOKEN_STORE_MODE,
  });
  await chmod(path, TOKEN_STORE_MODE);
}
