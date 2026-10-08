"""Parsed store files, kept between runs. A file is parsed again only when its
inode, size or mtime changes, so a sync round's full scan costs a stat per file
instead of a YAML parse."""

from __future__ import annotations

import hashlib
import os
import pickle
from pathlib import Path

_parsed: dict = {}               # path → ((inode, size, mtime_ns), pickled value)
_changed = False


def parsed(file: Path, parse):
    """`parse(file)`, or its result from the last time the file looked the same.
    Each call returns a fresh copy, so callers may change what they get."""
    global _changed
    st = os.stat(file)
    sig = (st.st_ino, st.st_size, st.st_mtime_ns)
    key = str(file)
    hit = _parsed.get(key)
    if hit is not None and hit[0] == sig:
        return pickle.loads(hit[1])
    value = parse(file)
    _parsed[key] = (sig, pickle.dumps(value, pickle.HIGHEST_PROTOCOL))
    _changed = True
    return value


def _home(root: Path) -> Path:
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "todo" / f"parsed-{hashlib.sha1(str(root.resolve()).encode()).hexdigest()[:16]}.pickle"


def load(root: Path) -> None:
    """Take in what earlier runs parsed in `root`'s store."""
    try:
        data = pickle.loads(_home(root).read_bytes())
    except Exception:  # noqa: BLE001 — a missing or unreadable cache is just empty
        return
    if isinstance(data, dict):
        for k, v in data.items():
            _parsed.setdefault(k, v)


def save(root: Path) -> None:
    """Keep what this run parsed in `root`'s store, dropping files that are gone."""
    global _changed
    if not _changed:
        return
    prefix = str(root.resolve()) + os.sep
    keep = {k: v for k, v in _parsed.items() if k.startswith(prefix) and os.path.exists(k)}
    f = _home(root)
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_name(f"{f.name}.{os.getpid()}.tmp")
        tmp.write_bytes(pickle.dumps(keep, pickle.HIGHEST_PROTOCOL))
        os.replace(tmp, f)
    except OSError:
        return
    _changed = False
