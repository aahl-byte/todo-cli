"""`todo init` — install this repo's canonical `todo` skill into the agent skill
directories so a fresh machine can use the skill end-to-end.

It mirrors the packaged `skill/` folder (the canonical copy that ships inside
this repo) into `~/.agents/skills/todo/` — overwriting changed files, adding new
ones, and dropping stale ones — then points `~/.claude/skills/todo` at that
folder with a symlink (the symlink is folder-level), matching the layout this
project already uses.
"""

import os
from pathlib import Path

AGENTS_SKILL_DIR = Path.home() / ".agents" / "skills" / "todo"
CLAUDE_SKILL_LINK = Path.home() / ".claude" / "skills" / "todo"


def _skill_dir() -> Path:
    """The canonical skill folder that ships inside the installed package."""
    return Path(__file__).resolve().parent / "skill"


def _sync_dir(src: Path, dst: Path) -> list:
    """Mirror `src` into `dst`: overwrite changed files, add new ones, and drop
    stale files `src` no longer has. Returns a list of (relpath, action) for
    everything that changed — empty when `dst` already matched."""
    dst.mkdir(parents=True, exist_ok=True)
    src_files = {p.relative_to(src) for p in src.rglob("*") if p.is_file()}
    dst_files = {p.relative_to(dst) for p in dst.rglob("*") if p.is_file()}

    changes = []
    for rel in sorted(src_files):
        s, d = src / rel, dst / rel
        data = s.read_bytes()
        if not d.exists():
            action = "added"
        elif d.read_bytes() != data:
            action = "updated"
        else:
            continue
        d.parent.mkdir(parents=True, exist_ok=True)
        d.write_bytes(data)
        changes.append((str(rel), action))

    for rel in sorted(dst_files - src_files):   # prune what the canonical no longer ships
        (dst / rel).unlink()
        changes.append((str(rel), "removed"))

    # remove now-empty subdirectories left behind by pruning
    for p in sorted(dst.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if p.is_dir() and not any(p.iterdir()):
            p.rmdir()

    return changes


def _relink(link: Path, target: Path, force: bool) -> str:
    """Point `link` at `target` with a relative symlink. Returns a status word."""
    rel = os.path.relpath(target, link.parent)
    if link.is_symlink():
        if Path(os.readlink(link)) == Path(rel) or link.resolve() == target.resolve():
            return "ok (already linked)"
        if not force:
            return f"skipped (symlink → {os.readlink(link)}; pass --force to repoint)"
        link.unlink()
    elif link.exists():
        if not force:
            return "skipped (a real file/dir is in the way; pass --force to replace)"
        if link.is_dir() and not link.is_symlink():
            return "skipped (refusing to delete a real directory; remove it yourself)"
        link.unlink()
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(rel)
    return f"linked → {rel}"


def do_init(force: bool = False) -> list:
    """Perform the install. Returns a list of (label, status) lines to print."""
    src = _skill_dir()
    if not (src / "SKILL.md").exists():
        raise FileNotFoundError(f"canonical skill missing from package: {src}")

    out = []

    changes = _sync_dir(src, AGENTS_SKILL_DIR)
    if not changes:
        status = "unchanged"
    else:
        status = ", ".join(f"{rel} {action}" for rel, action in changes)
    out.append((f"skill → {AGENTS_SKILL_DIR}", status))

    out.append((f"symlink {CLAUDE_SKILL_LINK}", _relink(CLAUDE_SKILL_LINK, AGENTS_SKILL_DIR, force)))
    return out
