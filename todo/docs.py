"""An item's docs: files it keeps on purpose, in `<item dir>/docs/<name>`.

`docs/.meta.yaml` maps each name to `{uid, sha256, size, by, via, at, base}`:
the content's hash and size, who wrote it and when, and `base`, the sha256 the
server last confirmed (None until the doc has synced). A file the sidecar
doesn't list is still a doc; its author is unknown until a `todo` write
records it. A sidecar that can't be read is kept as `.meta.yaml.bad`, and the
next sync rebuilds each doc's base from the server's records.

A doc is identified by its name key, the name NFC-normalized and lowercased,
so names differing only in case or Unicode form are one doc.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from pathlib import Path

from . import filecache, identity, yamlio
from .uids import hash_uid

DOCS_DIR = "docs"
META_FILE = ".meta.yaml"
BAD_META_FILE = ".meta.yaml.bad"
REBUILD_FILE = ".rebuild"          # present while bases wait to be rebuilt from the server
MAX_NAME_BYTES = 200
MAX_BYTES = 25 * 1024 * 1024
FIELDS = ("uid", "sha256", "size", "by", "via", "at", "base")

_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])$", re.IGNORECASE)


def name_error(name: str) -> str | None:
    """Why `name` isn't a name a doc can have on every system, or None.
    Mirrors docNameError in server/lib/doc-view.ts."""
    if not name:
        return "a doc needs a name"
    try:
        size = len(name.encode("utf-8"))
    except UnicodeEncodeError:
        return "a doc name must be valid UTF-8"
    if size > MAX_NAME_BYTES:
        return f"a doc name is at most {MAX_NAME_BYTES} bytes"
    if _BAD_CHARS.search(name):
        return f'"{name}": a doc name can\'t hold control characters or any of <>:"/\\|?*'
    if name.startswith("."):
        return f'"{name}": a doc name can\'t start with "."'
    if name.endswith((".", " ")):
        return f'"{name}": a doc name can\'t end with "." or a space'
    if _RESERVED.match(name.split(".")[0]):
        return f'"{name}": that name is reserved on Windows'
    return None


def name_key(name: str) -> str:
    """What makes two names one doc: NFC, lowercased."""
    return unicodedata.normalize("NFC", name).lower()


def doc_uid(item_uid: str, name: str) -> str:
    """The same uid on every store and the server, so a name key is one doc."""
    return hash_uid("doc", item_uid, name_key(name))


def find(names, name: str) -> str | None:
    """The name among `names` that is the same doc as `name`, preferring an exact match."""
    if name in names:
        return name
    key = name_key(name)
    return next((n for n in sorted(names) if name_key(n) == key), None)


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


def scan(item_dir: Path):
    """(docs, skipped): name → path for each regular file with a valid name,
    and a reason per other entry. Dotfiles are the store's own and left out."""
    d = item_dir / DOCS_DIR
    found, skipped = {}, {}
    try:
        entries = sorted(os.scandir(d), key=lambda e: e.name)
    except (FileNotFoundError, NotADirectoryError):
        return found, skipped
    for e in entries:
        name = e.name
        if name.startswith("."):
            continue
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            skipped[name.encode("utf-8", "surrogateescape").decode("utf-8", "replace")] = "its name isn't UTF-8"
            continue
        if e.is_symlink():
            skipped[name] = "a symlink"
        elif not e.is_file(follow_symlinks=False):
            continue
        elif name_error(name):
            skipped[name] = name_error(name)
        else:
            found[name] = Path(e.path)
    return found, skipped


def files(item_dir: Path) -> dict:
    """name → path for every doc file."""
    return scan(item_dir)[0]


def skipped(item_dir: Path) -> dict:
    """Files in docs/ that aren't docs (symlinks, unusable names), with why."""
    return scan(item_dir)[1]


def read_meta(item_dir: Path) -> dict:
    """The sidecar. One that can't be read is moved aside as `.meta.yaml.bad`,
    and its docs wait for sync to rebuild their bases."""
    d = item_dir / DOCS_DIR
    f = d / META_FILE
    if not f.is_file():
        return {}
    try:
        raw = yamlio.read(f)
        ok = isinstance(raw, dict) or raw is None
    except Exception:  # noqa: BLE001 — any parse failure is a damaged sidecar
        ok = False
    if not ok:
        os.replace(f, d / BAD_META_FILE)
        (d / REBUILD_FILE).touch()
        return {}
    return {str(k): {f: v.get(f) for f in FIELDS} for k, v in (raw or {}).items() if isinstance(v, dict)}


def needs_rebuild(item_dir: Path) -> bool:
    return (item_dir / DOCS_DIR / REBUILD_FILE).exists()


def rebuilt(item_dir: Path) -> None:
    (item_dir / DOCS_DIR / REBUILD_FILE).unlink(missing_ok=True)


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


def entry(item_uid: str, name: str, sha: str, size: int, now_iso: str, base=None) -> dict:
    """A sidecar entry crediting the current user with this content."""
    return {"uid": doc_uid(item_uid, name) if item_uid else None, "sha256": sha, "size": size,
            "by": identity.user(), "via": identity.via(), "at": now_iso, "base": base}


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
            meta[name] = entry(item_uid, name, sha, path.stat().st_size, now_iso, (e or {}).get("base"))
    for name in [n for n in meta if n not in present and not meta[n].get("base")]:
        del meta[name]
    if own:
        write_meta(item_dir, meta)
    return meta


def add(item_dir: Path, item_uid: str, name: str, data: bytes, now_iso: str) -> dict:
    meta = read_meta(item_dir)
    same = find(files(item_dir), name)
    if same and same != name:
        os.unlink(item_dir / DOCS_DIR / same)       # one doc, under its new spelling
        meta[name] = meta.pop(same, {})
    write_bytes(item_dir, name, data)
    base = (meta.get(name) or {}).get("base")
    meta[name] = entry(item_uid, name, sha256_bytes(data), len(data), now_iso, base)
    meta = record(item_dir, item_uid, now_iso, meta)
    write_meta(item_dir, meta)
    return meta[name]


def remove(item_dir: Path, item_uid: str, name: str, now_iso: str) -> bool:
    """Delete a doc. A synced one keeps its sidecar entry (file gone, `base`
    set), so the next round removes it on the server."""
    path = item_dir / DOCS_DIR / name
    if name_error(name) or path.is_symlink() or not path.is_file():
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
    taken = {name_key(n) for n in set(files(item_dir)) | set(read_meta(item_dir))}
    n = 1
    while True:
        tag = f".conflict-{who}" + (f"-{n}" if n > 1 else "")
        room = MAX_NAME_BYTES - len((tag + ext).encode())
        out = stem.encode()[:room].decode("utf-8", "ignore") + tag + ext
        if name_key(out) not in taken:
            return out
        n += 1


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB"):
        if n < 1024 or unit == "MB":
            return f"{n} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} MB"
