"""The folder the CLI runs in and its git remote, reported to the team server
so Actions can start a session in the right place after a folder moves."""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

REPORT_FILE = "checkout.json"
REFRESH_SECONDS = 24 * 3600     # re-report daily even when unchanged, so a reset server relearns it


def _git(cwd: Path, *args: str) -> str:
    try:
        out = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def repo_key(raw: str | None) -> str:
    """`owner/name` from a repo field or a remote URL, lowercased; "" otherwise."""
    parts = [p for p in re.split(r"[/:]", re.sub(r"\.git$", "", str(raw or "").strip(), flags=re.I).rstrip("/")) if p]
    return "/".join(parts[-2:]).lower() if len(parts) >= 2 else ""


def local(cwd: Path | None = None) -> dict:
    """{"dir", "repo"}: the git top level around `cwd` (else `cwd`) and its origin as owner/name."""
    cwd = (cwd or Path.cwd()).resolve()
    top = _git(cwd, "rev-parse", "--show-toplevel")
    d = Path(top) if top else cwd
    return {"dir": str(d), "repo": repo_key(_git(d, "remote", "get-url", "origin"))}


def report(sync_dir: Path, remote, project: str) -> None:
    """Tell the server where this checkout lives, when that changed or a day has passed."""
    here = local()
    f = sync_dir / REPORT_FILE
    try:
        last = json.loads(f.read_text())
    except (OSError, ValueError):
        last = {}
    if last.get("dir") == here["dir"] and last.get("repo") == here["repo"] and time.time() - last.get("at", 0) < REFRESH_SECONDS:
        return
    remote.checkout(project, here["dir"], here["repo"])
    sync_dir.mkdir(exist_ok=True)
    f.write_text(json.dumps({**here, "at": time.time()}))
