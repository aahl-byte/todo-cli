"""Tiny shared helpers: process exit, timestamps, None-safe stringify, git."""

import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def die(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def now() -> str:
    """ISO 8601 with millisecond precision and a Z suffix (matches the JS CLI)."""
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def to_str(v) -> str:
    return "" if v is None else str(v)


def _git(cwd: Path, *args) -> bool:
    try:
        r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
        return r.returncode == 0
    except (FileNotFoundError, OSError):
        return False


def git_tracked(path: Path) -> bool:
    return _git(path.parent, "ls-files", "--error-unmatch", path.name)


def git_ignored(path: Path) -> bool:
    return _git(path.parent, "check-ignore", "-q", path.name)


def ensure_gitignore(repo_root: Path, name: str) -> bool:
    """Add `name` to repo_root/.gitignore if absent. Returns True if it changed."""
    gi = repo_root / ".gitignore"
    text = gi.read_text() if gi.exists() else ""
    if name in (ln.strip() for ln in text.splitlines()):
        return False
    if text and not text.endswith("\n"):
        text += "\n"
    gi.write_text(text + name + "\n")
    return True
