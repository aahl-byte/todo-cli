"""todo link / unlink / projects — the opt-in global store.

A linked project replaces its repo-root ./TODO.yaml with a symlink to
~/.todo/projects/<key>/TODO.yaml. Reads and writes follow the symlink for free
(Path.resolve() in cli._resolve_file, ruamel's atomic temp+rename in yamlio), so
the CLI, the web drawer, `cat`, and every git worktree of the repo all hit one
store with no redirect-following code. The committed ./TODO.yaml stays the
default; linking is a mode a project chooses. There is no pointer-file fallback:
if os.symlink fails, we surface the real OS error and abort cleanly.

See docs/plans/2026-06-26-global-store-design.md.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

from ruamel.yaml.comments import CommentedMap

from . import store, yamlio
from .util import die, now

HEADER = (
    "Linked store — todos for {repo} live here so every git worktree shares one\n"
    "list and nothing is committed. Managed by `todo`; run `todo unlink` to inline\n"
    "back. Do not hand-edit."
)


def global_root() -> Path:
    return Path.home() / ".todo" / "projects"


# ── helpers ───────────────────────────────────────────────────────────────────
def _norm_key(s: str) -> str:
    return "".join(c if c.isalnum() or c in "._-" else "-" for c in s).strip("-")


def _meta_of(file: Path) -> dict | None:
    """The top-level `meta:` mapping of a store, or None (missing/no meta)."""
    try:
        _, data = yamlio.load(file)
    except (FileNotFoundError, OSError):
        return None
    meta = data.get("meta") if isinstance(data, dict) else None
    return dict(meta) if isinstance(meta, dict) else None


def _linked_from(file: Path) -> str | None:
    meta = _meta_of(file)
    val = meta.get("linked_from") if meta else None
    return str(val) if val else None


def _resolve_key(repo_root: Path, name: str | None) -> str:
    """Pick the store key. An explicit --name is used verbatim but refuses to
    hijack a different repo's store. The default (repo basename) gets a short
    path-hash suffix only when it collides with a *different* linked repo."""
    root = global_root()
    if name:
        key = _norm_key(name) or "project"
        owner = _linked_from(root / key / "TODO.yaml")
        if owner and owner != str(repo_root):
            die(f'A different project is already linked as "{key}" ({owner}).\n'
                "Pick another --name.", 2)
        return key
    base = _norm_key(repo_root.name) or "project"
    owner = _linked_from(root / base / "TODO.yaml")
    if owner is None or owner == str(repo_root):
        return base
    suffix = hashlib.sha1(str(repo_root).encode()).hexdigest()[:6]
    return f"{base}-{suffix}"


def _git_tracked(repo_root: Path, name: str) -> bool:
    try:
        r = subprocess.run(["git", "ls-files", "--error-unmatch", name],
                           cwd=repo_root, capture_output=True, text=True)
        return r.returncode == 0
    except (FileNotFoundError, OSError):
        return False


def _ensure_gitignore(repo_root: Path, name: str) -> bool:
    """Add `name` to repo_root/.gitignore if absent. Returns True if it changed."""
    gi = repo_root / ".gitignore"
    lines = gi.read_text().splitlines() if gi.exists() else []
    if name in (ln.strip() for ln in lines):
        return False
    text = gi.read_text() if gi.exists() else ""
    if text and not text.endswith("\n"):
        text += "\n"
    gi.write_text(text + name + "\n")
    return True


def _inject_meta(data, repo_root: Path, key: str) -> None:
    meta = data.get("meta")
    if not isinstance(meta, CommentedMap):
        meta = CommentedMap()
        data.insert(0, "meta", meta)
    meta["linked_from"] = str(repo_root)
    meta["key"] = key
    meta["linked_at"] = now()[:10]
    data.yaml_set_start_comment(HEADER.format(repo=repo_root.name))


def _strip_meta(data) -> None:
    if isinstance(data, dict) and "meta" in data:
        del data["meta"]
    if getattr(data, "ca", None) is not None:
        data.ca.comment = None


# ── commands ──────────────────────────────────────────────────────────────────
def link(local: Path, name: str | None) -> str:
    """Migrate ./TODO.yaml into the global store and leave a symlink behind."""
    repo_root = local.absolute().parent
    if local.is_symlink():
        return f"Already linked: {local} → {local.resolve()}"

    key = _resolve_key(repo_root, name)
    target_dir = global_root() / key
    target = target_dir / "TODO.yaml"
    target_preexisted = target.exists()
    if target_preexisted and _linked_from(target) != str(repo_root):
        die(f"Store already exists at {target}\n"
            "Refusing to overwrite it. Use --name to pick a different key.", 2)

    # 1. Build the store content from the local file (or an empty doc) and write
    #    it FIRST, so the data is safely in the global store before we touch the
    #    repo-root file. Atomic temp+rename via yamlio.save.
    original = local.read_bytes() if local.exists() else None
    y, data = yamlio.load_or_empty(local)
    _inject_meta(data, repo_root, key)
    target_dir.mkdir(parents=True, exist_ok=True)
    yamlio.save(y, target, data)

    # 2. Replace the repo-root file with a symlink to the store. If os.symlink
    #    fails, restore the repo exactly as we found it and surface the error.
    try:
        if local.exists() or local.is_symlink():
            local.unlink()
        os.symlink(os.fspath(target.absolute()), os.fspath(local))
    except OSError as e:
        if original is not None:
            local.write_bytes(original)
        if not target_preexisted:
            target.unlink(missing_ok=True)
            try:
                target_dir.rmdir()
            except OSError:
                pass
        die(f"error: could not create symlink {local} → {target}\n"
            f"  {type(e).__name__}: {e}\n\n"
            "todo link needs symlink support. On Windows, enable Developer Mode\n"
            "(or run as admin); otherwise check filesystem permissions. Nothing\n"
            "was changed.", 1)

    lines = [f"Linked {local} → {target}"]
    if _ensure_gitignore(repo_root, local.name):
        lines.append(f"Added {local.name} to .gitignore")
    if _git_tracked(repo_root, local.name):
        lines.append(f"note: {local.name} is still tracked by git — "
                     f"run `git rm --cached {local.name}` to untrack it.")
    return "\n".join(lines)


def unlink(local: Path) -> str:
    """Inline the global store back into a real ./TODO.yaml and drop the link."""
    if not local.is_symlink():
        die(f"{local} is not a linked store (not a symlink). Nothing to do.", 2)
    target = local.resolve()
    if not target.exists():
        die(f"Broken link: {local} → {target} (target missing). "
            "Remove the dangling symlink yourself.", 2)

    # Load the store, drop the link-only header/meta, then write a REAL file over
    # the symlink. yamlio.save renames a temp sibling onto `local`, atomically
    # replacing the symlink with the inlined content before we delete the store.
    y, data = yamlio.load(target)
    _strip_meta(data)
    yamlio.save(y, local, data)

    target.unlink()
    try:
        target.parent.rmdir()       # remove the key dir only when truly empty
    except OSError:
        pass
    lines = [f"Unlinked {local} (store inlined from {target})"]
    if (local.parent / ".gitignore").exists():
        lines.append(f"note: {local.name} is still listed in .gitignore "
                     "(harmless; remove it if you want to commit the file).")
    return "\n".join(lines)


def project_stores() -> list[dict]:
    """Every global-stored project's location: key, TODO.yaml path, originating
    repo. The raw discovery shared by `projects()` (counts) and the cross-project
    view in the CLI (which loads each store's items)."""
    root = global_root()
    out = []
    if not root.exists():
        return out
    for d in sorted(root.iterdir()):
        f = d / "TODO.yaml"
        if not f.exists():
            continue
        out.append({"key": d.name, "file": f, "linked_from": _linked_from(f)})
    return out


def projects() -> list[dict]:
    """Every global-stored project: key, open-item count, originating repo."""
    return [
        {"key": p["key"], "count": len(store.list_todos(p["file"])),
         "linked_from": p["linked_from"]}
        for p in project_stores()
    ]
