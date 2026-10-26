"""The one lock every read-modify-write of the store's machine state files
(git facts' tips and cache, the plugin runner's records) takes."""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import threading
from pathlib import Path

from .remote import sync_config, sync_dir

LOCK_FILE = "state.lock"
_held = threading.local()


def state_file(root: Path, name: str) -> Path:
    """`.sync/<name>` on a synced store, `.TODO/.<name>` on a local-only one."""
    return sync_dir(root) / name if sync_config(root) else root / ("." + name)


@contextlib.contextmanager
def locked(root: Path):
    """Hold the state lock; re-entrant within a thread."""
    try:
        import fcntl
    except ImportError:              # Windows: no flock
        fcntl = None
    depth = getattr(_held, "depth", 0)
    if depth or fcntl is None:
        _held.depth = depth + 1
        try:
            yield
        finally:
            _held.depth = depth
        return
    f = state_file(root, LOCK_FILE)
    f.parent.mkdir(parents=True, exist_ok=True)
    with open(f, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        _held.depth = 1
        try:
            yield
        finally:
            _held.depth = 0


def write_json(f: Path, data: dict) -> None:
    """Write through a temp file of its own, so a crash or a second writer never leaves half a file."""
    f.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=f.parent, prefix=f".{f.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(data, out, sort_keys=True)
        os.replace(tmp, f)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise
