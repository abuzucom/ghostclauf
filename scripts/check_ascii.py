#!/usr/bin/env python3
"""Enforce the dash and ASCII style rules on the given files.

A portable, path-generic version of lint_style.py's checks (which are
hardcoded to AGENTS.md in this repo): copy this single file into any repo
and point it at that repo's own source globs and CI. Blocking, like
lint_style.py: exits 1 on any violation, since it propagates an
already-blocking rule ("No non-ASCII characters") rather than a new one.
"""
import re
import sys
from pathlib import Path

INLINE_CODE = re.compile(r"`[^`]*`")
DASH_SUBSTITUTE = re.compile(r" -{1,3} ")
EM_EN_DASH = re.compile(r"[–—]")


def strip_code(line: str) -> str:
    """Remove inline code spans so hyphens in flags/examples are ignored."""
    return INLINE_CODE.sub("", line)


def find_violations(text: str, path: str) -> list[str]:
    """Return one message per style violation in the prose of `text`."""
    violations = []
    in_fence = False
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        prose = strip_code(raw)
        if EM_EN_DASH.search(prose):
            violations.append(f"{path}:{number}: em/en dash character")
        if DASH_SUBSTITUTE.search(prose):
            violations.append(
                f"{path}:{number}: spaced hyphen used as an em-dash substitute"
            )
        if any(ord(char) > 127 for char in prose):
            violations.append(f"{path}:{number}: non-ASCII character in prose")
    return violations


def main() -> int:
    """Lint each given file. Return 0 when all are clean, 1 on any violation."""
    paths = sys.argv[1:]
    if not paths:
        print("usage: check_ascii.py FILE [FILE ...]", file=sys.stderr)
        return 1

    all_violations = []
    for path in paths:
        text = Path(path).read_text(encoding="utf-8")
        all_violations.extend(find_violations(text, path))

    if all_violations:
        for message in all_violations:
            print(message, file=sys.stderr)
        print(
            "fix: rewrite as separate sentences or use a comma/colon/semicolon",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
