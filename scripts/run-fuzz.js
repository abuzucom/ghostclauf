#!/usr/bin/env node
/**
 * Run every Jazzer.js fuzz target under fuzz/ for a bounded time.
 *
 * Usage:
 *   node scripts/run-fuzz.js [--max-total-time=60]
 *
 * Requires `npm run build` first so dist/ exists, because Jazzer.js CLI does
 * not directly execute TypeScript targets.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_MAX_TOTAL_TIME = '60';

function parseMaxTotalTime() {
    const explicit = process.argv.find((arg) => arg.startsWith('--max-total-time='));
    if (explicit) return explicit.slice('--max-total-time='.length);
    const index = process.argv.indexOf('--max-total-time');
    if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
    return DEFAULT_MAX_TOTAL_TIME;
}

const maxTotalTime = parseMaxTotalTime();
const fuzzDir = join(__dirname, '..', 'fuzz');
const corpusDir = join(__dirname, '..', 'corpus');
const jazzerCli = join(__dirname, '..', 'node_modules', '@jazzer.js', 'core', 'dist', 'cli.js');

const targets = readdirSync(fuzzDir)
    .filter((name) => name.endsWith('.fuzz.js'))
    .sort();

if (targets.length === 0) {
    console.error('no fuzz targets found in fuzz/');
    process.exit(1);
}

let failures = 0;

for (const target of targets) {
    const targetPath = join(fuzzDir, target);
    const corpus = join(corpusDir, target.replace('.fuzz.js', ''));
    mkdirSync(corpus, { recursive: true });
    console.log(`\n--- fuzzing ${target} ---`);
    const result = spawnSync(
        process.execPath,
        [jazzerCli, targetPath, '-i', 'dist/', corpus, '--', '-max_total_time=' + maxTotalTime],
        { stdio: 'inherit', shell: false },
    );
    if (result.status !== 0 && result.status !== null) {
        failures += 1;
    }
}

process.exit(failures > 0 ? 1 : 0);
