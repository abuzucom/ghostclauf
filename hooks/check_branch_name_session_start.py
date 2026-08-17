#!/usr/bin/env python3
"""Warn loudly at session start when the branch fails this repo's naming rule.

A Claude Code SessionStart hook, opt-in only, wired via a project or user
`settings.json` (see hooks/claude-code-settings.example.json), same as
hooks/block_destructive_bash.py. Runs scripts/check_branch_name.py against
the current branch before any work happens in the session and, on a
mismatch, injects a warning into the session's context via
`hookSpecificOutput.additionalContext` (SessionStart's documented context
channel) telling the assistant to stop and get the branch renamed before
committing or pushing, instead of letting CI catch it after a PR is already
open.

Exists because a session-assigned branch name (e.g. a harness-provided
`claude/<slug>` branch for Claude Code Remote/on the web) can conflict with
this repo's own <type>/<kebab-description> convention, and relying on the
assistant to remember to check has not worked: repeated sessions read the
convention in CLAUDE.md, started work on a non-conforming assigned branch
anyway, and only discovered the CI failure after opening a PR. This hook
does not block session startup (SessionStart hooks cannot); it makes the
conflict impossible to miss instead.
"""
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CHECK_SCRIPT = REPO_ROOT / "scripts" / "check_branch_name.py"


def build_warning(violation: str) -> str:
    """Return the context message injected when the branch name fails."""
    return (
        "STOP BEFORE ANY COMMIT OR PUSH: the current git branch fails this "
        f"repo's branch-naming check.\n\n{violation}\n\n"
        "This repo's CI (scripts/check_branch_name.py, run by "
        ".github/workflows/agents-md-compliance.yml) rejects this branch "
        "name and will fail any pull request opened from it. A "
        "session-assigned branch name does not override this repo's own "
        "convention from CLAUDE.md/AGENTS.md. Before making any commit or "
        "push: create or switch to a branch with an allowed prefix (feat/, "
        "fix/, chore/, docs/, test/), or stop and get the user's explicit "
        "sign-off to proceed anyway. Do not silently work on this branch "
        "and discover the failure later via CI."
    )


def main() -> int:
    result = subprocess.run(
        [sys.executable, str(CHECK_SCRIPT)],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        check=False,
    )
    if result.returncode == 0:
        print("{}")
        return 0

    violation = (result.stdout + result.stderr).strip()
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "SessionStart",
                    "additionalContext": build_warning(violation),
                }
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
