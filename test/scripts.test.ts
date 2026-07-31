import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const rootDir = join(__dirname, '..');

describe('shell scripts (setup.sh and run.sh)', () => {
    it('setup.sh exists, has LF line endings, and valid POSIX syntax', async () => {
        const path = join(rootDir, 'setup.sh');
        const stats = await stat(path);
        expect(stats.isFile()).toBe(true);

        const content = await readFile(path, 'utf8');
        expect(content).not.toContain('\r\n');
        expect(content.startsWith('#!/bin/sh')).toBe(true);

        if (process.platform !== 'win32') {
            await expect(execFileAsync('bash', ['-n', path])).resolves.not.toThrow();
        }
    });

    it('run.sh exists, has LF line endings, and valid POSIX syntax', async () => {
        const path = join(rootDir, 'run.sh');
        const stats = await stat(path);
        expect(stats.isFile()).toBe(true);

        const content = await readFile(path, 'utf8');
        expect(content).not.toContain('\r\n');
        expect(content.startsWith('#!/bin/sh')).toBe(true);

        if (process.platform !== 'win32') {
            await expect(execFileAsync('bash', ['-n', path])).resolves.not.toThrow();
        }
    });
});
