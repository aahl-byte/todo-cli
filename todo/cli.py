"""todo — a tiny CLI over a project's structured `.TODO/` store.

Works in any project: it defaults to ./.TODO in the current working directory
(override with --dir). This module is just the command-line surface —
argument parsing and the thin handlers that glue it to the rest of the package:

    util     process exit, timestamps, stringify
    status   the status lifecycle + terminal colors
    yamlio   the comment-preserving, atomic-write YAML core (durability)
    store    CRUD over the .TODO/ directory tree + fuzzy item lookup
    migrate  one-way conversion of a legacy TODO.yaml
    render   terminal output for list/get
    init     the `todo init` skill installer

The durability contract mirrors the web TODO drawer's (manager/sources/todos.ts
in the watchtower repo) — keep the two in sync if the contract or the store
shape changes.
"""

import argparse
import subprocess
import sys
from pathlib import Path

from . import identity
from . import init as init_mod
from . import link as link_mod
from . import migrate, render, store
from .status import ACTIVE, COMPLETE, SHORTCUT_HELP, SHORTCUTS, STATUSES, TERMINAL
from .util import die, now

# Shortcuts that make no sense for a child task: `deploy` is gated by the item's
# checks.
ITEM_ONLY = {"deploy"}

# Where QA can send work back from.
REJECTABLE = ["ready-for-qa", "in-qa", "ready-to-deploy"]


# ── command handlers ──────────────────────────────────────────────────────────
def _require_root(root: Path) -> None:
    if not root.is_dir():
        die(f"No {store.ROOT_NAME} found at {root}\n(use --dir to point elsewhere)", 2)


def _set_status(root: Path, query: str, status: str, force: bool = False) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(root, query)
    _check_transition(it, status, force)
    forced = (status == "deployed" and it["status"] != status
              and bool(store.pending_pre_deploy(it)))
    store.update_todo(root, it["id"], {"status": status}, now(), forced=forced)
    print(f'{it["id"]}: {it["status"]} → {status}' + ("  (forced past pending checks)" if forced else ""))


def _check_transition(it, status: str, force: bool) -> None:
    """The two rules on a status change: an agent can't hand work to QA, and an
    item can't deploy while a pre-deploy check is pending (unless forced)."""
    if status == "ready-for-qa" and identity.via() == "agent" and it["status"] != status:
        die("An agent parks finished work in `review`; a person hands it to QA.\n"
            "(Run with --human if you are that person.)", 2)
    if status == "deployed" and it["status"] != status and not force:
        pending = store.pending_pre_deploy(it)
        if pending:
            lines = "\n".join(f'  [{c["id"]}] {c["kind"]}  {c["title"]}' for c in pending)
            die(f'{it["id"]} has {len(pending)} pending pre-deploy check(s):\n{lines}\n'
                "Finish them (`todo check done`) or pass --force.", 2)


def _filter_list(items, args, *, default_active: bool):
    """Apply --status / --all / default filtering to a list of items. The
    default (no flags) hides the terminal statuses locally, but narrows to the
    active set across projects."""
    if args.status:
        return [it for it in items if it["status"] == args.status]
    if args.all:
        return items
    if default_active:
        return [it for it in items if it["status"] in ACTIVE]
    return [it for it in items if it["status"] not in TERMINAL]


def _folders(args, default):
    """Only --all or --status needs the parked and finished folders."""
    return store.FOLDERS if args.all or args.status else default


def _mine(items, args):
    if not getattr(args, "mine", False):
        return items
    me = identity.user()
    return [it for it in items if me in (it["developer"], it["qa_assignee"])]


def cmd_list(root: Path, args) -> None:
    if getattr(args, "all_projects", False):
        groups = [
            {"key": p["key"],
             "items": _mine(_filter_list(store.list_todos(p["root"], _folders(args, [store.OPEN])),
                                         args, default_active=True), args)}
            for p in link_mod.project_stores()
        ]
        render.print_grouped(groups)
        return
    _require_root(root)
    items = _filter_list(store.list_todos(root, _folders(args, [store.OPEN])),
                         args, default_active=False)
    render.print_list(_mine(items, args))


def cmd_get(root: Path, args) -> None:
    render.print_item(store.resolve_item(root, args.query), full_log=args.log)


def cmd_status(root: Path, args) -> None:
    _set_status(root, args.query, args.status, args.force)


def cmd_shortcut(root: Path, args) -> None:
    _set_status(root, args.query, SHORTCUTS[args.command], getattr(args, "force", False))


def cmd_status_alias(root: Path, args) -> None:
    # Legacy: the bare status name used as a command (`todo in-progress X`).
    # The subcommand name IS the target status.
    _set_status(root, args.query, args.command, getattr(args, "force", False))


def cmd_reject(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    text = " ".join(args.text).strip()
    if not text:
        die("A rejection needs a comment saying what failed.", 2)
    if it["status"] not in REJECTABLE:
        die(f'{it["id"]} is {it["status"]}; QA rejects from {", ".join(REJECTABLE)}.', 2)
    store.update_todo(root, it["id"], {"status": "in-progress"}, now())
    new_id = store.add_note(root, it["id"], text, now(), kind="qa-rejection",
                            extra={"with_status": "in-progress"})
    print(f'{it["id"]}: {it["status"]} → in-progress  (qa-rejection note [{new_id}])')


def _text(args, what: str) -> str:
    text = " ".join(args.text).strip()
    if not text:
        die(f"Missing {what} text.", 2)
    return text


def cmd_note(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "note"), now(), kind=args.kind)
    print(f'{it["id"]}: added note [{new_id}]' + (f" ({args.kind})" if args.kind != "context" else ""))


def cmd_comment(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "comment"), now(), kind="comment")
    print(f'{it["id"]}: added comment [{new_id}]')


def cmd_url(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    label = (args.label or "").strip()
    new_id = store.add_note(root, it["id"], label or args.url, now(), kind="link",
                            extra={"url": args.url, "label": label or None, "type": args.type})
    print(f'{it["id"]}: added {args.type} link [{new_id}]')


def cmd_ask(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "question"), now(), kind="clarification")
    print(f'{it["id"]}: asked [{new_id}] (open until answered)')


