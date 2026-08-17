#!/usr/bin/env python3
"""Tests for hooks/enforce_branch_name.py and its wiring.

Runs the hook as a subprocess against synthetic Claude Code payloads, the
same path the harness uses, rather than asserting on mocks. Branch names
come from `GITHUB_HEAD_REF`, which scripts/check_branch_name.py reads before
falling back to `git rev-parse`, so results do not depend on which branch
the test run happens to be on.

The settings tests guard the wiring: a hook nobody registered enforces
nothing, and an edit to `.claude/settings.json` that drops an event would
otherwise pass every behavioral test in this file.
"""
import importlib.util
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
HOOK_PATH = REPO_ROOT / "hooks" / "enforce_branch_name.py"
LIVE_SETTINGS = REPO_ROOT / ".claude" / "settings.json"
EXAMPLE_SETTINGS = REPO_ROOT / "hooks" / "claude-code-settings.example.json"
CHECKER_PATH = REPO_ROOT / "scripts" / "check_branch_name.py"

VIOLATING_BRANCH = "claude/session-start-hook-branch-check-5b33fv"
CONFORMING_BRANCH = "feat/session-start-branch-check"
BLOCKING_EXIT_CODE = 2


def _load_hook_module():
    """Import the hook by path, since hooks/ is not an importable package."""
    spec = importlib.util.spec_from_file_location("enforce_branch_name", HOOK_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


hook = _load_hook_module()


def run_hook(payload, branch: str) -> subprocess.CompletedProcess:
    """Run the hook as the harness does: JSON on stdin, branch from the env."""
    environment = dict(os.environ)
    environment["GITHUB_HEAD_REF"] = branch
    environment["CLAUDE_PROJECT_DIR"] = str(REPO_ROOT)
    return subprocess.run(
        [sys.executable, str(HOOK_PATH)],
        input=json.dumps(payload) if payload is not None else "",
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


def bash_payload(command: str) -> dict:
    """Return a PreToolUse payload for a Bash tool call."""
    return {
        "hook_event_name": "PreToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": command},
    }


def session_start_payload() -> dict:
    """Return a SessionStart payload."""
    return {
        "hook_event_name": "SessionStart",
        "source": "startup",
        "cwd": str(REPO_ROOT),
    }


class CheckerContractTest(unittest.TestCase):
    """The rule the hook enforces, verified against the checker itself."""

    def test_claude_prefix_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(CHECKER_PATH), VIOLATING_BRANCH],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn(VIOLATING_BRANCH, result.stderr)

    def test_conforming_prefixes_are_accepted(self):
        for branch in ("feat/a-b", "fix/a-b", "chore/a-b", "docs/a-b", "test/a-b"):
            with self.subTest(branch=branch):
                result = subprocess.run(
                    [sys.executable, str(CHECKER_PATH), branch],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


class SessionStartTest(unittest.TestCase):
    """SessionStart informs; it never blocks, since Claude Code ignores its exit."""

    def test_violation_injects_context_and_exits_zero(self):
        result = run_hook(session_start_payload(), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        specific = output["hookSpecificOutput"]
        self.assertEqual(specific["hookEventName"], "SessionStart")
        self.assertIn(VIOLATING_BRANCH, specific["additionalContext"])
        self.assertIn("STOP", specific["additionalContext"])
        self.assertIn("git branch -m", specific["additionalContext"])
        self.assertEqual(output["systemMessage"], specific["additionalContext"])

    def test_conforming_branch_stays_silent(self):
        result = run_hook(session_start_payload(), CONFORMING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")

    def test_missing_event_name_defaults_to_session_start(self):
        result = run_hook({"cwd": str(REPO_ROOT)}, VIOLATING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)
        output = json.loads(result.stdout)
        self.assertEqual(output["hookSpecificOutput"]["hookEventName"], "SessionStart")

    def test_empty_stdin_exits_zero(self):
        result = run_hook(None, CONFORMING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_malformed_stdin_exits_zero(self):
        result = subprocess.run(
            [sys.executable, str(HOOK_PATH)],
            input="not json",
            capture_output=True,
            text=True,
            env={**os.environ, "GITHUB_HEAD_REF": CONFORMING_BRANCH},
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


class PreToolUseTest(unittest.TestCase):
    """PreToolUse is the blocking half: exit 2 stops the tool call."""

    def test_commit_on_violating_branch_is_blocked(self):
        result = run_hook(bash_payload('git commit -m "feat: x"'), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, BLOCKING_EXIT_CODE)
        self.assertIn("git commit", result.stderr)
        self.assertIn(VIOLATING_BRANCH, result.stderr)
        self.assertIn("git branch -m", result.stderr)

    def test_push_on_violating_branch_is_blocked(self):
        result = run_hook(bash_payload("git push -u origin HEAD"), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, BLOCKING_EXIT_CODE)
        self.assertIn("git push", result.stderr)

    def test_commit_on_conforming_branch_is_allowed(self):
        result = run_hook(bash_payload('git commit -m "feat: x"'), CONFORMING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_push_on_conforming_branch_is_allowed(self):
        result = run_hook(bash_payload("git push -u origin HEAD"), CONFORMING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rename_command_is_never_blocked(self):
        result = run_hook(bash_payload("git branch -m feat/x"), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_read_only_git_command_is_allowed(self):
        for command in ("git status", "git log --oneline -5", "git branch --show-current"):
            with self.subTest(command=command):
                result = run_hook(bash_payload(command), VIOLATING_BRANCH)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_non_git_command_is_allowed(self):
        result = run_hook(bash_payload("ls -la"), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_non_bash_tool_is_ignored(self):
        payload = {
            "hook_event_name": "PreToolUse",
            "tool_name": "Read",
            "tool_input": {"file_path": "/tmp/x"},
        }
        result = run_hook(payload, VIOLATING_BRANCH)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_chained_command_containing_push_is_blocked(self):
        result = run_hook(bash_payload("make lint && git push"), VIOLATING_BRANCH)
        self.assertEqual(result.returncode, BLOCKING_EXIT_CODE)


class BlockedCommandTest(unittest.TestCase):
    """Command matching, exercised directly for the cases subprocess runs skip."""

    def test_git_write_commands_match(self):
        self.assertEqual(hook.blocked_command("git commit --amend"), "git commit")
        self.assertEqual(hook.blocked_command("git   push --set-upstream"), "git push")

    def test_unrelated_commands_do_not_match(self):
        for command in ("git status", "pytest", "commit", "push origin", ""):
            with self.subTest(command=command):
                self.assertEqual(hook.blocked_command(command), "")


class FindViolationTest(unittest.TestCase):
    """A repo without the checker has no convention for the hook to enforce."""

    def test_absent_checker_yields_no_violation(self):
        self.assertEqual(hook.find_violation(str(Path(__file__).parent)), "")


class SettingsWiringTest(unittest.TestCase):
    """The hook enforces nothing unless the settings files register it."""

    @staticmethod
    def _commands(settings: dict, event: str) -> list:
        """Return every hook command registered for `event`."""
        return [
            entry.get("command", "")
            for matcher in settings.get("hooks", {}).get(event, [])
            for entry in matcher.get("hooks", [])
        ]

    def _assert_registers_both_events(self, path: Path):
        settings = json.loads(path.read_text(encoding="utf-8"))
        session_start = self._commands(settings, "SessionStart")
        pre_tool_use = self._commands(settings, "PreToolUse")
        self.assertTrue(
            any("enforce_branch_name.py" in command for command in session_start),
            f"{path.name} does not register the hook for SessionStart",
        )
        self.assertTrue(
            any("enforce_branch_name.py" in command for command in pre_tool_use),
            f"{path.name} does not register the hook for PreToolUse",
        )

    def test_live_settings_register_both_events(self):
        self._assert_registers_both_events(LIVE_SETTINGS)

    def test_example_settings_register_both_events(self):
        self._assert_registers_both_events(EXAMPLE_SETTINGS)

    def test_pre_tool_use_entries_target_bash(self):
        for path in (LIVE_SETTINGS, EXAMPLE_SETTINGS):
            with self.subTest(path=path.name):
                settings = json.loads(path.read_text(encoding="utf-8"))
                for matcher in settings["hooks"]["PreToolUse"]:
                    self.assertEqual(matcher.get("matcher"), "Bash")


if __name__ == "__main__":
    unittest.main()
