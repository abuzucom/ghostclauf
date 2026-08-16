#!/usr/bin/env python3
"""Warn about hedging, fluff, and filler in the given files.

Portable and path-generic (unlike lint_style.py, which is hardcoded to
AGENTS.md in this repo): copy this single file into any repo and point
it at that repo's own source globs and CI. Always exits 0, even when it
finds violations; this check is advisory, not blocking. Heuristic
keyword matching, not intent detection.
"""
import re
import sys
from pathlib import Path

INLINE_CODE = re.compile(r"`[^`]*`")

PHRASES = [
    # Hedging qualifiers
    "might potentially", "could potentially", "it's worth noting",
    "worth checking", "in some cases",
    # Self-justification
    "since this is safer", "to make it more robust",
    # Self-narration
    "let me", "i'll now", "now i'll", "let's now",
    # Prompt/task/plan references
    "as requested", "as instructed", "per the plan",
    "per the user's request",
    # Historical narration
    "used to", "previously was", "changed from", "removed the old",
    # Justification theater
    "use a robust approach", "use a more efficient approach",
    "use a scalable solution", "use a flexible design", "use best practices",
    "follow industry standards", "this provides better performance",
    "this improves maintainability", "this enhances security",
    "this makes the code more readable", "this keeps the implementation clean",
    "this is a reliable solution", "this handles edge cases",
    "this prevents potential issues", "this makes the system more resilient",
    "this follows the single-responsibility principle",
]
PHRASE_PATTERN = re.compile(
    "(" + "|".join(re.escape(phrase) for phrase in sorted(PHRASES, key=len, reverse=True)) + ")",
    re.IGNORECASE,
)

# Matched only at the start of a comment line (# or //), not mid-prose.
COMMENT_OPENERS = [
    "Note:", "Important:", "This function", "This method", "This class",
    "Here we", "We need to", "This ensures", "This helps", "This is used to",
    "For better performance", "For security reasons", "Handle errors",
    "Process data", "Return result", "Main logic", "Utility function",
    "Helper function", "Best practice", "Robust", "Scalable", "Flexible",
    "In a real-world scenario", "In production", "Edge cases",
]
COMMENT_LINE = re.compile(
    r"^\s*(?:#|//)\s*(" + "|".join(re.escape(opener) for opener in COMMENT_OPENERS) + r")",
    re.IGNORECASE,
)

TUTORIAL_STARTS = re.compile(r"^\s*(?:#|//)?\s*(First|Next|Finally),", re.IGNORECASE)


def strip_code(line: str) -> str:
    """Remove inline code spans so illustrative Bad/Good examples are ignored."""
    return INLINE_CODE.sub("", line)


def find_violations(text: str, path: str) -> list[str]:
    """Return one warning per hedging/fluff phrase found in `text`."""
    violations = []
    in_fence = False
    tutorial_stages_seen = set()
    for number, raw in enumerate(text.splitlines(), start=1):
        if raw.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        prose = strip_code(raw)

        for match in PHRASE_PATTERN.finditer(prose):
            violations.append(
                f"warning: {path}:{number}: hedging/fluff phrase "
                f"'{match.group(1)}'"
            )

        comment_match = COMMENT_LINE.match(raw)
        if comment_match:
            violations.append(
                f"warning: {path}:{number}: generic filler comment opener "
                f"'{comment_match.group(1)}'"
            )

        tutorial_match = TUTORIAL_STARTS.match(raw)
        if tutorial_match:
            stage = tutorial_match.group(1).lower()
            if stage in ("next", "finally") and "first" in tutorial_stages_seen:
                violations.append(
                    f"warning: {path}:{number}: tutorial-mode narration "
                    f"('{tutorial_match.group(1)}, ...' following 'First, ...')"
                )
            tutorial_stages_seen.add(stage)

    return violations


def main() -> int:
    """Warn about hedging and fluff in each given file. Always exits 0."""
    paths = sys.argv[1:]
    if not paths:
        print("usage: check_hedging.py FILE [FILE ...]", file=sys.stderr)
        return 0

    for path in paths:
        text = Path(path).read_text(encoding="utf-8")
        for message in find_violations(text, path):
            print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