def cmd_answer(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _note_id(it, args.id)
    note = next(n for n in it["notes"] if n["id"] == args.id)
    if note["kind"] != "clarification":
        die(f"Note [{args.id}] is a {note['kind']} note, not a clarification.", 2)
    store.answer_note(root, it["id"], args.id, _text(args, "answer"), now())
    print(f'{it["id"]}: answered [{args.id}]')


def cmd_notes(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    notes = [n for n in it["notes"] if not args.kind or n["kind"] == args.kind]
    if not notes:
        print("(no notes)")
        return
    for line in render.note_lines(notes, indent=""):
        print(line)


def cmd_history(root: Path, args) -> None:
    render.print_history(store.resolve_item(root, args.query))


def cmd_assign(root: Path, args) -> None:
    if args.dev is None and args.qa is None:
        die("Nothing to assign. Pass --dev HANDLE and/or --qa HANDLE (or none).", 2)
    it = store.resolve_item(root, args.query)
    patch = {}
    if args.dev is not None:
        patch["developer"] = None if args.dev.lower() == "none" else args.dev
    if args.qa is not None:
        patch["qa_assignee"] = None if args.qa.lower() == "none" else args.qa
    store.update_todo(root, it["id"], patch)
    shown = ", ".join(f"{k} → {v or '—'}" for k, v in patch.items())
    print(f'{it["id"]}: {shown}')


def _check_id(it, check_id: int) -> None:
    if not any(c["id"] == check_id for c in it["checks"]):
        ids = ", ".join(str(c["id"]) for c in it["checks"]) or "none"
        die(f"No check with id {check_id} (have: {ids}).", 2)


def cmd_checks(root: Path, args) -> None:
    render.print_checks(store.resolve_item(root, args.query))


def cmd_check_add(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo check add <item> <kind> "<title>"', 2)
    timing = "post-deploy" if args.post else "pre-deploy"
    new_id = store.add_check(root, it["id"], args.kind, title, args.payload, timing)
    print(f'{it["id"]}: added {timing} check [{new_id}] {args.kind}  {title}')


def cmd_check_status(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _check_id(it, args.id)
    status = "done" if args.checkcmd == "done" else "pending"
    store.set_check_status(root, it["id"], args.id, status)
    print(f'{it["id"]}: check [{args.id}] → {status}')


def cmd_check_rm(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _check_id(it, args.id)
    store.remove_check(root, it["id"], args.id)
    print(f'{it["id"]}: removed check [{args.id}]')


def cmd_deploy_plan(root: Path, args) -> None:
    _require_root(root)
    everything = store.list_todos(root)
    ready = [store.get_item(root, it["id"]) for it in everything
             if it["status"] == "ready-to-deploy" and it["folder"] == store.OPEN]
    after = [store.get_item(root, it["id"]) for it in everything if it["status"] == "deployed"]
    after = [it for it in after
             if any(c["timing"] == "post-deploy" and c["status"] != "done" for c in it["checks"])]
    complete = {it["id"] for it in everything if it["status"] in COMPLETE}
    render.print_deploy_plan(ready, after, complete, {it["id"] for it in everything})


def cmd_unnote(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _note_id(it, args.id)
    store.remove_note(root, it["id"], args.id)
    print(f'{it["id"]}: removed note [{args.id}]')


def cmd_log(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    text = " ".join(args.text).strip()
    if not text:
        die("Missing log text.", 2)
    new_id = store.add_log(root, it["id"], text, now())
    print(f'{it["id"]}: added log [{new_id}]')


def cmd_logs(root: Path, args) -> None:
    render.print_log(store.resolve_item(root, args.query), args.n)


def cmd_unlog(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _log_id(it, args.id)
    store.remove_log(root, it["id"], args.id)
    print(f'{it["id"]}: removed log [{args.id}]')


def _log_id(it, log_id: int) -> None:
    if not any(e["id"] == log_id for e in it["log"]):
        ids = ", ".join(str(e["id"]) for e in it["log"]) or "none"
        die(f"No log entry with id {log_id} (have: {ids}).", 2)


def _note_id(it, note_id: int) -> None:
    if not any(n["id"] == note_id for n in it["notes"]):
        ids = ", ".join(str(n["id"]) for n in it["notes"]) or "none"
        die(f"No note with id {note_id} (have: {ids}).", 2)


def _task_id(it, task_id: int) -> None:
    if not any(t["id"] == task_id for t in it["tasks"]):
        ids = ", ".join(str(t["id"]) for t in it["tasks"]) or "none"
        die(f"No task with id {task_id} (have: {ids}).", 2)


def cmd_tasks(root: Path, args) -> None:
    render.print_tasks(store.resolve_item(root, args.query))


def cmd_task_add(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo task add <item> "<title>"', 2)
    new_id = store.add_task(root, it["id"], title, args.phase)
    where = f" (phase {args.phase})" if args.phase is not None else ""
    print(f'{it["id"]}: added task [{new_id}] {title}{where}')


def _parse_phase(value: str):
    """A phase is an integer, or one of none/-/clear/null to unset it."""
    v = value.strip().lower()
    if v in ("none", "-", "clear", "null", ""):
        return None
    try:
        return int(v)
    except ValueError:
        die(f'Invalid phase "{value}" (an integer, or "none" to clear).', 2)


def cmd_task_phase(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _task_id(it, args.id)
    phase = _parse_phase(args.value)
    store.set_task_phase(root, it["id"], args.id, phase)
    label = f"phase {phase}" if phase is not None else "no phase"
    print(f'{it["id"]}: task [{args.id}] → {label}')


def cmd_task_move(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _task_id(it, args.id)
    target = args.before if args.before is not None else args.after
    if target is not None:
        _task_id(it, target)
        if target == args.id:
            die(f"Task [{args.id}] can't move relative to itself.", 2)
    phase = store.move_task(root, it["id"], args.id,
                            before=args.before, after=args.after, bottom=args.bottom)
    if target is not None:
        where = f'{"before" if args.before is not None else "after"} [{target}]'
        where += f" (phase {phase})" if phase is not None else " (no phase)"
    else:
        where = "bottom" if args.bottom else "top"
        where += f" of phase {phase}" if phase is not None else " of the unphased tasks"
    print(f'{it["id"]}: task [{args.id}] → {where}')


def _set_task_status(root: Path, query: str, task_id: int, status: str) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(root, query)
    _task_id(it, task_id)
    store.set_task_status(root, it["id"], task_id, status)
    nxt = store.resolve_item(root, it["id"])
    calc = nxt["calc_status"] or "—"
    print(f'{it["id"]}: task [{task_id}] → {status}  (calc-status: {calc})')


def cmd_task_status(root: Path, args) -> None:
    _set_task_status(root, args.query, args.id, args.status)


def cmd_task_shortcut(root: Path, args) -> None:
    _set_task_status(root, args.query, args.id, SHORTCUTS[args.taskcmd])


def cmd_task_rm(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _task_id(it, args.id)
    store.remove_task(root, it["id"], args.id)
    print(f'{it["id"]}: removed task [{args.id}]')


def cmd_add(root: Path, args) -> None:
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo add "<title>"', 2)
    request = (args.request or "").strip()
    it = store.add_todo(root, title, now(), status="requested" if request else "todo")
    if not it:
        die("Could not add (empty title?).", 1)
    if request:
        store.add_note(root, it["id"], request, now(), kind="ticket-request")
    print(f'added {it["id"]}: {it["title"]}' + ("  (requested)" if request else ""))


def cmd_archive(root: Path, args) -> None:
    _require_root(root)
    count, path = store.archive_todos(root)
    if count == 0:
        print("Nothing to archive (no done items).")
    else:
        try:
            shown = path.relative_to(Path.cwd())
        except ValueError:
            shown = path
        print(f"Archived {count} item(s) → {shown}")


def _repo_dir(args) -> Path:
    """The directory holding ./.TODO, UNRESOLVED — link/unlink act on the symlink
    itself, not the global store it resolves to."""
    p = Path(getattr(args, "dir", store.ROOT_NAME))
    return p.parent if p.name == store.ROOT_NAME else p


def cmd_link(root: Path, args) -> None:
    print(link_mod.link(_repo_dir(args), args.name))


def cmd_unlink(root: Path, args) -> None:
    print(link_mod.unlink(_repo_dir(args)))


def cmd_projects(root: Path, args) -> None:
    rows = link_mod.projects()
    if not rows:
        print(f"(no linked projects in {link_mod.global_root()})")
        return
    width = max(len(r["key"]) for r in rows)
    for r in rows:
        origin = f"  ← {r['linked_from']}" if r["linked_from"] else ""
        print(f"{r['key']:<{width}}  {r['count']:>3} item(s){origin}")


def cmd_init(root: Path, args) -> None:
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
        description="Manage a project's structured .TODO/ store from the command line.",
        epilog="lifecycle:\n"
               "  todo → in-triage (planning) → in-progress (developing) → done\n"
               "  team: requested → in-triage → todo → in-progress ⇄ review\n"
               "        → ready-for-qa → in-qa → ready-to-deploy → deployed\n"
               "  `review` awaits user review, `blocked` can't proceed,\n"
               "  `deferred` parks an item off the main path,\n"
               "  `cancelled` means it will never happen.\n\n"
               "<query> matches an id or part of a title, case-insensitively\n"
               "(exact id → exact title → substring); ambiguous queries list candidates.\n\n"
               "examples:\n"
               "  todo list                       # open items (hides done/cancelled)\n"
               "  todo list -g                    # active items across all linked projects\n"
               "  todo get skill-todo             # show one item in full\n"
               "  todo triage skill-todo          # I'm writing the plan\n"
               "  todo start skill-todo           # I'm building it\n"
               '  todo note skill-todo "shipped in <commit>; tests pass"\n'
               '  todo log skill-todo "swapped the regex for a parser"\n'
               "  todo done skill-todo            # finished + verified\n"
               '  todo add "NEW THING TO DO"\n'
               "  todo archive                    # move done items to .TODO/ARCHIVED/\n"
               "  todo init                       # install the todo skill on this machine\n\n"
               "Defaults to ./.TODO; pass --dir to point elsewhere. A legacy\n"
               "TODO.yaml is converted to .TODO/ on first use.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    # --dir is accepted on either side of the subcommand: a top-level option
    # holds the default, and the per-command copy (SUPPRESS default) only
    # overrides the shared namespace when actually passed after the subcommand.
    # --file is its legacy spelling.
    parser.add_argument("--dir", "--file", dest="dir", default=store.ROOT_NAME, metavar="PATH",
                        help="the .TODO directory, or a project holding one (default: ./.TODO)")
    parser.add_argument("--agent", dest="via", action="store_const", const="agent", default=None,
                        help="record this command as an agent's")
    parser.add_argument("--human", dest="via", action="store_const", const="human",
                        help="record this command as a person's (overrides $CLAUDECODE)")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--dir", "--file", dest="dir", default=argparse.SUPPRESS, metavar="PATH",
                        help="the .TODO directory, or a project holding one (default: ./.TODO)")
    common.add_argument("--agent", dest="via", action="store_const", const="agent",
                        default=argparse.SUPPRESS, help=argparse.SUPPRESS)
    common.add_argument("--human", dest="via", action="store_const", const="human",
                        default=argparse.SUPPRESS, help=argparse.SUPPRESS)

    sub = parser.add_subparsers(dest="command", metavar="<command>")

    p = sub.add_parser("list", parents=[common], aliases=["ls"],
                       help="list items (hides done/cancelled by default)")
    p.add_argument("--status", metavar="S", help="only items with this status")
    p.add_argument("--all", action="store_true", help="include done/cancelled items")
    p.add_argument("-g", "--all-projects", action="store_true",
                   help="aggregate active items across every linked project "
                        "(grouped by project; defaults to the active statuses)")
    p.add_argument("--mine", action="store_true",
                   help="only items where I am the developer or QA assignee")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("get", parents=[common], aliases=["show"], help="show one item in full")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("--log", action="store_true",
                   help=f"show the whole dev log (default: last {render.LOG_PREVIEW})")
    p.set_defaults(func=cmd_get)

    p = sub.add_parser("status", parents=[common], help="set any status explicitly")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("status", choices=STATUSES, help="new status")
    p.add_argument("--force", action="store_true",
                   help="deploy even with pending pre-deploy checks")
    p.set_defaults(func=cmd_status)

    for name, helptext in SHORTCUT_HELP.items():
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("query", help="id or part of a title")
        if SHORTCUTS[name] == "deployed":
            p.add_argument("--force", action="store_true",
                           help="deploy even with pending pre-deploy checks")
        p.set_defaults(func=cmd_shortcut)

    p = sub.add_parser("reject", parents=[common],
                       help="→ in-progress with a required qa-rejection comment")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="*", help="what failed QA")
    p.set_defaults(func=cmd_reject)

    p = sub.add_parser("note", parents=[common], help="append a note")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the note text")
    p.add_argument("--kind", choices=store.NOTE_KINDS, default="context",
                   help="note kind (default: context)")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("comment", parents=[common], help="add a comment (@handle mentions)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the comment")
    p.set_defaults(func=cmd_comment)

    p = sub.add_parser("url", parents=[common], help="attach a link (PR, preview, QA handoff)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("url", help="the URL")
    p.add_argument("--type", choices=store.LINK_TYPES, default="other", help="link type")
    p.add_argument("--label", default=None, help="display text (default: the URL)")
    p.set_defaults(func=cmd_url)

    p = sub.add_parser("ask", parents=[common], help="raise a clarification question")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the question")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("answer", parents=[common], help="answer a clarification")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("id", type=int, help="the clarification's note id")
    p.add_argument("text", nargs="+", help="the answer")
    p.set_defaults(func=cmd_answer)

    p = sub.add_parser("notes", parents=[common], help="list an item's notes with indices")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("--kind", choices=store.NOTE_KINDS, default=None, help="only this kind")
    p.set_defaults(func=cmd_notes)

    p = sub.add_parser("history", parents=[common], help="show an item's status history")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_history)

    p = sub.add_parser("assign", parents=[common], help="set the developer and/or QA assignee")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("--dev", default=None, metavar="HANDLE", help='developer ("none" clears)')
    p.add_argument("--qa", default=None, metavar="HANDLE", help='QA assignee ("none" clears)')
    p.set_defaults(func=cmd_assign)

    p = sub.add_parser("checks", parents=[common], help="list an item's deployment checks")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_checks)

    cp = sub.add_parser("check", parents=[common], help="manage an item's deployment checks")
    csub = cp.add_subparsers(dest="checkcmd", metavar="<checkcmd>")
    ca = csub.add_parser("add", parents=[common], help="add a deployment check")
    ca.add_argument("query", help="id or part of a title")
    ca.add_argument("kind", choices=store.CHECK_KINDS, help="check kind")
    ca.add_argument("title", nargs="+", help="what has to happen")
    ca.add_argument("--payload", default=None,
                    help="script path, variable, branch or item id")
    ca.add_argument("--post", action="store_true", help="due after the deploy (default: before)")
    ca.set_defaults(func=cmd_check_add)
    for name, helptext in (("done", "mark a check done"), ("reopen", "mark a check pending")):
        cs = csub.add_parser(name, parents=[common], help=helptext)
        cs.add_argument("query", help="id or part of a title")
        cs.add_argument("id", type=int, help="check id (see `todo checks`)")
        cs.set_defaults(func=cmd_check_status)
    cr = csub.add_parser("rm", parents=[common], help="remove a check")
    cr.add_argument("query", help="id or part of a title")
    cr.add_argument("id", type=int, help="check id (see `todo checks`)")
    cr.set_defaults(func=cmd_check_rm)

    p = sub.add_parser("deploy-plan", parents=[common],
                       help="every check the next deploy needs, across ready-to-deploy items")
    p.set_defaults(func=cmd_deploy_plan)

    p = sub.add_parser("unnote", parents=[common], help="remove note by id")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("id", type=int, help="note id (see `todo notes`)")
    p.set_defaults(func=cmd_unnote)

    p = sub.add_parser("log", parents=[common], help="append a dev-log entry (dated)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the log text")
    p.set_defaults(func=cmd_log)

    p = sub.add_parser("logs", parents=[common], help="show an item's dev log, oldest first")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("-n", type=int, default=None, metavar="N", help="only the last N entries")
    p.set_defaults(func=cmd_logs)

    p = sub.add_parser("unlog", parents=[common], help="remove a log entry by id")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("id", type=int, help="log id (see `todo logs`)")
    p.set_defaults(func=cmd_unlog)

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
    tph.add_argument("id", type=int, help="task id (see `todo tasks`)")
    tph.add_argument("value", help='phase number, or "none" to clear')
    tph.set_defaults(func=cmd_task_phase)

    tmv = tsub.add_parser("move", parents=[common], help="reorder a task within its phase")
    tmv.add_argument("query", help="id or part of a title")
    tmv.add_argument("id", type=int, help="task id (see `todo tasks`)")
    where = tmv.add_mutually_exclusive_group()
    where.add_argument("--before", type=int, metavar="ID",
                       help="place it just before this task (adopting that task's phase)")
    where.add_argument("--after", type=int, metavar="ID",
                       help="place it just after this task (adopting that task's phase)")
    where.add_argument("--top", action="store_true", help="first within its own phase (default)")
    where.add_argument("--bottom", action="store_true", help="last within its own phase")
    tmv.set_defaults(func=cmd_task_move)

    tst = tsub.add_parser("status", parents=[common], help="set a task's status explicitly")
    tst.add_argument("query", help="id or part of a title")
    tst.add_argument("id", type=int, help="task id (see `todo tasks`)")
    tst.add_argument("status", choices=STATUSES, help="new status")
    tst.set_defaults(func=cmd_task_status)

    trm = tsub.add_parser("rm", parents=[common], help="remove a task")
    trm.add_argument("query", help="id or part of a title")
    trm.add_argument("id", type=int, help="task id (see `todo tasks`)")
    trm.set_defaults(func=cmd_task_rm)

    for name, helptext in SHORTCUT_HELP.items():
        if name in ITEM_ONLY:
            continue
        tv = tsub.add_parser(name, parents=[common], help=f"task {helptext}")
        tv.add_argument("query", help="id or part of a title")
        tv.add_argument("id", type=int, help="task id (see `todo tasks`)")
        tv.set_defaults(func=cmd_task_shortcut)

    p = sub.add_parser("add", parents=[common], help="add a new item")
    p.add_argument("title", nargs="+", help="the item title")
    p.add_argument("--request", default=None, metavar="TEXT",
                   help="file it as `requested`, with TEXT as the ticket-request note")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("archive", parents=[common], help="move done items to .TODO/ARCHIVED/")
    p.set_defaults(func=cmd_archive)

    p = sub.add_parser("link", parents=[common],
                       help="store this project's todos in the global store (~/.todo), via a symlink")
    p.add_argument("--name", default=None, metavar="KEY",
                   help="store key (default: repo basename)")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("unlink", parents=[common],
                       help="move the global store back into a real ./.TODO")
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
        if status == "deployed":
            p.add_argument("--force", action="store_true")
        p.set_defaults(func=cmd_status_alias)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        sys.exit(0)
    if args.command in ("task", "check") and not getattr(args, "func", None):
        parser.parse_args([args.command, "--help"])
        sys.exit(0)
    if getattr(args, "via", None):
        identity.set_via(args.via)
    # `init`/`projects` are machine-level; `link`/`unlink` act on the unresolved
    # repo-root path themselves — none of them want a resolved store path.
    if args.command in ("init", "projects", "link", "unlink"):
        root = None
    else:
        root = _resolve_root(args.dir)
    args.func(root, args)


def _resolve_root(raw: str) -> Path:
    """Resolve --dir to a .TODO root, converting a legacy TODO.yaml on the way.
    The path may be the root itself, a project directory holding one, or (the
    legacy --file spelling) a TODO.yaml whose directory gets the root."""
    if raw == store.ROOT_NAME:
        return _project_root(Path.cwd(), worktree=True)
    p = Path(raw).absolute()
    if p.name == migrate.LEGACY_FILE or p.is_file():
        return _project_root(p.parent)
    if p.name != store.ROOT_NAME and not any((p / f).is_dir() for f in store.FOLDERS):
        return _project_root(p)
    return p.resolve()


def _project_root(project: Path, worktree: bool = False) -> Path:
    """`project`/.TODO (symlinks followed), migrating a legacy TODO.yaml first. A
    git worktree with neither falls back to the primary worktree's store — which
    may itself be a link into the global store, so all worktrees of a linked repo
    share one list. With nothing found, returns the would-be path so the normal
    "No .TODO found" message fires."""
    root = project / store.ROOT_NAME
    if root.is_dir():
        return root.resolve()
    migrated = migrate.migrate_repo(project)
    if migrated is not None:
        return migrated.resolve()
    if worktree:
        primary = _primary_worktree(project)
        if primary is not None and primary != project.resolve():
            shared = _project_root(primary)
            if shared.is_dir():
                return shared
    return root


def _primary_worktree(start: Path) -> Path | None:
    """The primary worktree root of the repo containing `start`: the parent of
    `git rev-parse --git-common-dir`."""
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
    return common.parent.resolve()
