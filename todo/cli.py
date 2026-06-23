"""todo — a tiny CLI over a project's structured TODO.yaml.

Works in any project: it defaults to ./TODO.yaml in the current working
directory (override with --file). The comment-preserving, atomic-write CRUD
below mirrors the web TODO drawer's (manager/sources/todos.ts in the
claude-tmux-manager repo) — keep the two in sync if the durability contract or
the YAML shape changes.

Data durability (lens-data-durability): TODO.yaml is a precious, comment-rich
planning artifact, so every mutation (1) re-parses the file fresh off disk —
last-write-wins on the LATEST content, never a stale copy — via ruamel's
round-trip API which PRESERVES comments and surrounding structure, and (2)
writes atomically (temp file + os.replace) so a crash mid-write can never
truncate TODO.yaml.
"""

import argparse
import io
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq
from ruamel.yaml.scalarstring import LiteralScalarString

# ── status lifecycle ─────────────────────────────────────────────────────────
# todo → in-triage (writing a plan) → in-progress (developing) → done.
# `deferred` parks an item off the main path. Keep in sync with TODO.yaml's
# schema header and TodoDrawer's STATUSES ring.
STATUSES = ["todo", "in-triage", "in-progress", "deferred", "done"]
SHORTCUTS = {"triage": "in-triage", "start": "in-progress", "done": "done",
             "defer": "deferred", "reopen": "todo"}


