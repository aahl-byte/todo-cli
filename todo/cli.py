"""todo — a tiny CLI over a project's structured TODO.yaml.

Works in any project: it defaults to ./TODO.yaml in the current working
directory (override with --file). This module is just the command-line surface —
argument parsing and the thin handlers that glue it to the rest of the package:

    util     process exit, timestamps, stringify
    status   the status lifecycle + terminal colors
    yamlio   the comment-preserving, atomic-write YAML core (durability)
    store    CRUD over the todos sequence + fuzzy item lookup
    render   terminal output for list/get
    init     the `todo init` skill installer

The durability contract mirrors the web TODO drawer's (manager/sources/todos.ts
in the claude-tmux-manager repo) — keep the two in sync if the contract or the
YAML shape changes.
"""

import argparse
import subprocess
import sys
from pathlib import Path

from . import init as init_mod
from . import link as link_mod
from . import render, store
from .status import SHORTCUT_HELP, SHORTCUTS, STATUSES
from .util import die, now


# ── command handlers ──────────────────────────────────────────────────────────
def _require_file(file: Path) -> None:
    if not file.exists():
        die(f"No TODO.yaml found at {file}\n(use --file to point elsewhere)", 2)


def _set_status(file: Path, query: str, status: str) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(file, query)
    store.update_todo(file, it["id"], {"status": status}, now())
    print(f'{it["id"]}: {it["status"]} → {status}')


def cmd_list(file: Path, args) -> None:
    _require_file(file)
    items = store.list_todos(file)
    if args.status:
        items = [it for it in items if it["status"] == args.status]
    elif not args.all:
        items = [it for it in items if it["status"] != "done"]
    render.print_list(items)


def cmd_get(file: Path, args) -> None:
    render.print_item(store.resolve_item(file, args.query))


def cmd_status(file: Path, args) -> None:
    _set_status(file, args.query, args.status)


def cmd_shortcut(file: Path, args) -> None:
    _set_status(file, args.query, SHORTCUTS[args.command])


def cmd_status_alias(file: Path, args) -> None:
    # Legacy: the bare status name used as a command (`todo in-progress X`).
    # The subcommand name IS the target status.
    _set_status(file, args.query, args.command)


