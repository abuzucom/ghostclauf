import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccessToken } from '@twurple/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthProvider, readTokenStore, writeTokenStore } from '../src/core/auth.js';
import type { Secrets } from '../src/core/config.js';
import { makeSpyLogger } from './helpers.js';

const { constructorSpy, addUserForTokenSpy } = vi.hoisted(() => ({
  constructorSpy: vi.fn(),
  addUserForTokenSpy: vi.fn(),
}));

vi.mock('@twurple/auth', () => {
  class MockRefreshingAuthProvider {
    onRefresh = vi.fn();
    onRefreshFailure = vi.fn();
    addUserForToken = addUserForTokenSpy;
    constructor(config: unknown) {
      constructorSpy(config);
    }
  }
  return { RefreshingAuthProvider: MockRefreshingAuthProvider };
});

/** The real `onRefresh`/`onRefreshFailure`/`addUserForToken` types aren't mocks;
 *  narrow to the mocked shape installed by the `vi.mock('@twurple/auth', ...)` above. */
interface MockedRefreshingAuthProvider {
  onRefresh: ReturnType<typeof vi.fn>;
  onRefreshFailure: ReturnType<typeof vi.fn>;
  addUserForToken: ReturnType<typeof vi.fn>;
}

function asMocked(provider: unknown): MockedRefreshingAuthProvider {
  return provider as unknown as MockedRefreshingAuthProvider;
}

const sampleToken: AccessToken = {
  accessToken: 'access-123',
  refreshToken: 'refresh-123',
  scope: ['chat:read'],
  expiresIn: 3600,
  obtainmentTimestamp: 1_700_000_000_000,
};

describe('readTokenStore / writeTokenStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghostclauf-auth-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates missing parent directories and round-trips through readTokenStore', async () => {
    const path = join(dir, 'nested', 'deeper', 'tokens.json');
    await writeTokenStore(path, sampleToken);
    await expect(readTokenStore(path)).resolves.toEqual(sampleToken);
  });

  it('writes pretty-printed JSON', async () => {
    const path = join(dir, 'tokens.json');
    await writeTokenStore(path, sampleToken);
    const raw = await readFile(path, 'utf8');
    expect(raw).toBe(JSON.stringify(sampleToken, null, 2));
  });

  it('throws guidance to run npm run auth when the file is missing', async () => {
    const path = join(dir, 'missing.json');
    await expect(readTokenStore(path)).rejects.toThrow(/npm run auth/);
  });
});

describe('createAuthProvider', () => {
  let dir: string;
  let tokenStorePath: string;
  let secrets: Secrets;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ghostclauf-auth-'));
    tokenStorePath = join(dir, 'tokens.json');
    secrets = {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenStorePath,
      redirectUri: 'http://localhost:3000/callback',
    };
    constructorSpy.mockClear();
    addUserForTokenSpy.mockReset().mockResolvedValue('bot-user-id');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the token store and resolves botUserId from addUserForToken', async () => {
    await writeTokenStore(tokenStorePath, sampleToken);
    const spy = makeSpyLogger();

    const { authProvider, botUserId } = await createAuthProvider(secrets, spy.logger);

    expect(botUserId).toBe('bot-user-id');
    expect(asMocked(authProvider).addUserForToken).toHaveBeenCalledWith(sampleToken, ['chat']);
  });

  it('fails fast with the token-store error before constructing a RefreshingAuthProvider', async () => {
    const spy = makeSpyLogger();
    await expect(createAuthProvider(secrets, spy.logger)).rejects.toThrow(/npm run auth/);
    expect(constructorSpy).not.toHaveBeenCalled();
  });

  it('onRefresh persists the new token to disk', async () => {
    await writeTokenStore(tokenStorePath, sampleToken);
    const spy = makeSpyLogger();

    const { authProvider } = await createAuthProvider(secrets, spy.logger);
    const onRefreshHandler = asMocked(authProvider).onRefresh.mock.calls[0][0] as (
      userId: string,
      token: AccessToken,
    ) => Promise<void>;

    const refreshedToken: AccessToken = { ...sampleToken, accessToken: 'refreshed-456' };
    await onRefreshHandler('bot-user-id', refreshedToken);

    await expect(readTokenStore(tokenStorePath)).resolves.toEqual(refreshedToken);
  });

  it('onRefreshFailure logs an error via the injected logger', async () => {
    await writeTokenStore(tokenStorePath, sampleToken);
    const spy = makeSpyLogger();

    const { authProvider } = await createAuthProvider(secrets, spy.logger);
    const onRefreshFailureHandler = asMocked(authProvider).onRefreshFailure.mock.calls[0][0] as (
      userId: string,
      error: Error,
    ) => void;

    const refreshError = new Error('refresh failed');
    onRefreshFailureHandler('bot-user-id', refreshError);

    expect(spy.error).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'bot-user-id', err: refreshError }),
      'token refresh failed; re-run `npm run auth`',
    );
  });

  it('loads broadcaster token stores in addition to the bot token', async () => {
    await writeTokenStore(tokenStorePath, sampleToken);
    const broadcasterTokenPath = join(dir, 'broadcaster-tokens.json');
    await writeTokenStore(broadcasterTokenPath, sampleToken);
    const spy = makeSpyLogger();
    addUserForTokenSpy
      .mockResolvedValueOnce('bot-user-id')
      .mockResolvedValueOnce('broadcaster-user-id');

    const { authProvider, broadcasterUserIds } = await createAuthProvider(
      secrets,
      spy.logger,
      [{ login: 'streamer', tokenStorePath: broadcasterTokenPath }],
    );
    expect(asMocked(authProvider).addUserForToken).toHaveBeenCalledTimes(2);
    expect(broadcasterUserIds).toEqual(['broadcaster-user-id']);
  });
});
