// Interactively collects real Twitch logins for the bot and each broadcaster
// and writes them into config.yaml, replacing the config.example.yaml
// placeholders. Typing a login into the `npm run auth` prompt never updated
// config.yaml on its own - this closes that gap.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';

const PLACEHOLDER_LOGIN = /^your[_-].*login$/i;

async function main(): Promise<void> {
  const path = process.env.CONFIG_PATH ?? './config.yaml';
  const raw = readFileSync(path, 'utf8');
  const doc = parseDocument(raw);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    await promptLogin(doc, rl, ['bot', 'login'], 'Bot account');

    const broadcasters = doc.get('broadcasters');
    if (isYamlSeq(broadcasters)) {
      for (let i = 0; i < broadcasters.items.length; i += 1) {
        await promptLogin(doc, rl, ['broadcasters', i, 'login'], `Broadcaster ${i + 1}`);
      }
    } else {
      await promptLogin(doc, rl, ['broadcaster', 'login'], 'Broadcaster');
    }
  } finally {
    rl.close();
  }

  writeFileSync(path, String(doc), 'utf8');
  console.log(`\nSaved ${path}`);
}

function isYamlSeq(value: unknown): value is { items: unknown[] } {
  return typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items);
}

async function promptLogin(
  doc: Document,
  rl: ReturnType<typeof createInterface>,
  keyPath: (string | number)[],
  label: string,
): Promise<void> {
  const current = doc.getIn(keyPath);
  const currentValue = typeof current === 'string' ? current : '';
  const isPlaceholder = PLACEHOLDER_LOGIN.test(currentValue);
  const promptText = isPlaceholder
    ? `${label} Twitch login: `
    : `${label} Twitch login [${currentValue}, press Enter to keep]: `;
  const answer = (await rl.question(promptText)).trim();
  if (answer) {
    doc.setIn(keyPath, answer);
  } else if (isPlaceholder) {
    throw new Error(`${label} login is required.`);
  }
}

main().catch((err: unknown) => {
  console.error('\nFailed to update config.yaml:', err instanceof Error ? err.message : err);
  process.exit(1);
});
