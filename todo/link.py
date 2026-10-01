"""todo link / unlink / projects — the opt-in global store.

A linked project moves its repo-root ./.TODO into ~/.todo/projects/<key>/.TODO
and leaves a symlink behind. Reads and writes follow the symlink for free, so
the CLI, the web drawer, and every git worktree of the repo all hit one store.
The in-repo ./.TODO stays the default; linking is a mode a project chooses. There
is no pointer-file fallback: if os.symlink fails, we surface the real OS error
and abort cleanly.

See docs/plans/2026-06-26-global-store-design.md.
"""

from __future__ import annotations

import hashlib
import os
import shutil
from pathlib import Path

from ruamel.yaml.comments import CommentedMap

from . import migrate, store, yamlio
from .status import TERMINAL
from .util import die, ensure_gitignore, git_tracked, now

HEADER = (
    "Linked store — todos for {repo} live in .TODO/ beside this file so every git\n"
    "worktree shares one list and nothing is committed. Managed by `todo`; run\n"
    "`todo unlink` to inline back. Do not hand-edit."
)


def global_root() -> Path:
    return Path.home() / ".todo" / "projects"


# ── helpers ───────────────────────────────────────────────────────────────────
def _norm_key(s: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "-" for c in s).strip("-")


def _meta_of(store_dir: Path) -> dict | None:
    """The store's meta.yaml mapping, or None (missing/unreadable)."""
    try:
        _, data = yamlio.load(store_dir / migrate.META_FILE)
    except (FileNotFoundError, OSError):
        return None
    return dict(data) if isinstance(data, dict) else None


def _linked_from(store_dir: Path) -> str | None:
    meta = _meta_of(store_dir)
    val = meta.get("linked_from") if meta else None
    return str(val) if val else None


def _resolve_key(repo_root: Path, name: str | None) -> str:
    """Pick the store key. An explicit --name is used verbatim but refuses to
    hijack a different repo's store. The default (repo basename) gets a short
    path-hash suffix only when it collides with a *different* linked repo."""
    root = global_root()
    if name:
        key = _norm_key(name) or "project"
        owner = _linked_from(root / key)
        if owner and owner != str(repo_root):
            die(f'A different project is already linked as "{key}" ({owner}).\n'
                "Pick another --name.", 2)
        return key
    base = _norm_key(repo_root.name) or "project"
    owner = _linked_from(root / base)
    if owner is None or owner == str(repo_root):
        return base
    suffix = hashlib.sha1(str(repo_root).encode()).hexdigest()[:6]
    return f"{base}-{suffix}"


def _write_meta(store_dir: Path, repo_root: Path, key: str) -> None:
    meta = CommentedMap()
    meta["linked_from"] = str(repo_root)
    meta["key"] = key
    meta["linked_at"] = now()[:10]
    meta.yaml_set_start_comment(HEADER.format(repo=repo_root.name))
    yamlio.save(yamlio.yaml(), store_dir / migrate.META_FILE, meta)


# ── commands ──────────────────────────────────────────────────────────────────
def link(repo_root: Path, name: str | None) -> str:
    """Move ./.TODO into the global store and leave a symlink behind."""
    repo_root = repo_root.absolute()
    local = repo_root / store.ROOT_NAME
    if local.is_symlink():
        return f"Already linked: {local} → {local.resolve()}"

    key = _resolve_key(repo_root, name)
    store_dir = global_root() / key
    target = store_dir / store.ROOT_NAME
    store_preexisted = store_dir.exists()
    if target.exists() and (local.exists() or _linked_from(store_dir) != str(repo_root)):
        die(f"Store already exists at {target}\n"
            "Refusing to overwrite it. Use --name to pick a different key.", 2)

    # 1. Move the data into the global store first, then point the repo at it.
    store_dir.mkdir(parents=True, exist_ok=True)
    moved = local.is_dir()
    if moved:
        shutil.move(os.fspath(local), os.fspath(target))
    else:
        target.mkdir(exist_ok=True)
    _write_meta(store_dir, repo_root, key)

    # 2. If os.symlink fails, restore the repo exactly as we found it.
    try:
        os.symlink(os.fspath(target), os.fspath(local))
    except OSError as e:
        if moved:
            shutil.move(os.fspath(target), os.fspath(local))
        if not store_preexisted:
            shutil.rmtree(store_dir, ignore_errors=True)
        die(f"error: could not create symlink {local} → {target}\n"
            f"  {type(e).__name__}: {e}\n\n"
            "todo link needs symlink support. On Windows, enable Developer Mode\n"
            "(or run as admin); otherwise check filesystem permissions. Nothing\n"
            "was changed.", 1)

    lines = [f"Linked {local} → {target}"]
    if ensure_gitignore(repo_root, store.ROOT_NAME):
        lines.append(f"Added {store.ROOT_NAME} to .gitignore")
    if git_tracked(local):
        lines.append(f"note: {store.ROOT_NAME} is still tracked by git — "
                     f"run `git rm -r --cached {store.ROOT_NAME}` to untrack it.")
    return "\n".join(lines)


def unlink(repo_root: Path) -> str:
    """Move the global store back into a real ./.TODO and drop the link."""
    local = repo_root.absolute() / store.ROOT_NAME
    if not local.is_symlink():
        die(f"{local} is not a linked store (not a symlink). Nothing to do.", 2)
    target = local.resolve()
    if not target.is_dir():
        die(f"Broken link: {local} → {target} (target missing). "
            "Remove the dangling symlink yourself.", 2)

    staging = local.with_name(local.name + ".unlinking")
    shutil.move(os.fspath(target), os.fspath(staging))
    local.unlink()
    os.rename(staging, local)

    store_dir = target.parent
    (store_dir / migrate.META_FILE).unlink(missing_ok=True)
    try:
        store_dir.rmdir()           # remove the key dir only when truly empty
    except OSError:
        pass
    lines = [f"Unlinked {local} (store moved back from {target})"]
    if (local.parent / ".gitignore").exists():
        lines.append(f"note: {store.ROOT_NAME} is still listed in .gitignore "
                     "(harmless; remove it if you want to commit the store).")
    return "\n".join(lines)


def project_stores() -> list[dict]:
    """Every global-stored project's location: key, store root, originating
    repo. Legacy single-file stores are migrated on the way."""
    root = global_root()
    out = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        if not (d / store.ROOT_NAME).is_dir() and (d / migrate.LEGACY_FILE).is_file():
            migrate.migrate_store(d)
        if not (d / store.ROOT_NAME).is_dir():
            continue
        out.append({"key": d.name, "root": d / store.ROOT_NAME,
                    "linked_from": _linked_from(d)})
    return out


def projects() -> list[dict]:
    """Every global-stored project: key, open-item count, originating repo."""
    return [
        {"key": p["key"],
         "count": sum(1 for it in store.list_todos(p["root"], [store.OPEN])
                      if it["status"] not in TERMINAL),
         "linked_from": p["linked_from"]}
        for p in project_stores()
    ]
