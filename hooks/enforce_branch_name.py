#!/usr/bin/env python3
"""Enforce the branch-naming convention through Claude Code hooks.

Not part of AGENTS.md, which stays tool-agnostic and is synced to non-Claude
tools verbatim. This is a Claude-Code-specific hook under hooks/, wired via
`.claude/settings.json` (live in this repo) or
hooks/claude-code-settings.example.json (for adopting repos). One file serves
two hook events, dispatched on `hook_event_name` in the stdin payload:

`SessionStart` runs scripts/check_branch_name.py against the checked-out
branch before the session does any git work, and on a violation injects a
stop-and-rename instruction into the session context via `additionalContext`.
Claude Code ignores a non-zero exit from a SessionStart hook, so injected
context is the only lever that event has.

`PreToolUse` on the `Bash` matcher is the blocking half: it exits 2 (blocking,
per Claude Code's PreToolUse contract) on a `git commit` or `git push` while
the branch name is non-conforming, so a session that reads the warning and
proceeds anyway still cannot land the branch.

The two events cover a harness-assigned branch name, which the model cannot
choose and, being stateless across sessions, cannot remember to fix. Renaming
the branch (`git branch -m <type>/<kebab-description>`) clears both.
"""
import json
import os
import re
import subprocess
import sys

CHECKER_PATH = os.path.join("scripts", "check_branch_name.py")
ALLOWED_PREFIXES = "feat/, fix/, chore/, docs/, test/"
BLOCKED_COMMANDS = (
    (r"\bgit\s+commit\b", "git commit"),
    (r"\bgit\s+push\b", "git push"),
)


def _read_payload() -> dict:
    """Return the hook's stdin JSON, or an empty dict when stdin carries none."""
    try:
        raw = sys.stdin.read()
    except (OSError, ValueError):
        return {}
    try:
        return json.loads(raw)
    except ValueError:
        return {}


def _project_dir(payload: dict) -> str:
    """Return the repository root, preferring Claude Code's own variable."""
    return os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()


def find_violation(project_dir: str) -> str:
    """Return the checker's complaint about the current branch, or an empty string.

    An absent checker yields an empty string: a repo that has not copied
    scripts/check_branch_name.py has no convention for this hook to enforce.
    """
    checker = os.path.join(project_dir, CHECKER_PATH)
    if not os.path.isfile(checker):
        return ""
    result = subprocess.run(
        [sys.executable, checker],
        cwd=project_dir,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode == 0:
        return ""
    return result.stderr.strip() or "branch name does not match the convention"


def build_warning(violation: str) -> str:
    """Return the session-context text for a non-conforming branch."""
    return "\n".join(
        (
            "STOP: BRANCH NAME VIOLATION. DO NOT COMMIT, PUSH, OR OPEN A PR YET.",
            "",
            violation,
            "",
            "AGENTS.md bans this branch name, and CI runs",
            "scripts/check_branch_name.py on every pull request. A branch name",
            "assigned by the harness or a task description is not an exception:",
            "the rule takes precedence, and a PR opened from this branch fails.",
            "",
            "Take one of these two actions before any commit or push:",
            f"1. Rename the branch to match <type>/<kebab-description> ({ALLOWED_PREFIXES}):",
            "   git branch -m <type>/<kebab-description>",
            "2. Ask the user for explicit sign-off to keep the current name.",
            "",
            "A PreToolUse hook blocks git commit and git push until the name",
            "conforms, so proceeding without one of those two actions fails.",
        )
    )


def blocked_command(command: str) -> str:
    """Return the git write operation found in `command`, or an empty string."""
    for pattern, label in BLOCKED_COMMANDS:
        if re.search(pattern, command):
            return label
    return ""


def _handle_session_start(project_dir: str) -> int:
    """Inject a stop-and-rename instruction into the session context."""
    violation = find_violation(project_dir)
    if not violation:
        return 0
    warning = build_warning(violation)
    output = {
        "hookSpecificOutput": {
            "hookEventName": "SessionStart",
            "additionalContext": warning,
        },
        "systemMessage": warning,
    }
    print(json.dumps(output))
    return 0


def _handle_pre_tool_use(payload: dict, project_dir: str) -> int:
    """Block a commit or push while the branch name breaks the convention."""
    if payload.get("tool_name") != "Bash":
        return 0
    command = payload.get("tool_input", {}).get("command", "")
    label = blocked_command(command)
    if not label:
        return 0
    violation = find_violation(project_dir)
    if not violation:
        return 0
    print(
        f"blocked by hooks/enforce_branch_name.py: {label} on a non-conforming branch.\n"
        f"{violation}\n"
        f"Rename the branch first (git branch -m <type>/<kebab-description>, one of "
        f"{ALLOWED_PREFIXES}), or get the user's explicit sign-off to keep this name.",
        file=sys.stderr,
    )
    return 2


def main() -> int:
    payload = _read_payload()
    project_dir = _project_dir(payload)
    event = payload.get("hook_event_name", "SessionStart")
    if event == "PreToolUse":
        return _handle_pre_tool_use(payload, project_dir)
    return _handle_session_start(project_dir)


if __name__ == "__main__":
    sys.exit(main())
