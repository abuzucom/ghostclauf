import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFileConfig, loadSecrets } from '../src/core/config.js';

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config');

const validEnv = {
  TWITCH_CLIENT_ID: 'client-id',
  TWITCH_CLIENT_SECRET: 'client-secret',
};

describe('loadFileConfig', () => {
  it('throws a friendly error when the file does not exist', () => {
    expect(() => loadFileConfig(join(fixturesRoot, 'does-not-exist.yaml'))).toThrow(
      /Copy config.example.yaml/,
    );
  });

  it('throws when the YAML is syntactically malformed', () => {
    expect(() => loadFileConfig(join(fixturesRoot, 'malformed.yaml'))).toThrow();
    // Distinguish from the schema-violation path: a raw parse error, not our custom message.
    expect(() => loadFileConfig(join(fixturesRoot, 'malformed.yaml'))).not.toThrow(
      /Invalid config/,
    );
  });

  it('throws with formatted zod issues when broadcaster.login is missing', () => {
    expect(() => loadFileConfig(join(fixturesRoot, 'missing-login.yaml'))).toThrow(
      /Invalid config/,
    );
    expect(() => loadFileConfig(join(fixturesRoot, 'missing-login.yaml'))).toThrow(
      /broadcaster.login/,
    );
  });

  it('applies chat and plugins defaults when omitted', () => {
    const config = loadFileConfig(join(fixturesRoot, 'minimal.yaml'));
    expect(config.chat).toEqual({ commandPrefix: '!' });
    expect(config.plugins).toEqual({
      directories: ['./dist/plugins'],
      disabled: [],
      config: {},
    });
  });

  it('normalizes multiple broadcasters and preserves the first-channel alias', () => {
    const config = loadFileConfig(join(fixturesRoot, 'multi.yaml'));

    expect(config.broadcasters).toEqual([
      { login: 'first_channel', tokenStorePath: './data/first-channel-tokens.json' },
      { login: 'second_channel', tokenStorePath: './data/second-channel-tokens.json' },
    ]);
    expect(config.broadcaster).toEqual(config.broadcasters[0]);
  });
});

describe('loadSecrets', () => {
  it('throws when TWITCH_CLIENT_ID is missing', () => {
    const { TWITCH_CLIENT_ID, ...env } = validEnv;
    expect(() => loadSecrets(env)).toThrow(/TWITCH_CLIENT_ID/);
  });

  it('throws when TWITCH_CLIENT_SECRET is missing', () => {
    const { TWITCH_CLIENT_SECRET, ...env } = validEnv;
    expect(() => loadSecrets(env)).toThrow(/TWITCH_CLIENT_SECRET/);
  });

  it('applies TOKEN_STORE_PATH and AUTH_REDIRECT_URI defaults when omitted', () => {
    const secrets = loadSecrets(validEnv);
    expect(secrets.tokenStorePath).toBe('./data/tokens.json');
    expect(secrets.redirectUri).toBe('http://localhost:3000/callback');
  });

  it('throws when AUTH_REDIRECT_URI is not a valid URL', () => {
    expect(() => loadSecrets({ ...validEnv, AUTH_REDIRECT_URI: 'not-a-url' })).toThrow();
  });

  it('maps env keys onto the camelCase Secrets shape', () => {
    const secrets = loadSecrets({
      ...validEnv,
      TOKEN_STORE_PATH: './custom/tokens.json',
      AUTH_REDIRECT_URI: 'http://example.com/callback',
    });
    expect(secrets).toEqual({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      tokenStorePath: './custom/tokens.json',
      redirectUri: 'http://example.com/callback',
    });
  });
});
