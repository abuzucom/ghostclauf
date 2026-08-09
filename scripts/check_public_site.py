"""Validate the static public-site artifact boundary."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SITE = Path("site")
DATA_FILE = SITE / "data" / "public.json"
REQUIRED_FILES = (
    SITE / "index.html",
    SITE / "CNAME",
    DATA_FILE,
    SITE / "fonts" / "LibreFranklin.woff2",
    SITE / "fonts" / "Cousine-Regular.woff2",
    SITE / "fonts" / "Cousine-Bold.woff2",
    SITE / "fonts" / "LibreFranklin-OFL.txt",
    SITE / "fonts" / "Cousine-OFL.txt",
)
ALLOWED_SITE_FILES = {
    "CNAME",
    "app.js",
    "index.html",
    "styles.css",
    "data/public.json",
    "fonts/LibreFranklin.woff2",
    "fonts/Cousine-Regular.woff2",
    "fonts/Cousine-Bold.woff2",
    "fonts/LibreFranklin-OFL.txt",
    "fonts/Cousine-OFL.txt",
}
ALLOWED_SNAPSHOT_FIELDS = {
    "root": {"version", "generatedAt", "facts", "quotes", "loyalty"},
    "fact": {"id", "text"},
    "quote": {"id", "text", "speaker"},
    "loyalty": {"currencyName", "participantCount", "totalBalance", "leaderboard"},
    "leaderboard": {"rank", "displayName", "balance"},
}
FORBIDDEN_SITE_TOKENS = ("innerHTML", "new RegExp", "tokenStore", "addedBy")
THEME_VALUES = {
    "#0b0b0b",
    "#242424",
    "#eae7e1",
    "#a6a39d",
    "#74777a",
    "#d6d3cd",
    "#c2bfb8",
    "#3d3d3a",
    "#f5f3ee",
    "#171716",
}


def fail(message: str) -> None:
    print(f"public-site check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def require_fields(value: object, allowed: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        fail(f"{label} must be an object")
    unexpected = set(value) - allowed
    if unexpected:
        fail(f"{label} contains non-public fields: {', '.join(sorted(unexpected))}")
    return value


def require_list(value: object, label: str) -> list[object]:
    if not isinstance(value, list):
        fail(f"{label} must be an array")
    return value


def require_number(value: object, label: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(f"{label} must be a number")


def check_snapshot() -> None:
    try:
        snapshot = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {DATA_FILE}: {error}")
    root = require_fields(snapshot, ALLOWED_SNAPSHOT_FIELDS["root"], "snapshot")
    if root.get("version") != 1:
        fail("snapshot version must be 1")
    if not isinstance(root.get("generatedAt"), str):
        fail("snapshot generatedAt must be a string")
    for item in require_list(root.get("facts"), "facts"):
        fact = require_fields(item, ALLOWED_SNAPSHOT_FIELDS["fact"], "fact")
        if not isinstance(fact.get("id"), int) or not isinstance(fact.get("text"), str):
            fail("fact fields must be public primitive values")
    for item in require_list(root.get("quotes"), "quotes"):
        quote = require_fields(item, ALLOWED_SNAPSHOT_FIELDS["quote"], "quote")
        speaker = quote.get("speaker")
        if not isinstance(quote.get("id"), int) or not isinstance(quote.get("text"), str):
            fail("quote fields must be public primitive values")
        if speaker is not None and not isinstance(speaker, str):
            fail("quote speaker must be a string or null")
    loyalty = require_fields(root.get("loyalty"), ALLOWED_SNAPSHOT_FIELDS["loyalty"], "loyalty")
    if not isinstance(loyalty.get("currencyName"), str):
        fail("loyalty currencyName must be a string")
    require_number(loyalty.get("participantCount"), "loyalty participantCount")
    require_number(loyalty.get("totalBalance"), "loyalty totalBalance")
    for item in require_list(loyalty.get("leaderboard"), "loyalty leaderboard"):
        entry = require_fields(item, ALLOWED_SNAPSHOT_FIELDS["leaderboard"], "leaderboard entry")
        if not isinstance(entry.get("rank"), int) or not isinstance(entry.get("displayName"), str):
            fail("leaderboard identity fields must be public primitive values")
        require_number(entry.get("balance"), "leaderboard balance")


def check_site_files() -> None:
    for path in REQUIRED_FILES:
        if not path.is_file():
            fail(f"missing required file: {path}")
    if (SITE / "CNAME").read_text(encoding="utf-8").strip() != "ghost.clauf.org":
        fail("site/CNAME must contain ghost.clauf.org")
    paths = {path.relative_to(SITE).as_posix() for path in SITE.rglob("*") if path.is_file()}
    unexpected = paths - ALLOWED_SITE_FILES
    if unexpected:
        fail(f"site contains non-artifact files: {', '.join(sorted(unexpected))}")


def check_client_assets() -> None:
    client_source = (SITE / "app.js").read_text(encoding="utf-8")
    for token in FORBIDDEN_SITE_TOKENS:
        if token in client_source:
            fail(f"site/app.js contains forbidden token: {token}")
    styles = (SITE / "styles.css").read_text(encoding="utf-8").lower()
    colors = set(re.findall(r"#[0-9a-f]{6}", styles))
    if not colors <= THEME_VALUES:
        fail("site/styles.css uses a color outside the VIIM palette")


check_site_files()
check_snapshot()
check_client_assets()
