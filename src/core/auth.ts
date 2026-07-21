import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RefreshingAuthProvider } from '@twurple/auth';
import type { AccessToken } from '@twurple/auth';
import { z } from 'zod';
import type { BroadcasterConfig, Secrets } from './config.js';
import type { Logger } from './types.js';

/** Scopes the bot account must grant. See README for broadcaster-side setup. */
export const BOT_SCOPES = ['user:read:chat', 'user:write:chat', 'user:bot'];

/** Scopes each broadcaster account must grant. */
export const BROADCASTER_SCOPES = [
  'moderator:read:followers',
  'moderator:manage:shoutouts',
];

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
  validateToken(botToken, 'bot', BOT_SCOPES, 'npm run auth -- --bot');
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
    account: 'bot' | 'broadcaster',
    intents?: string[],
    loadedToken?: AccessToken,
    authCommand = 'npm run auth -- --bot',
  ): Promise<string> => {
    const existingUserId = userIdsByTokenPath.get(tokenPath);
    if (existingUserId) return existingUserId;

    const initialToken = loadedToken ?? (await readTokenStore(tokenPath, authCommand));
    pendingTokenPath = tokenPath;
    try {
      let userId: string;
      try {
        userId = await authProvider.addUserForToken(initialToken, intents);
      } catch (error) {
        throw new Error(
          `${account} token could not be validated. Run \`${authCommand}\` again.`,
          { cause: error },
        );
      }
      userIdsByTokenPath.set(tokenPath, userId);
      logger.info({ account, userId, scopes: initialToken.scope }, 'Twitch authorization loaded');
      tokenPathsByUserId.set(userId, tokenPath);
      return userId;
    } finally {
      pendingTokenPath = undefined;
    }
  };

  // `chat` intent marks the bot user as the sender/reader for chat operations.
  const botUserId = await addToken(secrets.tokenStorePath, 'bot', ['chat'], botToken);
  const broadcasterUserIds: string[] = [];
  for (const broadcaster of broadcasters) {
    broadcasterUserIds.push(
      await addToken(
        broadcaster.tokenStorePath,
        'broadcaster',
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
  try {
    return AccessTokenSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      `Token store at "${path}" is invalid or corrupted. ` +
        `Run \`${authCommand}\` to re-authorize this account.`,
    );
  }
}

function validateToken(
  token: AccessToken,
  account: string,
  requiredScopes: readonly string[],
  authCommand: string,
): void {
  const missingScopes = requiredScopes.filter((scope) => !token.scope.includes(scope));
  if (missingScopes.length) {
    throw new Error(
      `${account} token is missing required scopes: ${missingScopes.join(', ')}. ` +
        `Run \`${authCommand}\` to authorize them.`,
    );
  }
}

/** Mirrors twurple's AccessToken so malformed stores fail here with guidance
 *  instead of as confusing twurple errors later. */
const AccessTokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  scope: z.array(z.string()),
  expiresIn: z.number().nullable(),
  obtainmentTimestamp: z.number(),
});

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