def die(msg: str, code: int = 1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def now() -> str:
    """ISO 8601 with millisecond precision and a Z suffix (matches the JS CLI)."""
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ── yaml engine ───────────────────────────────────────────────────────────────
def _yaml() -> YAML:
    y = YAML()
    y.preserve_quotes = True
    y.width = 80                          # match the JS `yaml` lib's default wrap
    y.indent(mapping=2, sequence=4, offset=2)   # match TODO.yaml's existing shape
    # Emit None as `null` (the file's existing style), not an empty scalar.
    y.representer.add_representer(
        type(None),
        lambda r, _d: r.represent_scalar("tag:yaml.org,2002:null", "null"),
    )
    # Treat ISO timestamps as plain STRINGS, not datetimes: keeps `...683Z`
    # byte-for-byte instead of churning it to `...683000Z`. We both construct
    # them as str AND drop the implicit timestamp resolver so they re-emit
    # UNQUOTED (the resolver would otherwise force quotes to preserve str-ness).
    y.constructor.add_constructor("tag:yaml.org,2002:timestamp", lambda c, n: n.value)
    for first in list(y.resolver.versioned_resolver):
        y.resolver.versioned_resolver[first] = [
            t for t in y.resolver.versioned_resolver[first]
            if t[0] != "tag:yaml.org,2002:timestamp"
        ]
    return y


def _str(v) -> str:
    return "" if v is None else str(v)


def _load(file: Path):
    y = _yaml()
    return y, y.load(file.read_text())


def _load_or_empty(file: Path):
    """Like _load, but a MISSING file yields a fresh empty document — so the
    first `add` into a project with no TODO.yaml creates one. An unreadable
    file still raises."""
    y = _yaml()
    try:
        data = y.load(file.read_text())
    except FileNotFoundError:
        data = None
    if data is None:
        data = y.load("todos: []\n")
    return y, data


def _save(y: YAML, file: Path, data) -> None:
    """Atomic write: render → temp sibling → rename over the original.

    ruamel appends a trailing space when it re-folds a long plain scalar across
    lines (at the SAME fold point as the JS lib, just with a stray space). We
    strip trailing whitespace per line so untouched notes stay byte-identical in
    git. (Trailing spaces inside a `|` block literal would be content; such notes
    don't occur in practice here, so the simpler global rstrip is worth it.)"""
    buf = io.StringIO()
    y.dump(data, buf)
    text = "".join(line.rstrip() + "\n" for line in buf.getvalue().splitlines())
    tmp = file.with_name(file.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, file)


def _seq(data):
    s = data.get("todos") if isinstance(data, dict) else None
    return s if isinstance(s, list) else None


def _find_node(seq, item_id: str):
    for n in seq:
        if isinstance(n, dict) and _str(n.get("id")) == item_id:
            return n
    return None


def _notes_node(notes) -> CommentedSeq:
    """Multi-line notes become YAML block literals (`|`) for readability;
    single-line notes stay plain scalars."""
    seq = CommentedSeq()
    for n in notes:
        s = str(n)
        seq.append(LiteralScalarString(s) if "\n" in s else s)
    return seq


def _to_item(node) -> dict:
    notes_raw = node.get("notes")
    notes = [_str(n) for n in notes_raw] if isinstance(notes_raw, list) else []
    phase = node.get("phase")
    created = node.get("created")
    completed = node.get("completed")
    return {
        "id": _str(node.get("id")),
        "title": _str(node.get("title")),
        "type": _str(node.get("type")) or "feature",
        "status": _str(node.get("status")) or "todo",
        "priority": _str(node.get("priority")) if node.get("priority") is not None else None,
        "phase": int(phase) if phase not in (None, "") else None,
        "notes": notes,
        "created": _str(created) if created not in (None, "") else None,
        "completed": _str(completed) if completed not in (None, "") else None,
    }


# ── CRUD ──────────────────────────────────────────────────────────────────────
def list_todos(file: Path) -> list:
    try:
        _, data = _load(file)
    except FileNotFoundError:
        return []
    seq = _seq(data)
    if seq is None:
        return []
    return [_to_item(n) for n in seq if isinstance(n, dict)]


def _slug_id(title: str, taken: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "item"
    item_id, n = base, 2
    while item_id in taken:
        item_id = f"{base}-{n}"
        n += 1
    return item_id


def add_todo(file: Path, title: str, now_iso: str):
    t = title.strip()
    if not t:
        return None
    y, data = _load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        data["todos"] = CommentedSeq()
        seq = data["todos"]
    taken = {_str(n.get("id")) for n in seq if isinstance(n, dict)}
    item_id = _slug_id(t, taken)
    item = CommentedMap()
    item["id"] = item_id
    item["title"] = t
    item["type"] = "feature"
    item["status"] = "todo"
    item["priority"] = "medium"
    item["phase"] = None
    item["created"] = now_iso
    item["completed"] = None
    seq.append(item)
    _save(y, file, data)
    return {"id": item_id, "title": t, "type": "feature", "status": "todo",
            "priority": "medium", "phase": None, "notes": [],
            "created": now_iso, "completed": None}


def update_todo(file: Path, item_id: str, patch: dict, now_iso=None) -> bool:
    """Patch status/notes/priority/type on an item. `now_iso` stamps `completed`
    when status flips to done and clears it when status leaves done."""
    y, data = _load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return False
    node = _find_node(seq, item_id)
    if node is None:
        return False
    if isinstance(patch.get("status"), str):
        was = _str(node.get("status"))
        node["status"] = patch["status"]
        if patch["status"] == "done" and was != "done":
            node["completed"] = now_iso
        elif patch["status"] != "done" and was == "done":
            node["completed"] = None
    if isinstance(patch.get("notes"), list):
        node["notes"] = _notes_node(patch["notes"])
    if isinstance(patch.get("priority"), str):
        node["priority"] = patch["priority"]
    if isinstance(patch.get("type"), str):
        node["type"] = patch["type"]
    _save(y, file, data)
    return True


def archive_todos(file: Path, stamp: str):
    """Move every `done` item out of TODO.yaml into ARCHIVE/TODO/todo_<stamp>.yaml
    (relative to TODO.yaml's dir). The archive is written FIRST, then the main
    file is pruned — a crash between the two atomic writes duplicates the done
    items (recoverable), never loses them. Returns (count, archive_path)."""
    y, data = _load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return 0, None
    done_idx = [i for i, n in enumerate(seq)
                if isinstance(n, dict) and _str(n.get("status")) == "done"]
    if not done_idx:
        return 0, None
    done_nodes = [seq[i] for i in done_idx]

    safe = re.sub(r"[:.]", "-", stamp)
    archive_dir = file.parent / "ARCHIVE" / "TODO"
    archive_file = archive_dir / f"todo_{safe}.yaml"
    ay, adata = _yaml(), None
    adata = ay.load("todos: []\n")
    adata.yaml_set_start_comment(f" Archived done items — moved out of TODO.yaml at {stamp}.")
    aseq = CommentedSeq()
    for node in done_nodes:                 # reuse AST nodes → inline comments survive
        aseq.append(node)
    adata["todos"] = aseq

    archive_dir.mkdir(parents=True, exist_ok=True)
    _save(ay, archive_file, adata)          # 1. archive lands first

    for i in reversed(done_idx):            # 2. then prune main file (reverse: stable indices)
        del seq[i]
    _save(y, file, data)
    return len(done_nodes), archive_file


# ── fuzzy, case-insensitive item lookup ───────────────────────────────────────
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def resolve_item(file: Path, query: str) -> dict:
    if not file.exists():
        die(f"No TODO.yaml found at {file}\n(use --file to point elsewhere)", 2)
    items = list_todos(file)
    if not query:
        die("Missing <query> (an id or part of a title).", 2)
    q = _norm(query)
    id_exact = [it for it in items if _norm(it["id"]) == q]
    title_exact = [it for it in items if _norm(it["title"]) == q]
    substr = [it for it in items if q in _norm(it["id"]) or q in _norm(it["title"])]
    pick = id_exact or title_exact or substr
    if len(pick) == 1:
        return pick[0]
    if not pick:
        die(f'No todo matches "{query}". Try `todo list`.', 2)
    lines = "\n".join(f'  {it["id"]}  ({it["status"]})  {it["title"]}' for it in pick)
    die(f'"{query}" is ambiguous — {len(pick)} matches:\n{lines}'
        "\nNarrow the query or use the exact id.", 2)


# ── rendering ─────────────────────────────────────────────────────────────────
def _print_list(items) -> None:
    if not items:
        print("(no items)")
        return
    w = min(28, max(len(i["id"]) for i in items))
    for it in items:
        print(f'{it["id"]:<{w}}  {it["status"]:<12} {(it["priority"] or "—"):<8} {it["title"]}')


def _print_item(it) -> None:
    print(f'id:        {it["id"]}')
    print(f'title:     {it["title"]}')
    print(f'type:      {it["type"]}')
    print(f'status:    {it["status"]}')
    print(f'priority:  {it["priority"] or "—"}')
    if it["phase"] is not None:
        print(f'phase:     {it["phase"]}')
    print(f'created:   {it["created"] or "—"}')
    if it["completed"]:
        print(f'completed: {it["completed"]}')
    if it["notes"]:
        print("notes:")
        for i, n in enumerate(it["notes"]):
            print(f'  [{i}] ' + str(n).replace("\n", "\n      "))


# ── command handlers ──────────────────────────────────────────────────────────
def _require_file(file: Path) -> None:
    if not file.exists():
        die(f"No TODO.yaml found at {file}\n(use --file to point elsewhere)", 2)


def _set_status(file: Path, query: str, status: str) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = resolve_item(file, query)
    update_todo(file, it["id"], {"status": status}, now())
    print(f'{it["id"]}: {it["status"]} → {status}')


def cmd_list(file: Path, args) -> None:
    _require_file(file)
    items = list_todos(file)
    if args.status:
        items = [it for it in items if it["status"] == args.status]
    elif not args.all:
        items = [it for it in items if it["status"] != "done"]
    _print_list(items)


def cmd_get(file: Path, args) -> None:
    _print_item(resolve_item(file, args.query))


def cmd_status(file: Path, args) -> None:
    _set_status(file, args.query, args.status)


def cmd_shortcut(file: Path, args) -> None:
    _set_status(file, args.query, SHORTCUTS[args.command])


def cmd_note(file: Path, args) -> None:
    it = resolve_item(file, args.query)
    text = " ".join(args.text).strip()
    if not text:
        die("Missing note text.", 2)
    update_todo(file, it["id"], {"notes": [*it["notes"], text]})
    print(f'{it["id"]}: added note [{len(it["notes"])}]')


def cmd_notes(file: Path, args) -> None:
    it = resolve_item(file, args.query)
    if not it["notes"]:
        print("(no notes)")
        return
    for i, n in enumerate(it["notes"]):
        print(f"[{i}] " + str(n).replace("\n", "\n    "))


def cmd_unnote(file: Path, args) -> None:
    it = resolve_item(file, args.query)
    idx = args.index
    if idx < 0 or idx >= len(it["notes"]):
        die(f"Bad index {idx} (have {len(it['notes'])} notes).", 2)
    nxt = list(it["notes"])
    del nxt[idx]
    update_todo(file, it["id"], {"notes": nxt})
    print(f'{it["id"]}: removed note [{idx}]')


def cmd_add(file: Path, args) -> None:
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo add "<title>"', 2)
    it = add_todo(file, title, now())
    if not it:
        die("Could not add (empty title?).", 1)
    print(f'added {it["id"]}: {it["title"]}')


def cmd_archive(file: Path, args) -> None:
    _require_file(file)
    count, path = archive_todos(file, now())
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

    shortcut_help = {
        "triage": "→ in-triage (planning)",
        "start": "→ in-progress (developing)",
        "done": "→ done (stamps completed)",
        "defer": "→ deferred",
        "reopen": "→ todo",
    }
    for name, helptext in shortcut_help.items():
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
