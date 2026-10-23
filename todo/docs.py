"""An item's docs: files it keeps on purpose, in `<item dir>/docs/<name>`.

`docs/.meta.yaml` maps each name to `{uid, sha256, size, by, via, at, base}`:
the content's hash and size, who wrote it and when, and `base`, the sha256 the
server last confirmed (None until the doc has synced). A file the sidecar
doesn't list is still a doc; its author is unknown until a `todo` write
records it.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from . import filecache, identity, yamlio

DOCS_DIR = "docs"
META_FILE = ".meta.yaml"
MAX_NAME = 120
MAX_BYTES = 25 * 1024 * 1024
FIELDS = ("uid", "sha256", "size", "by", "via", "at", "base")

_BAD_NAME = re.compile(r"[/\\\x00-\x1f\x7f]")


def name_error(name: str) -> str | None:
    """Why `name` isn't a plain file name a doc can have, or None."""
    if not name:
        return "a doc needs a name"
    if _BAD_NAME.search(name):
        return f'"{name}": a doc name is a plain file name, without "/"'
    if name.startswith("."):
        return f'"{name}": a doc name can\'t start with "."'
    if len(name) > MAX_NAME:
        return f"a doc name is at most {MAX_NAME} characters"
    return None


def doc_uid(item_uid: str, name: str) -> str:
    """The same uid on every store and the server, so a name is one doc."""
    from .sync import _hash_uid

    return _hash_uid("doc", item_uid, name)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_file(path: Path) -> str:
    """The file's sha256, rehashed only when its inode, size or mtime moved."""
    return filecache.parsed(path, _hash_file)


def files(item_dir: Path) -> dict:
    """name → path for every doc file, dotfiles left out."""
    d = item_dir / DOCS_DIR
    if not d.is_dir():
        return {}
    return {p.name: p for p in sorted(d.iterdir()) if p.is_file() and not p.name.startswith(".")}


def read_meta(item_dir: Path) -> dict:
    f = item_dir / DOCS_DIR / META_FILE
    if not f.is_file():
        return {}
    try:
        raw = yamlio.read(f)
    except Exception:  # noqa: BLE001 — a damaged sidecar: every doc reads as unrecorded
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(k): {f: v.get(f) for f in FIELDS} for k, v in raw.items() if isinstance(v, dict)}


def write_meta(item_dir: Path, meta: dict) -> None:
    d = item_dir / DOCS_DIR
    f = d / META_FILE
    if not meta:
        f.unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass
        return
    d.mkdir(exist_ok=True)
    body = {name: {k: meta[name].get(k) for k in FIELDS} for name in sorted(meta)}
    yamlio.write_atomic(f, yamlio.dump(yamlio.yaml(), body))


def write_bytes(item_dir: Path, name: str, data: bytes) -> Path:
    """Write a doc atomically; the temp file is a dotfile, so no scan takes it for a doc."""
    d = item_dir / DOCS_DIR
    d.mkdir(exist_ok=True)
    target = d / name
    tmp = d / f".{name}.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target


def _mine(item_uid: str, name: str, sha: str, size: int, now_iso: str, base=None) -> dict:
    return {"uid": doc_uid(item_uid, name) if item_uid else None, "sha256": sha, "size": size, "by": identity.user(),
            "via": identity.via(), "at": now_iso, "base": base}


def record(item_dir: Path, item_uid: str, now_iso: str, meta: dict | None = None) -> dict:
    """Credit the current user with every doc whose content the sidecar doesn't
    yet describe, and forget entries for files gone before they ever synced.
    Returns the updated sidecar (also written when `meta` isn't given)."""
    own = meta is None
    meta = read_meta(item_dir) if own else meta
    present = files(item_dir)
    for name, path in present.items():
        e = meta.get(name)
        sha = sha256_file(path)
        if e is None or e.get("sha256") != sha or not e.get("by"):
            meta[name] = _mine(item_uid, name, sha, path.stat().st_size, now_iso, (e or {}).get("base"))
    for name in [n for n in meta if n not in present and not meta[n].get("base")]:
        del meta[name]
    if own:
        write_meta(item_dir, meta)
    return meta


def add(item_dir: Path, item_uid: str, name: str, data: bytes, now_iso: str) -> dict:
    meta = read_meta(item_dir)
    write_bytes(item_dir, name, data)
    base = (meta.get(name) or {}).get("base")
    meta[name] = _mine(item_uid, name, sha256_bytes(data), len(data), now_iso, base)
    meta = record(item_dir, item_uid, now_iso, meta)
    write_meta(item_dir, meta)
    return meta[name]


def remove(item_dir: Path, item_uid: str, name: str, now_iso: str) -> bool:
    """Delete a doc. A synced one keeps its sidecar entry (file gone, `base`
    set), so the next round removes it on the server."""
    path = item_dir / DOCS_DIR / name
    if not path.is_file() or name.startswith("."):
        return False
    path.unlink()
    write_meta(item_dir, record(item_dir, item_uid, now_iso, read_meta(item_dir)))
    return True


def list_docs(item_dir: Path) -> list:
    """Each doc's name, path, size and who/when, sorted by name."""
    meta = read_meta(item_dir)
    out = []
    for name, path in files(item_dir).items():
        e = meta.get(name) or {}
        size = path.stat().st_size
        known = e.get("sha256") == sha256_file(path)
        out.append({"name": name, "path": path, "size": size,
                    "by": e.get("by") if known else None, "via": e.get("via") if known else None,
                    "at": e.get("at") if known else None, "base": e.get("base")})
    return out


def conflict_name(item_dir: Path, name: str, handle: str) -> str:
    """`<stem>.conflict-<handle><ext>`, numbered when that name is taken."""
    p = Path(name)
    stem, ext = (p.stem, p.suffix) if p.stem else (name, "")
    who = re.sub(r"[^\w.-]+", "-", handle).strip("-.") or "me"
    taken = set(files(item_dir)) | set(read_meta(item_dir))
    n = 1
    while True:
        tag = f".conflict-{who}" + (f"-{n}" if n > 1 else "")
        out = stem[:MAX_NAME - len(tag) - len(ext)] + tag + ext
        if out not in taken:
            return out
        n += 1


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} MB"
