"""Who is acting: the user handle and whether a person or an agent wrote it.

The user comes from $TODO_USER, then `user:` in ~/.todo/config.yaml, then the
OS login. `via` comes from --agent/--human, then $TODO_VIA, then `agent` inside Claude
Code ($CLAUDECODE), else `human`.
"""

from __future__ import annotations

import getpass
import os
from pathlib import Path

from . import yamlio

_via_override: str | None = None


def config_path() -> Path:
    return Path.home() / ".todo" / "config.yaml"


def load_config() -> dict:
    f = config_path()
    if not f.is_file():
        return {}
    data = yamlio.read(f)
    return dict(data) if isinstance(data, dict) else {}


def save_config(data: dict) -> None:
    f = config_path()
    f.parent.mkdir(parents=True, exist_ok=True)
    y = yamlio.yaml()
    yamlio.save(y, f, data)


def user() -> str:
    env = os.environ.get("TODO_USER", "").strip()
    if env:
        return env
    configured = str(load_config().get("user") or "").strip()
    if configured:
        return configured
    try:
        return getpass.getuser()
    except Exception:  # noqa: BLE001 — no login name in some containers
        return "unknown"


def set_via(value: str | None) -> None:
    """Pin `via` for this process (--agent / --human); None un-pins it."""
    global _via_override
    _via_override = value


def via() -> str:
    if _via_override:
        return _via_override
    env = os.environ.get("TODO_VIA", "").strip()
    if env in ("agent", "human"):
        return env
    return "agent" if os.environ.get("CLAUDECODE") else "human"
