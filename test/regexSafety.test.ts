import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const rootDir = join(__dirname, '..');
const PYTHON_TIMEOUT_MS = 10_000;

async function runPython(script: string): Promise<void> {
    await execFileAsync('python', ['-c', script, rootDir], {
        cwd: rootDir,
        timeout: PYTHON_TIMEOUT_MS,
    });
}

const importModule = String.raw`
import importlib.util
import pathlib
import sys

sys.dont_write_bytecode = True
root = pathlib.Path(sys.argv[1])
def load(name, relative_path):
    spec = importlib.util.spec_from_file_location(name, root / relative_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
`;

describe('regex safety', () => {
    it('parses long malformed co-author trailers in bounded time', async () => {
        const script = `${importModule}
module = load("check_banned_agents", "scripts/check_banned_agents.py")
commit = {
    "sha": "abc",
    "author_name": "person",
    "author_email": "person@example.com",
    "committer_name": "person",
    "committer_email": "person@example.com",
    "body": "Co-authored-by:" + " " * 60000,
}
module.find_violations([commit])
commit["body"] = "Co-authored-by: xAI Bot <bot@x.ai>"
assert module.find_violations([commit])
`;
        await expect(runPython(script)).resolves.toBeUndefined();
    });

    it('checks long whitespace-only documentation lines in bounded time', async () => {
        const script = `${importModule}
module = load("check_hedging", "scripts/check_hedging.py")
module.find_violations(" " * 60000, "AGENTS.md")
assert module.tutorial_start("  // First, validate input")
`;
        await expect(runPython(script)).resolves.toBeUndefined();
    });

    it('checks long malformed short flags in bounded time', async () => {
        const script = `${importModule}
module = load("block_destructive_bash", "hooks/block_destructive_bash.py")
module.find_reason("rm -" + "r" * 60000 + "!")
assert module.find_reason("rm -rf /")
assert not module.find_reason("rm -rrrr!")
`;
        await expect(runPython(script)).resolves.toBeUndefined();
    });

    it('checks long runtime-root comments in bounded time', async () => {
        const script = `${importModule}
module = load("check_dockerfile_root", "scripts/check_dockerfile_root.py")
text = "FROM node\\n" + "# runtime-root:" * 60000
module.find_violations(text, "Dockerfile")
approved = "FROM node\\n# runtime-root: this container needs root (Rule 12 exception)."
assert not module.find_violations(approved, "Dockerfile")
`;
        await expect(runPython(script)).resolves.toBeUndefined();
    });

    it('checks long credential exception comments in bounded time', async () => {
        const script = `${importModule}
module = load("check_persist_credentials", "scripts/check_persist_credentials.py")
text = "# persist-credentials: true:" * 60000 + "\\n- uses: actions/checkout@v4"
module.find_violations(text, "workflow.yml")
approved = "# persist-credentials: true: this job pushes tags (Rule 11 exception).\\n- uses: actions/checkout@v4"
assert not module.find_violations(approved, "workflow.yml")
`;
        await expect(runPython(script)).resolves.toBeUndefined();
    });
});
