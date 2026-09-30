// Interactively collects real Twitch logins for the bot and each broadcaster
// and writes them into config.yaml, replacing the config.example.yaml
// placeholders. Typing a login into the `npm run auth` prompt never updated
// config.yaml on its own - this closes that gap.

import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { writeFileAtomic } from '../core/atomicFile.js';
import { isPlaceholderLogin, normalizeLoginAnswer } from '../core/logins.js';

/** Invalid answers allowed per account before giving up. */
const MAX_LOGIN_ATTEMPTS = 3;
const PERMISSION_BITS = 0o777;
const LOGIN_RULE = 'A Twitch login is 1-25 letters, digits, or underscores.';

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

    // Atomic so an interrupted save cannot truncate config.yaml; keep the
    // file's existing permissions.
    await writeFileAtomic(path, String(doc), statSync(path).mode & PERMISSION_BITS);
    console.log(`\nSaved ${path}`);
}

function isYamlSeq(value: unknown): value is { items: unknown[] } {
    return (
        typeof value === 'object' &&
        value !== null &&
        Array.isArray((value as { items?: unknown }).items)
    );
}

async function promptLogin(
    doc: Document,
    rl: ReturnType<typeof createInterface>,
    keyPath: (string | number)[],
    label: string,
): Promise<void> {
    const current = doc.getIn(keyPath);
    const currentValue = typeof current === 'string' ? current : '';
    const isPlaceholder = isPlaceholderLogin(currentValue);
    const promptText = isPlaceholder
        ? `${label} Twitch login: `
        : `${label} Twitch login [${currentValue}, press Enter to keep]: `;
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
        const answer = (await rl.question(promptText)).trim();
        if (!answer) {
            if (isPlaceholder) throw new Error(`${label} login is required.`);
            return;
        }
        const login = normalizeLoginAnswer(answer);
        if (login) {
            doc.setIn(keyPath, login);
            return;
        }
        console.log(LOGIN_RULE);
    }
    throw new Error(`${label} login is not a valid Twitch login. ${LOGIN_RULE}`);
}

main().catch((err: unknown) => {
    console.error('\nFailed to update config.yaml:', err instanceof Error ? err.message : err);
    process.exit(1);
});
