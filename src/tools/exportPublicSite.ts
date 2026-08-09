import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadFileConfig } from '../core/config.js';
import { createPublicSnapshot } from '../publicSite/export.js';

const DEFAULT_FACTS_PATH = './data/funfacts.json';
const DEFAULT_QUOTES_PATH = './data/quotes.json';
const DEFAULT_LOYALTY_PATH = './data/loyalty.json';
const PUBLIC_SITE_DATA_PATH = resolve('site/data/public.json');

function isMissingFile(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
    );
}

async function readOptionalJson(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch (error) {
        if (isMissingFile(error)) return {};
        throw new Error(`Could not read public-site source data at "${path}".`, { cause: error });
    }
}

function resolveDataPath(config: Record<string, unknown>, fallback: string): string {
    return typeof config.dataPath === 'string' && config.dataPath.trim()
        ? config.dataPath
        : fallback;
}

async function main(): Promise<void> {
    const config = loadFileConfig();
    const pluginConfig = config.plugins.config;
    const funFactsPath = resolveDataPath(pluginConfig.funfact ?? {}, DEFAULT_FACTS_PATH);
    const quotesPath = resolveDataPath(pluginConfig.quotes ?? {}, DEFAULT_QUOTES_PATH);
    const loyaltyConfig = pluginConfig.loyalty ?? {};
    const loyaltyPath = resolveDataPath(loyaltyConfig, DEFAULT_LOYALTY_PATH);
    const currencyName =
        typeof loyaltyConfig.currencyName === 'string'
            ? loyaltyConfig.currencyName
            : 'esports dollars';
    const [funFacts, quotes, loyalty] = await Promise.all([
        readOptionalJson(funFactsPath),
        readOptionalJson(quotesPath),
        readOptionalJson(loyaltyPath),
    ]);
    const snapshot = createPublicSnapshot({
        currencyName,
        generatedAt: new Date(),
        funFacts,
        quotes,
        loyalty,
    });
    await mkdir(dirname(PUBLIC_SITE_DATA_PATH), { recursive: true });
    await writeFile(PUBLIC_SITE_DATA_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.info(`Wrote public snapshot to ${PUBLIC_SITE_DATA_PATH}. Review it before committing.`);
}

main().catch((error: unknown) => {
    console.error('Public-site export failed:', error instanceof Error ? error.message : error);
    process.exit(1);
});
