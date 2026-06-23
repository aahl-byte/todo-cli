"""todo — a tiny CLI over a project's structured TODO.yaml.

Works in any project: it defaults to ./TODO.yaml in the current working
directory (override with --file). This module is just the command-line surface —
argument parsing and the thin handlers that glue it to the rest of the package:

    util     process exit, timestamps, stringify
    status   the status lifecycle + terminal colors
    yamlio   the comment-preserving, atomic-write YAML core (durability)
    store    CRUD over the todos sequence + fuzzy item lookup
    render   terminal output for list/get

The durability contract mirrors the web TODO drawer's (manager/sources/todos.ts
in the claude-tmux-manager repo) — keep the two in sync if the contract or the
YAML shape changes.
"""

import argparse
import sys
from pathlib import Path

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


# ── argument parsing ──────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="todo",
        description="Manage a project's structured TODO.yaml from the command line.",
        epilog="lifecycle:\n"
               "  todo → in-triage (planning) → in-progress (developing) → done\n"
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
               "  todo archive                    # move done items to ARCHIVE/TODO/\n\n"
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

    p = sub.add_parser("add", parents=[common], help="add a new item")
    p.add_argument("title", nargs="+", help="the item title")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("archive", parents=[common], help="move done items to ARCHIVE/TODO/")
    p.set_defaults(func=cmd_archive)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        sys.exit(0)
    file = Path(args.file).resolve()
    args.func(file, args)
