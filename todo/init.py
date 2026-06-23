"""`todo init` — install this repo's canonical `todo` skill into the agent skill
directories so a fresh machine can use the skill end-to-end.

It copies the packaged `SKILL.md` (the canonical copy that ships inside this
repo) to `~/.agents/skills/todo/` and points `~/.claude/skills/todo` at it with a
symlink, matching the layout this project already uses.
"""

import os
from pathlib import Path

AGENTS_SKILL_DIR = Path.home() / ".agents" / "skills" / "todo"
CLAUDE_SKILL_LINK = Path.home() / ".claude" / "skills" / "todo"


def _canonical_skill() -> Path:
    """The SKILL.md that ships inside the installed package."""
    return Path(__file__).resolve().parent / "skill" / "SKILL.md"


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
    src = _canonical_skill()
    if not src.exists():
        raise FileNotFoundError(f"canonical skill missing from package: {src}")

    out = []

    AGENTS_SKILL_DIR.mkdir(parents=True, exist_ok=True)
    dst = AGENTS_SKILL_DIR / "SKILL.md"
    same = dst.exists() and dst.read_text() == src.read_text()
    dst.write_text(src.read_text())
    out.append((f"skill → {dst}", "unchanged" if same else "installed"))

    out.append((f"symlink {CLAUDE_SKILL_LINK}", _relink(CLAUDE_SKILL_LINK, AGENTS_SKILL_DIR, force)))
    return out