def cmd_note(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    text = " ".join(args.text).strip()
    if not text:
        die("Missing note text.", 2)
    store.update_todo(file, it["id"], {"notes": [*it["notes"], text]})
    print(f'{it["id"]}: added note [{len(it["notes"])}]')


def cmd_notes(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    if not it["notes"]:
        print("(no notes)")
        return
    for i, n in enumerate(it["notes"]):
        print(f"[{i}] " + str(n).replace("\n", "\n    "))


def cmd_unnote(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    idx = args.index
    if idx < 0 or idx >= len(it["notes"]):
        die(f"Bad index {idx} (have {len(it['notes'])} notes).", 2)
    nxt = list(it["notes"])
    del nxt[idx]
    store.update_todo(file, it["id"], {"notes": nxt})
    print(f'{it["id"]}: removed note [{idx}]')


def _task_index(it, idx: int) -> None:
    if idx < 0 or idx >= len(it["tasks"]):
        die(f"Bad task index {idx} (have {len(it['tasks'])} tasks).", 2)


def cmd_tasks(file: Path, args) -> None:
    render.print_tasks(store.resolve_item(file, args.query))


def cmd_task_add(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo task add <item> "<title>"', 2)
    store.add_task(file, it["id"], title, args.phase)
    where = f" (phase {args.phase})" if args.phase is not None else ""
    print(f'{it["id"]}: added task [{len(it["tasks"])}] {title}{where}')


def _parse_phase(value: str):
    """A phase is an integer, or one of none/-/clear/null to unset it."""
    v = value.strip().lower()
    if v in ("none", "-", "clear", "null", ""):
        return None
    try:
        return int(v)
    except ValueError:
        die(f'Invalid phase "{value}" (an integer, or "none" to clear).', 2)


def cmd_task_phase(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    _task_index(it, args.index)
    phase = _parse_phase(args.value)
    store.set_task_phase(file, it["id"], args.index, phase)
    label = f"phase {phase}" if phase is not None else "no phase"
    print(f'{it["id"]}: task [{args.index}] → {label}')


def _set_task_status(file: Path, query: str, index: int, status: str) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(file, query)
    _task_index(it, index)
    store.set_task_status(file, it["id"], index, status)
    nxt = store.resolve_item(file, it["id"])
    calc = nxt["calc_status"] or "—"
    print(f'{it["id"]}: task [{index}] → {status}  (calc-status: {calc})')


def cmd_task_status(file: Path, args) -> None:
    _set_task_status(file, args.query, args.index, args.status)


def cmd_task_shortcut(file: Path, args) -> None:
    _set_task_status(file, args.query, args.index, SHORTCUTS[args.taskcmd])


def cmd_task_rm(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    _task_index(it, args.index)
    store.remove_task(file, it["id"], args.index)
    print(f'{it["id"]}: removed task [{args.index}]')


def cmd_add(file: Path, args) -> None:
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo add "<title>"', 2)
    it = store.add_todo(file, title, now())
    if not it:
        die("Could not add (empty title?).", 1)
    print(f'added {it["id"]}: {it["title"]}')


def cmd_archive(file: Path, args) -> None:
    _require_file(file)
    count, path = store.archive_todos(file, now())
    if count == 0:
        print("Nothing to archive (no done items).")
    else:
        try:
            shown = path.relative_to(Path.cwd())
        except ValueError:
            shown = path
        print(f"Archived {count} item(s) → {shown}")


def _local_path(args) -> Path:
    """The repo-root TODO.yaml path, UNRESOLVED — link/unlink act on the symlink
    itself, not the global store it resolves to."""
    p = Path(getattr(args, "file", "TODO.yaml"))
    return p / "TODO.yaml" if p.is_dir() else p


def cmd_link(file: Path, args) -> None:
    print(link_mod.link(_local_path(args), args.name))


def cmd_unlink(file: Path, args) -> None:
    print(link_mod.unlink(_local_path(args)))


def cmd_projects(file: Path, args) -> None:
    rows = link_mod.projects()
    if not rows:
        print(f"(no linked projects in {link_mod.global_root()})")
        return
    width = max(len(r["key"]) for r in rows)
    for r in rows:
        origin = f"  ← {r['linked_from']}" if r["linked_from"] else ""
        print(f"{r['key']:<{width}}  {r['count']:>3} item(s){origin}")


def cmd_init(file: Path, args) -> None:
    try:
        results = init_mod.do_init(force=args.force)
    except FileNotFoundError as e:
        die(str(e), 1)
    for label, status in results:
        print(f"{label}\n    {status}")


# ── argument parsing ──────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="todo",
        description="Manage a project's structured TODO.yaml from the command line.",
        epilog="lifecycle:\n"
               "  todo → in-triage (planning) → in-progress (developing) → done\n"
               "  `review` awaits user review, `blocked` can't proceed,\n"
               "  `deferred` parks an item off the main path.\n\n"
               "<query> matches an id or part of a title, case-insensitively\n"
               "(exact id → exact title → substring); ambiguous queries list candidates.\n\n"
               "examples:\n"
               "  todo list                       # open items (hides done)\n"
               "  todo get skill-todo             # show one item in full\n"
               "  todo triage skill-todo          # I'm writing the plan\n"
               "  todo start skill-todo           # I'm building it\n"
               '  todo note skill-todo "shipped in <commit>; tests pass"\n'
               "  todo done skill-todo            # finished + verified\n"
               '  todo add "NEW THING TO DO"\n'
               "  todo archive                    # move done items to ARCHIVE/TODO/\n"
               "  todo init                       # install the todo skill on this machine\n\n"
               "Defaults to ./TODO.yaml; pass --file to point elsewhere.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # --file is accepted on either side of the subcommand: a top-level option
    # holds the default, and the per-command copy (SUPPRESS default) only
    # overrides the shared namespace when actually passed after the subcommand.
    parser.add_argument("--file", default="TODO.yaml", metavar="PATH",
                        help="path to the TODO.yaml (default: ./TODO.yaml)")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--file", default=argparse.SUPPRESS, metavar="PATH",
                        help="path to the TODO.yaml (default: ./TODO.yaml)")

    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("list", parents=[common], aliases=["ls"], help="list items (hides done by default)")
    p.add_argument("--status", metavar="S", help="only items with this status")
    p.add_argument("--all", action="store_true", help="include done items")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", parents=[common], aliases=["show"], help="show one item in full")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("status", parents=[common], help="set any status explicitly")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("status", choices=STATUSES, help="new status")
    p.set_defaults(func=cmd_status)

    for name, helptext in SHORTCUT_HELP.items():
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("query", help="id or part of a title")
        p.set_defaults(func=cmd_shortcut)

    p = sub.add_parser("note", parents=[common], help="append a note")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the note text")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("notes", parents=[common], help="list an item's notes with indices")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_notes)

    p = sub.add_parser("unnote", parents=[common], help="remove note #index")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("index", type=int, help="note index (see `todo notes`)")
    p.set_defaults(func=cmd_unnote)

    p = sub.add_parser("tasks", parents=[common], help="list an item's child tasks")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_tasks)

    tp = sub.add_parser("task", parents=[common], help="manage an item's child tasks")
    tsub = tp.add_subparsers(dest="taskcmd", metavar="<taskcmd>")

    ta = tsub.add_parser("add", parents=[common], help="append a task")
    ta.add_argument("query", help="id or part of a title")
    ta.add_argument("title", nargs="+", help="the task title")
    ta.add_argument("--phase", type=int, default=None, metavar="N",
                    help="phase number (tasks auto-sort by it)")
    ta.set_defaults(func=cmd_task_add)

    tph = tsub.add_parser("phase", parents=[common], help="set/clear a task's phase")
    tph.add_argument("query", help="id or part of a title")
    tph.add_argument("index", type=int, help="task index (see `todo tasks`)")
    tph.add_argument("value", help='phase number, or "none" to clear')
    tph.set_defaults(func=cmd_task_phase)

    tst = tsub.add_parser("status", parents=[common], help="set a task's status explicitly")
    tst.add_argument("query", help="id or part of a title")
    tst.add_argument("index", type=int, help="task index (see `todo tasks`)")
    tst.add_argument("status", choices=STATUSES, help="new status")
    tst.set_defaults(func=cmd_task_status)

    trm = tsub.add_parser("rm", parents=[common], help="remove a task")
    trm.add_argument("query", help="id or part of a title")
    trm.add_argument("index", type=int, help="task index (see `todo tasks`)")
    trm.set_defaults(func=cmd_task_rm)

    for name, helptext in SHORTCUT_HELP.items():
        tv = tsub.add_parser(name, parents=[common], help=f"task {helptext}")
        tv.add_argument("query", help="id or part of a title")
        tv.add_argument("index", type=int, help="task index (see `todo tasks`)")
        tv.set_defaults(func=cmd_task_shortcut)

    p = sub.add_parser("add", parents=[common], help="add a new item")
    p.add_argument("title", nargs="+", help="the item title")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("archive", parents=[common], help="move done items to ARCHIVE/TODO/")
    p.set_defaults(func=cmd_archive)

    p = sub.add_parser("link", parents=[common],
                       help="store this project's todos in the global store (~/.todo), via a symlink")
    p.add_argument("--name", default=None, metavar="KEY",
                   help="store key (default: repo basename)")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("unlink", parents=[common],
                       help="inline the global store back into a real ./TODO.yaml")
    p.set_defaults(func=cmd_unlink)

    p = sub.add_parser("projects", help="list all global-stored projects (~/.todo/projects/*)")
    p.set_defaults(func=cmd_projects)

    p = sub.add_parser("init", help="install the todo skill into ~/.agents and ~/.claude")
    p.add_argument("--force", action="store_true",
                   help="repoint/replace an existing ~/.claude/skills/todo")
    p.set_defaults(func=cmd_init)

    # Legacy aliases: each status name usable directly as a command
    # (`todo in-progress X`). Hidden from help (the verb shortcuts above are the
    # intended UX); names already taken as commands — review, done — are skipped
    # since their shortcut sets the same status.
    for status in STATUSES:
        if status in sub.choices:
            continue
        # No `help=`: argparse keeps the subcommand callable but leaves it out
        # of the listed commands (SUPPRESS would print a literal "==SUPPRESS==").
        p = sub.add_parser(status, parents=[common])
        p.add_argument("query", help="id or part of a title")
        p.set_defaults(func=cmd_status_alias)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        sys.exit(0)
    if args.command == "task" and not getattr(args, "func", None):
        parser.parse_args(["task", "--help"])
        sys.exit(0)
    # `init`/`projects` are machine-level; `link`/`unlink` act on the unresolved
    # repo-root path themselves — none of them want a resolved store path.
    if args.command in ("init", "projects", "link", "unlink"):
        file = None
    else:
        file = _resolve_file(args.file)
    args.func(file, args)


def _resolve_file(raw: str) -> Path:
    """Resolve --file to a TODO.yaml path. Pointing at a directory (the common
    `--file /some/project/` slip) resolves to a YAML inside it rather than
    crashing later with a raw IsADirectoryError: prefer <dir>/TODO.yaml, else a
    lone *.yaml/*.yml. With no (or several) yaml files it resolves to
    <dir>/TODO.yaml so the normal "No TODO.yaml found" message fires."""
    file = Path(raw).resolve()
    if file.is_dir():
        default = file / "TODO.yaml"
        if default.exists():
            return default
        yamls = sorted(p for p in file.glob("*.y*ml") if p.is_file())
        return yamls[0] if len(yamls) == 1 else default
    # A git worktree with no local TODO.yaml falls back to the primary worktree's
    # — which may itself be a symlink into the global store, so all worktrees of a
    # linked repo share one list. Only for the implicit default, never for --file.
    if raw == "TODO.yaml" and not file.exists():
        shared = _worktree_todo(Path.cwd())
        if shared is not None:
            return shared
    return file


def _worktree_todo(start: Path) -> Path | None:
    """Resolve the primary worktree's TODO.yaml from inside a linked worktree.
    `git rev-parse --git-common-dir` points at the main repo's .git; its parent
    is the primary worktree root. Returns the resolved (symlink-followed) path
    if that TODO.yaml exists, else None."""
    try:
        out = subprocess.run(["git", "rev-parse", "--git-common-dir"],
                             cwd=start, capture_output=True, text=True).stdout.strip()
    except (FileNotFoundError, OSError):
        return None
    if not out:
        return None
    common = Path(out)
    if not common.is_absolute():
        common = (start / common).resolve()
    candidate = common.parent / "TODO.yaml"
    return candidate.resolve() if candidate.exists() else None
