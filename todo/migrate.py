"""One-way conversion of a legacy single-file TODO.yaml into a `.TODO/` store.

Runs automatically the first time a command finds a TODO.yaml and no `.TODO/`.
The tree is built in a sibling `.TODO.migrating/` and renamed into place, so a
crash leaves the legacy file untouched. The legacy files are then deleted if git
tracks them (history keeps them), otherwise kept under `.migrated/`.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from ruamel.yaml.comments import CommentedMap

from . import store, yamlio
from .util import ensure_gitignore, git_ignored, git_tracked, to_str

LEGACY_FILE = "TODO.yaml"
META_FILE = "meta.yaml"
BACKUP_DIR = ".migrated"
ITEM_LISTS = ("notes", "log", "tasks")


def _int_or_none(v):
    return int(v) if v not in (None, "") else None


def _assign_ids(entries: list) -> list:
    """Give id-less entries the next free serial, in order."""
    used = {e["id"] for e in entries if e["id"] is not None}
    nxt = max(used) + 1 if used else 1
    for e in entries:
        if e["id"] is None:
            while nxt in used:
                nxt += 1
            e["id"] = nxt
            used.add(nxt)
    return entries


def _notes_of(node, created: str) -> list:
    raw = node.get("notes")
    notes = [
        {"id": _int_or_none(n.get("id")), "text": to_str(n.get("text"))} if isinstance(n, dict)
        else {"id": None, "text": to_str(n)}
        for n in (raw if isinstance(raw, list) else [])
    ]
    for n in notes:
        n["ts"] = created
    return _assign_ids(notes)


def _log_of(node) -> list:
    raw = node.get("log")
    return _assign_ids([
        {"id": _int_or_none(e.get("id")), "ts": to_str(e.get("ts")) or store.UNDATED,
         "text": to_str(e.get("text"))}
        for e in (raw if isinstance(raw, list) else []) if isinstance(e, dict)
    ])


def _tasks_of(node) -> list:
    raw = node.get("tasks")
    return _assign_ids([
        {"id": _int_or_none(t.get("id")), "title": to_str(t.get("title")),
         "status": to_str(t.get("status")) or "todo", "phase": _int_or_none(t.get("phase"))}
        for t in (raw if isinstance(raw, list) else []) if isinstance(t, dict)
    ])


def _write_item(tmp: Path, node, folder: str, taken: set) -> None:
    base = to_str(node.get("id")) or re.sub(r"[^a-z0-9]+", "-",
                                             to_str(node.get("title")).lower()).strip("-") or "item"
    item_id, n = base, 2
    while item_id in taken:
        item_id = f"{base}-{n}"
        n += 1
    taken.add(item_id)

    item_dir = tmp / folder / item_id
    item_dir.mkdir(parents=True)
    created = to_str(node.get("created")) or store.UNDATED
    notes, log, tasks = _notes_of(node, created), _log_of(node), _tasks_of(node)
    for k in ITEM_LISTS:                    # the remaining node keeps its comments
        node.pop(k, None)
    node["id"] = item_id
    node.fa.set_block_style()               # a flow-style legacy item would not parse alone
    yamlio.save(yamlio.yaml(), item_dir / store.ITEM_FILE, node)

    for sub, entries in ((store.NOTES_DIR, notes), (store.LOG_DIR, log)):
        if entries:
            (item_dir / sub).mkdir()
        for e in entries:
            (item_dir / sub / f"{store.ts_to_name(e['ts'])}-{e['id']}.md").write_text(e["text"] + "\n")

    if tasks:
        store._write_tasks(item_dir, [], store._sort_tasks(tasks))


def _nodes(file: Path) -> list:
    _, data = yamlio.load(file)
    seq = data.get("todos") if isinstance(data, dict) else None
    return [n for n in (seq or []) if isinstance(n, dict)]


def _archive_folder(status: str) -> str:
    if status == "done":
        return store.ARCHIVED
    return store.folder_for(status)


def migrate_file(legacy: Path, root: Path, backup: Path) -> int:
    """Convert `legacy` (plus any ARCHIVE/TODO/*.yaml beside it) into `root`.
    Returns the number of items written."""
    tmp = root.with_name(root.name + ".migrating")
    if tmp.exists():
        shutil.rmtree(tmp)                  # leftover from a crashed run
    tmp.mkdir()
    taken, count = set(), 0
    for node in _nodes(legacy):
        _write_item(tmp, node, store.folder_for(to_str(node.get("status")) or "todo"), taken)
        count += 1
    archive_dir = legacy.parent / "ARCHIVE" / "TODO"
    archives = sorted(archive_dir.glob("*.yaml")) if archive_dir.is_dir() else []
    for f in archives:
        for node in _nodes(f):
            _write_item(tmp, node, _archive_folder(to_str(node.get("status"))), taken)
            count += 1
    os.rename(tmp, root)

    for f in [legacy, *archives]:
        if git_tracked(f):
            f.unlink()
        else:
            dest = backup / f.relative_to(legacy.parent)
            dest.parent.mkdir(parents=True, exist_ok=True)
            os.replace(f, dest)
    for d in (archive_dir, archive_dir.parent):
        try:
            d.rmdir()
        except OSError:
            pass
    return count


def migrate_store(store_dir: Path) -> None:
    """Convert a linked global store (`<key>/TODO.yaml`) to `<key>/.TODO/`,
    lifting its `meta:` block into `<key>/meta.yaml`."""
    legacy = store_dir / LEGACY_FILE
    _, data = yamlio.load(legacy)
    meta = data.get("meta") if isinstance(data, dict) else None
    if isinstance(meta, dict):
        y = yamlio.yaml()
        out = CommentedMap((k, v) for k, v in meta.items())
        yamlio.save(y, store_dir / META_FILE, out)
    migrate_file(legacy, store_dir / store.ROOT_NAME, store_dir / BACKUP_DIR)


def migrate_repo(repo_dir: Path) -> Path | None:
    """Convert `repo_dir/TODO.yaml` if present. A symlinked (linked-store) file
    has its store converted and becomes a `.TODO` symlink into it. Returns the
    new root, or None when there was nothing to migrate."""
    local = repo_dir / LEGACY_FILE
    root = repo_dir / store.ROOT_NAME
    if local.is_symlink():
        target = Path(os.path.realpath(local))
        store_root = target.parent / store.ROOT_NAME
        if not store_root.is_dir() and target.is_file():
            migrate_store(target.parent)
        if not store_root.is_dir():
            return None
        local.unlink()
        os.symlink(os.fspath(store_root), os.fspath(root))
        ensure_gitignore(repo_dir, store.ROOT_NAME)
        return root
    if not local.is_file():
        return None
    ignored = git_ignored(local)
    migrate_file(local, root, root / BACKUP_DIR)
    if ignored:
        ensure_gitignore(repo_dir, store.ROOT_NAME)
    return root
