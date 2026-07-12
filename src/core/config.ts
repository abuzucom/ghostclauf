import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ── File config (config.yaml) — non-secret ──────────────────────────────────
const FileConfigSchema = z.object({
  broadcaster: z.object({
    login: z.string().min(1),
  }),
  bot: z.object({
    login: z.string().min(1),
  }),
  chat: z
    .object({
      commandPrefix: z.string().min(1).default('!'),
    })
    .default({ commandPrefix: '!' }),
  plugins: z
    .object({
      directories: z.array(z.string()).default(['./dist/plugins']),
      enabled: z.array(z.string()).default([]),
      config: z.record(z.record(z.unknown())).default({}),
    })
    .default({ directories: ['./dist/plugins'], enabled: [], config: {} }),
});

export type FileConfig = z.infer<typeof FileConfigSchema>;

// ── Secrets (environment) ───────────────────────────────────────────────────
const SecretsSchema = z.object({
  TWITCH_CLIENT_ID: z.string().min(1, 'TWITCH_CLIENT_ID is required'),
  TWITCH_CLIENT_SECRET: z.string().min(1, 'TWITCH_CLIENT_SECRET is required'),
  TOKEN_STORE_PATH: z.string().min(1).default('./data/tokens.json'),
  AUTH_REDIRECT_URI: z.string().url().default('http://localhost:3000/callback'),
});

export interface Secrets {
  clientId: string;
  clientSecret: string;
  tokenStorePath: string;
  redirectUri: string;
}

export interface AppConfig {
  file: FileConfig;
  secrets: Secrets;
}

/** Load and validate the file config only (used by tests and the app). */
export function loadFileConfig(path: string = process.env.CONFIG_PATH ?? './config.yaml'): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `Could not read config file at "${path}". Copy config.example.yaml to config.yaml ` +
        `(or set CONFIG_PATH).`,
    );
  }
  const parsed = FileConfigSchema.safeParse(parseYaml(raw) ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid config "${path}":\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Load and validate secrets from the environment. */
export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const parsed = SecretsSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${formatIssues(parsed.error)}`);
  }
  return {
    clientId: parsed.data.TWITCH_CLIENT_ID,
    clientSecret: parsed.data.TWITCH_CLIENT_SECRET,
    tokenStorePath: parsed.data.TOKEN_STORE_PATH,
    redirectUri: parsed.data.AUTH_REDIRECT_URI,
  };
}

/** Load the full application config (file + secrets). */
export function loadConfig(): AppConfig {
  return { file: loadFileConfig(), secrets: loadSecrets() };
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}
