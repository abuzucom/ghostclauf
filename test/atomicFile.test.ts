import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicJsonFile } from '../src/core/atomicFile.js';

/**
 * Lets a test make `rename` report the target as locked. Windows does that
 * when something else holds the file open; POSIX never does, so the retry
 * path is unreachable here without simulating it.
 */
const { renameControl } = vi.hoisted(() => ({
    renameControl: {
        calls: 0,
        failWith: null as null | ((call: number) => Error | null),
    },
}));

vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        rename: async (from: string, to: string) => {
            renameControl.calls += 1;
            const failure = renameControl.failWith?.(renameControl.calls) ?? null;
            if (failure) throw failure;
            return actual.rename(from, to);
        },
    };
});

function lockedError(): Error {
    return Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
}

describe('AtomicJsonFile', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'ghostclauf-atomicfile-'));
        renameControl.calls = 0;
        renameControl.failWith = null;
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('creates the file with no backup on first write', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);

        await file.write('{"a":1}');

        const contents = await readFile(target, 'utf8');
        expect(contents).toBe('{"a":1}');
        await expect(stat(`${target}.bak`)).rejects.toThrow();
    });

    it.runIf(process.platform !== 'win32')(
        'creates the file with owner-only permissions on first write',
        async () => {
            const target = join(dir, 'data.json');
            const file = new AtomicJsonFile(target);

            await file.write('{"a":1}');

            const mode = (await stat(target)).mode & 0o777;
            expect(mode).toBe(0o600);
        },
    );

    it('snapshots the prior contents to .bak on the second write', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);

        await file.write('{"a":1}');
        await file.write('{"a":2}');

        expect(await readFile(target, 'utf8')).toBe('{"a":2}');
        expect(await readFile(`${target}.bak`, 'utf8')).toBe('{"a":1}');
    });

    it.runIf(process.platform !== 'win32')('writes the .bak snapshot as owner-only', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);

        await file.write('{"a":1}');
        await file.write('{"a":2}');

        const bakMode = (await stat(`${target}.bak`)).mode & 0o777;
        expect(bakMode).toBe(0o600);
    });

    it('does not leave temp files behind after writes settle', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);

        await file.write('{"a":1}');
        await file.write('{"a":2}');
        await file.write('{"a":3}');

        const entries = await readdir(dir);
        expect(entries.sort()).toEqual(['data.json', 'data.json.bak']);
    });

    it('leaves the target as one of two concurrent writes, never corrupted', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);

        await Promise.all([file.write('{"a":1}'), file.write('{"a":2}')]);

        const contents = await readFile(target, 'utf8');
        expect(['{"a":1}', '{"a":2}']).toContain(contents);
        expect(() => JSON.parse(contents)).not.toThrow();
    });

    it('auto-creates a missing parent directory', async () => {
        const target = join(dir, 'nested', 'deeper', 'data.json');
        const file = new AtomicJsonFile(target);

        await file.write('{"a":1}');

        expect(await readFile(target, 'utf8')).toBe('{"a":1}');
    });

    it.runIf(process.platform !== 'win32')(
        'auto-creates a missing parent directory at 0700',
        async () => {
            const target = join(dir, 'nested', 'deeper', 'data.json');
            const file = new AtomicJsonFile(target);

            await file.write('{"a":1}');

            const dirMode = (await stat(join(dir, 'nested'))).mode & 0o777;
            expect(dirMode).toBe(0o700);
        },
    );

    it('retries a rename the OS reports as momentarily locked', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);
        renameControl.failWith = (call) => (call <= 2 ? lockedError() : null);

        await file.write('{"a":1}');

        expect(renameControl.calls).toBe(3);
        expect(await readFile(target, 'utf8')).toBe('{"a":1}');
    });

    it('gives up and rethrows once the retries are exhausted', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);
        renameControl.failWith = () => lockedError();

        await expect(file.write('{"a":1}')).rejects.toThrow('EPERM');
        expect(renameControl.calls).toBe(5);
    });

    it('does not retry an error that is not lock contention', async () => {
        const target = join(dir, 'data.json');
        const file = new AtomicJsonFile(target);
        renameControl.failWith = () =>
            Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });

        await expect(file.write('{"a":1}')).rejects.toThrow('ENOSPC');
        expect(renameControl.calls).toBe(1);
    });

    it('markExisting snapshots a file not written by this instance', async () => {
        const target = join(dir, 'data.json');
        await writeFile(target, '{"old":1}', 'utf8');
        const file = new AtomicJsonFile(target);
        file.markExisting();

        await file.write('{"new":2}');

        expect(await readFile(target, 'utf8')).toBe('{"new":2}');
        expect(await readFile(`${target}.bak`, 'utf8')).toBe('{"old":1}');
    });
});
