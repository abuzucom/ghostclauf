import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const execFileAsync = promisify(execFile);
const rootDir = join(__dirname, '..');

// Git records the executable bit as mode 100755; a Windows checkout cannot
// report it through the filesystem, so read it back from the index instead.
const GIT_EXECUTABLE_MODE = '100755';

async function gitIndexMode(fileName: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['ls-files', '--stage', '--', fileName], {
        cwd: rootDir,
    });
    return stdout.trim().split(' ')[0] ?? '';
}

describe.each(['setup.sh', 'run.sh', 'publish-site.sh'])('shell script %s', (fileName) => {
    const path = join(rootDir, fileName);

    it('exists with LF line endings and a POSIX shebang', async () => {
        const stats = await stat(path);
        expect(stats.isFile()).toBe(true);

        const content = await readFile(path, 'utf8');
        expect(content).not.toContain('\r\n');
        expect(content.startsWith('#!/bin/sh')).toBe(true);
    });

    it('has valid POSIX syntax', async () => {
        if (process.platform === 'win32') return;
        await expect(execFileAsync('bash', ['-n', path])).resolves.not.toThrow();
    });

    // The README tells operators to run "./setup.sh"; without the committed
    // executable bit a fresh clone fails with "Permission denied".
    it('is committed as executable', async () => {
        expect(await gitIndexMode(fileName)).toBe(GIT_EXECUTABLE_MODE);
    });

    it('is executable in the working tree', async () => {
        if (process.platform === 'win32') return;
        const stats = await stat(path);
        expect(stats.mode & 0o111).toBeGreaterThan(0);
    });
});

describe('public-site scripts', () => {
    it('exports and validates the public snapshot before publishing', async () => {
        const shellScript = await readFile(join(rootDir, 'publish-site.sh'), 'utf8');
        const batchScript = await readFile(join(rootDir, 'publish-site.bat'), 'utf8');

        expect(shellScript.startsWith('#!/bin/sh')).toBe(true);
        expect(shellScript).not.toContain('\r\n');
        if (process.platform !== 'win32') {
            await expect(
                execFileAsync('bash', ['-n', join(rootDir, 'publish-site.sh')]),
            ).resolves.not.toThrow();
        }
        for (const command of ['npm run export:public', 'npm run lint:site']) {
            expect(shellScript).toContain(command);
            expect(batchScript).toContain(command);
        }
        expect(shellScript).toContain('scripts/check_public_site.py');
        expect(batchScript).toContain('scripts\\check_public_site.py');
    });
});

interface WorkflowJob {
    permissions?: Record<string, string> | string;
    steps?: Array<{ run?: string }>;
}

interface Workflow {
    permissions?: Record<string, string> | string;
    jobs: Record<string, WorkflowJob>;
}

async function loadWorkflows(): Promise<Array<[string, Workflow]>> {
    const dir = join(rootDir, '.github', 'workflows');
    const names = (await readdir(dir)).filter((name) => name.endsWith('.yml'));
    return Promise.all(
        names.map(async (name): Promise<[string, Workflow]> => [
            name,
            parseYaml(await readFile(join(dir, name), 'utf8')) as Workflow,
        ]),
    );
}

/** True when a permissions block grants a write scope that can publish or mint tokens. */
function grantsDeployScope(permissions: WorkflowJob['permissions']): boolean {
    if (typeof permissions !== 'object') return false;
    return permissions['id-token'] === 'write' || permissions.pages === 'write';
}

describe('Actions permission policy', () => {
    it('declares a top-level permissions block in every workflow', async () => {
        for (const [name, workflow] of await loadWorkflows()) {
            expect(workflow.permissions, name).toBeDefined();
        }
    });

    it('never installs npm packages in a job that can deploy or mint OIDC tokens', async () => {
        // An install script from a compromised dependency would otherwise run
        // with the job's deploy and id-token permissions.
        for (const [name, workflow] of await loadWorkflows()) {
            for (const [jobName, job] of Object.entries(workflow.jobs)) {
                const permissions = job.permissions ?? workflow.permissions;
                if (!grantsDeployScope(permissions)) continue;
                const installs = (job.steps ?? []).filter((step) =>
                    /\bnpm (ci|install)\b/.test(step.run ?? ''),
                );
                expect(installs, `${name} job ${jobName}`).toEqual([]);
            }
        }
    });
});

describe('Actions storage policy', () => {
    it('does not create npm caches for platform smoke jobs', async () => {
        const workflow = await readFile(join(rootDir, '.github', 'workflows', 'ci.yml'), 'utf8');
        const smokeStart = workflow.indexOf('    platform-smoke:');
        const smokeEnd = workflow.indexOf('    docker:', smokeStart);
        const smokeJob = workflow.slice(smokeStart, smokeEnd);

        expect(smokeStart).toBeGreaterThanOrEqual(0);
        expect(smokeEnd).toBeGreaterThan(smokeStart);
        expect(smokeJob).not.toContain('cache: npm');
    });

    it('publishes Scorecard SARIF without a redundant Actions artifact', async () => {
        const workflow = await readFile(
            join(rootDir, '.github', 'workflows', 'scorecard.yml'),
            'utf8',
        );

        expect(workflow).toContain('github/codeql-action/upload-sarif@');
        expect(workflow).not.toContain('actions/upload-artifact@');
    });
});
