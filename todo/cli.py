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
import contextlib
import copy
import getpass
import io
import re
import socket
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

from . import actions as actions_mod
from . import identity
from . import init as init_mod
from . import link as link_mod
from . import checkout, docs, filecache, gitfacts, migrate, remote, render, store, sync
from . import connections as connections_mod
from . import plugins as plugins_mod
from .status import ACTIVE, COMPLETE, REASONED, SHORTCUT_HELP, SHORTCUTS, STATUSES, TERMINAL
from .util import die, now

# Shortcuts that make no sense for a child task: `deploy` is gated by the item's
# checks.
ITEM_ONLY = {"deploy"}

# Commands that manage sync themselves.
NO_AUTO_SYNC = {"sync", "whoami", "inbox", "migrate"}
# The command ran, but the server turned down at least one of its changes.
EXIT_SYNC_REJECTED = 4

# Where QA can send work back from.
REJECTABLE = ["ready-for-qa", "in-qa", "qa-approved", "ready-to-deploy"]


# ── command handlers ──────────────────────────────────────────────────────────
def _require_root(root: Path) -> None:
    if not root.is_dir():
        die(f"No {store.ROOT_NAME} found at {root}\n(use --dir to point elsewhere)", 2)


def _set_status(root: Path, query: str, status: str, force: bool = False, reason: str = "") -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(root, query)
    _check_transition(it, status, force)
    forced_edges = bool(_check_edges(root, it, status, force))
    reason = reason.strip()
    if status in REASONED and status != it["status"] and not reason:
        verb = {v: k for k, v in SHORTCUTS.items()}[status]
        die(f'Moving to {status} needs a reason: todo {verb} {it["id"]} "<why>"', 2)
    changed = it["status"] != status
    forced_deploy = status == "deployed" and changed and bool(store.pending_pre_deploy(it))
    forced_handoff = status == "ready-for-qa" and changed and identity.via() == "agent"
    forced = forced_deploy or forced_handoff or forced_edges
    patch = {"status": status}
    if status == "in-progress" and not it["developer"]:
        patch["developer"] = identity.user()
    store.update_todo(root, it["id"], patch, now(), forced=forced)
    note = ""
    if reason and status in REASONED:
        note = f"  (comment [{store.add_note(root, it['id'], reason, now(), kind='comment', extra={'with_status': status})}])"
    flag = "  (forced past pending checks)" if forced_deploy else "  (forced by an agent)" if forced_handoff else ""
    if forced_edges:
        flag += "  (forced past unresolved dependencies)"
    print(f'{it["id"]}: {it["status"]} → {status}' + flag + note)
    if changed:
        plugins_mod.queue(it["id"], {"type": "status", "from": it["status"], "to": status})
    if status in ("in-progress", "review") and sync.enabled(root):
        _warn_empty_fields(it)
    if status != it["status"]:
        for action in _project_actions(root):
            if action.get("runner") == "cli" and actions_mod.fires_on(action, it["status"], status):
                _run_cli_action(root, store.resolve_item(root, it["id"]), action, it["status"], f'{it["status"]} → {status}')


# `todo set` field → the item key it fills.
TRACKED_FIELDS = {"app": "app", "section": "section", "repo": "repo", "branch": "branches"}


def _warn_empty_fields(it) -> None:
    empty = [f for f, key in TRACKED_FIELDS.items() if not it[key]]
    if empty:
        print(f'warning: {it["id"]} has no {", ".join(empty)}. '
              f'Set each with `todo set {it["id"]} <field> <value>`.', file=sys.stderr)


def _check_transition(it, status: str, force: bool) -> None:
    """The two rules on a status change, each lifted by --force: an agent can't
    hand work to QA, and an item can't deploy while a pre-deploy check is pending."""
    if status == "ready-for-qa" and identity.via() == "agent" and it["status"] != status and not force:
        die("An agent parks finished work in `review`; a person hands it to QA.\n"
            "Pass --force only when a person asked you to hand it to QA.\n"
            "(Run with --human if you are that person.)", 2)
    if status == "deployed" and it["status"] != status and not force:
        pending = store.pending_pre_deploy(it)
        if pending:
            lines = "\n".join(f'  [{c["id"]}] {c["kind"]}  {c["title"]}' for c in pending)
            die(f'{it["id"]} has {len(pending)} pending pre-deploy check(s):\n{lines}\n'
                "Finish them (`todo check done`) or pass --force.", 2)


def _check_edges(root: Path, it, status: str, force: bool) -> list:
    """An item can't stage or deploy while it waits on an unresolved
    dependency; --force lifts it. Returns the edges a force went past."""
    if status not in gitfacts.GUARDED or it["status"] == status:
        return []
    edges = gitfacts.unresolved(root, it)
    if edges and not force:
        lines = "\n".join(f"  needs {gitfacts.describe(e)}" for e in edges)
        unknown = any(e["state"] == "unknown" for e in edges)
        die(f'{it["id"]} waits on {len(edges)} unresolved dependenc{"y" if len(edges) == 1 else "ies"}:\n{lines}\n'
            + ("Facts marked unknown couldn't be checked: run `todo refresh` once git and GitHub answer, "
               "or pass --force.\n" if unknown else "")
            + "Land each one in its target first, or pass --force.", 2)
    return edges


def _project_actions(root: Path) -> list:
    return (remote.sync_config(root) or {}).get("actions") or []


def _run_cli_action(root: Path, it, action: dict, frm: str, trigger: str) -> bool:
    """Send a CLI Action for `it` and log the outcome on the item."""
    cfg = remote.sync_config(root) or {}
    req = actions_mod.render(action, actions_mod.item_vars(cfg.get("project", ""), it, frm, identity.user(),
                                                          cfg.get("url", ""), checkout.local()))
    try:
        line, ok = actions_mod.deliver(req), True
    except actions_mod.ActionError as e:
        line, ok = f"failed: {e}", False
    text = f'action {action["name"]} ({trigger}): {line}'
    store.add_log(root, it["id"], text, now())
    print(f'{it["id"]}: {text}', file=sys.stdout if ok else sys.stderr)
    return ok


def _filter_list(items, args, *, default_active: bool):
    """Apply --app / --type, then --status / --all / default filtering to a list
    of items. The default (no flags) hides the terminal statuses locally, but
    narrows to the active set across projects."""
    app, kind = getattr(args, "app", None), getattr(args, "type", None)
    if app:
        items = [it for it in items if it["app"] == app]
    if kind:
        items = [it for it in items if it["type"] == kind]
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
        for p in link_mod.project_stores():
            if sync.enabled(p["root"]):
                sync.rounds(p["root"], lambda r=p["root"]: sync.quiet_round(r))
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
    render.print_list(_mine(items, args), waits=gitfacts.waits(root, items))


def cmd_get(root: Path, args) -> None:
    it = _item_with_docs(root, args.query)
    cfg = remote.sync_config(root) or {}
    render.print_item(it, full_log=args.log, related=related_items(root, it), server=cfg.get("url"),
                      git=gitfacts.view(root, it), plugins=plugins_mod.notices(root, it))
    waiting = store.unseen(it, identity.party())
    if waiting:
        print(f'updates:   {len(waiting)} not yet acknowledged by {identity.party()} (todo updates {it["id"]})')


def related_items(root: Path, it: dict) -> list:
    """Items related to `it` from either side, once each."""
    items = store.list_todos(root)
    by_uid = {x["uid"]: x for x in items if x.get("uid")}
    uids = [(n.get("meta") or {}).get("item") for n in it["notes"] if n["kind"] == "relation"]
    uids += store.relating_to(root, it["uid"]) if it["uid"] else []
    return [by_uid[u] for u in dict.fromkeys(uids) if u in by_uid]


def cmd_status(root: Path, args) -> None:
    _set_status(root, args.query, args.status, args.force, args.reason or "")


def cmd_shortcut(root: Path, args) -> None:
    status = SHORTCUTS[args.command]
    cfg = remote.sync_config(root) or {}
    if status in ("qa-approved", "ready-to-deploy") and cfg.get("deploy_step") is False:
        status = "done"             # a project with no deploy step finishes at QA approval
    _set_status(root, args.query, status, getattr(args, "force", False), " ".join(getattr(args, "reason", None) or []))


def cmd_status_alias(root: Path, args) -> None:
    # Legacy: the bare status name used as a command (`todo in-progress X`).
    # The subcommand name IS the target status.
    _set_status(root, args.query, args.command, getattr(args, "force", False), " ".join(getattr(args, "reason", None) or []))


def cmd_reject(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    text = " ".join(args.text).strip()
    if not text:
        die("A rejection needs a comment saying what failed.", 2)
    if it["status"] not in REJECTABLE:
        die(f'{it["id"]} is {it["status"]}; QA rejects from {", ".join(REJECTABLE)}.', 2)
    store.update_todo(root, it["id"], {"status": "qa-rejected"}, now())
    plugins_mod.queue(it["id"], {"type": "status", "from": it["status"], "to": "qa-rejected"})
    new_id = store.add_note(root, it["id"], text, now(), kind="qa-rejection",
                            extra={"with_status": "qa-rejected"})
    print(f'{it["id"]}: {it["status"]} → qa-rejected  (qa-rejection note [{new_id}])')


def _text(args, what: str) -> str:
    text = " ".join(args.text).strip()
    if not text:
        die(f"Missing {what} text.", 2)
    return text


def cmd_note(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "note"), now(), kind=args.kind)
    print(f'{it["id"]}: added note [{new_id}]' + (f" ({args.kind})" if args.kind != "context" else ""))


def _thread(it, note_id) -> dict:
    """meta placing a note in the thread of question [note_id] (or of the thread that question is in)."""
    if note_id is None:
        return {}
    _note_id(it, note_id)
    root = next(n for n in it["notes"] if n["id"] == note_id)
    if root["kind"] != "clarification":
        die(f"Note [{note_id}] is a {root['kind']} note; follow-ups go under a question.", 2)
    return {"thread": (root.get("meta") or {}).get("thread") or root["uid"]}


def cmd_comment(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "comment"), now(), kind="comment", extra=_thread(it, args.re))
    print(f'{it["id"]}: added comment [{new_id}]' + (f" in question [{args.re}]'s thread" if args.re else ""))


def cmd_url(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    label = (args.label or "").strip()
    new_id = store.add_note(root, it["id"], label or args.url, now(), kind="link",
                            extra={"url": args.url, "label": label or None, "type": args.type})
    print(f'{it["id"]}: added {args.type} link [{new_id}]')


def cmd_request(root: Path, args) -> None:
    if args.text is None:
        if args.url:
            die("--url goes with --text.", 2)
        cmd_shortcut(root, args)
        return
    text = args.text.strip()
    if not text:
        die("Missing request text.", 2)
    it = store.resolve_item(root, args.query)
    url = _url(args.url)
    new_id = store.add_note(root, it["id"], text, now(), kind="ticket-request",
                            extra={"url": url} if url else None)
    if it["status"] == "requested":
        print(f'{it["id"]}: posted request [{new_id}]')
    elif remote.sync_config(root):
        print(f'{it["id"]}: posted request [{new_id}]; on sync the server moves it back to requested for triage')
    else:
        store.update_todo(root, it["id"], {"status": "requested"}, now())
        plugins_mod.queue(it["id"], {"type": "status", "from": it["status"], "to": "requested"})
        print(f'{it["id"]}: posted request [{new_id}]; {it["status"]} → requested for triage')


def _url(raw) -> str | None:
    url = (raw or "").strip()
    if url and not re.match(r"^https?://\S+$", url):
        die("The URL must start with http:// or https://", 2)
    return url or None


def cmd_set(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    value = " ".join(args.value).strip()
    if args.field == "branch" and not value:
        die(_EMPTY_BRANCH, 2)
    value = None if value.lower() in ("", "none", "-") else value
    if args.field in ("title", "type", "priority") and not value:
        die(f"A {args.field} can't be cleared.", 2)
    if args.field == "type" and value not in store.ITEM_TYPES:
        die(f"Unknown type {value!r}; one of: {', '.join(store.ITEM_TYPES)}", 2)
    if args.field == "priority" and value not in store.PRIORITIES:
        die(f"Unknown priority {value!r}; one of: {', '.join(store.PRIORITIES)}", 2)
    if args.field == "branch":
        _set_branches(root, it, [value] if value else [])
        return
    store.update_todo(root, it["id"], {args.field: value})
    print(f'{it["id"]}: {args.field} = {value or "—"}')


def _set_branches(root: Path, it, branches: list) -> None:
    store.update_todo(root, it["id"], {"branches": branches})
    print(f'{it["id"]}: branches = {", ".join(branches) or "—"}')
    for b in branches:
        if b not in it["branches"]:
            plugins_mod.queue(it["id"], {"type": "push", "branch": b})


_EMPTY_BRANCH = "A branch name can't be empty."
_BRANCH_USAGE = "usage: todo branch <query> | todo branch add|rm <query> <name>"


def cmd_branch(root: Path, args) -> None:
    words = args.words
    if len(words) == 1:
        it = store.resolve_item(root, words[0])
        print(f'{it["id"]}: branches = {", ".join(it["branches"]) or "—"}')
        return
    if len(words) != 3 or words[0] not in ("add", "rm"):
        die(_BRANCH_USAGE, 2)
    verb, query, name = words[0], words[1], words[2].strip()
    if not name:
        die(_EMPTY_BRANCH, 2)
    it = store.resolve_item(root, query)
    branches = it["branches"]
    if verb == "add":
        _set_branches(root, it, branches if name in branches else branches + [name])
    else:
        _set_branches(root, it, [b for b in branches if b != name])


def _item_dir(root: Path, it) -> Path:
    return root / it["folder"] / it["id"]


def _doc_url(root: Path, it, name: str) -> str | None:
    """The doc's dashboard page on a synced store."""
    cfg = remote.sync_config(root)
    if cfg is None:
        return None
    q = urllib.parse.quote
    return f'{cfg["url"].rstrip("/")}/p/{q(cfg["project"])}/i/{q(it["id"])}/docs/{q(name)}'


def cmd_doc_add(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    if args.file == "-":
        if not args.name:
            die("A doc read from stdin (-) needs --name.", 2)
        name, data = args.name, sys.stdin.buffer.read()
    else:
        src = Path(args.file)
        if not src.is_file():
            die(f"No such file: {args.file}", 2)
        name = args.name if args.name is not None else src.name
        _check_doc(name, src.stat().st_size)
        data = src.read_bytes()
    _check_doc(name, len(data))
    used = docs.add(_item_dir(root, it), it["uid"], name, data, now())
    note = f" — {name} is another spelling of {used}, so it went there" if used != name else ""
    print(f'{it["id"]}: doc {used} added ({docs.human_size(len(data))}){note}')


def _check_doc(name: str, size: int) -> None:
    err = docs.name_error(name)
    if err:
        die(err, 2)
    if size > docs.MAX_BYTES:
        die(f"{name} is {docs.human_size(size)}; a doc is at most {docs.human_size(docs.MAX_BYTES)}.", 2)


def _item_with_docs(root: Path, query: str):
    """The item, after its waiting doc changes have been written, whatever their size."""
    it = store.resolve_item(root, query)
    if sync.enabled(root):
        sync.fetch_item_docs(root, it["uid"])
        it = store.resolve_item(root, it["id"])
    return it


def _find_doc(root: Path, it, name: str) -> Path:
    found = docs.find(docs.files(_item_dir(root, it)), name)
    if found is None:
        die(f'{it["id"]} has no doc "{name}". See `todo docs {it["id"]}`.', 2)
    return _item_dir(root, it) / docs.DOCS_DIR / found


def cmd_doc_path(root: Path, args) -> None:
    it = _item_with_docs(root, args.query)
    print(_find_doc(root, it, args.name).resolve())


def cmd_doc_rm(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    name = _find_doc(root, it, args.name).name
    docs.remove(_item_dir(root, it), it["uid"], name, now())
    print(f'{it["id"]}: doc {name} removed')


def cmd_docs(root: Path, args) -> None:
    it = _item_with_docs(root, args.query)
    if not it["docs"]:
        print("(no docs)")
        return
    w = max(len(d["name"]) for d in it["docs"])
    for d in it["docs"]:
        where = _doc_url(root, it, d["name"]) or str(d["path"].resolve())
        when = render.stamp(d["at"]) if d["at"] else "—"
        print(f'{d["name"]:<{w}}  {docs.human_size(d["size"]):>9}  {d["by"] or "?"}  {when}  {where}')


def cmd_phase(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    title = " ".join(args.title).strip()
    store.set_phase_title(root, it["id"], args.phase, title)
    print(f'{it["id"]}: phase {args.phase}' + (f" · {title}" if title else " unnamed"))


def _relation(it, other_uid):
    return next((n for n in it["notes"] if n["kind"] == "relation" and (n.get("meta") or {}).get("item") == other_uid), None)


def cmd_relate(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    other = store.resolve_item(root, args.other)
    if other["id"] == it["id"]:
        die("An item can't be related to itself.", 2)
    if not (it["uid"] and other["uid"]):
        die("Both items need an id first: run `todo sync` (or `todo link`) once.", 2)
    if _relation(it, other["uid"]) or _relation(other, it["uid"]):
        print(f'{it["id"]}: already related to {other["id"]}')
        return
    store.add_note(root, it["id"], "related", now(), kind="relation", extra={"item": other["uid"]})
    print(f'{it["id"]}: related to {other["id"]}')


def cmd_unrelate(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    other = store.resolve_item(root, args.other)
    removed = False
    for a, b in ((it, other), (other, it)):
        n = _relation(a, b["uid"])
        if n:
            store.remove_note(root, a["id"], n["id"])
            removed = True
    if not removed:
        die(f'{it["id"]} and {other["id"]} aren\'t related.', 1)
    print(f'{it["id"]}: no longer related to {other["id"]}')


def _jira_args(keys) -> list:
    out = []
    for raw in keys:
        k = raw.strip().upper()
        if not store.JIRA_KEY.match(k):
            die(f"Not a Jira key: {raw!r} (expected e.g. CNS-123)", 2)
        if k not in out:
            out.append(k)
    return out


def cmd_jira_link(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    keys = _jira_args(args.keys)
    added = [k for k in keys if k not in it["jira"]]
    store.update_todo(root, it["id"], {"jira": it["jira"] + added})
    print(f'{it["id"]}: jira {", ".join(it["jira"] + added)}'
          + (f'  (linked {", ".join(added)})' if added else "  (already linked)"))


def cmd_jira_unlink(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    keys = _jira_args(args.keys)
    missing = [k for k in keys if k not in it["jira"]]
    if len(missing) == len(keys):
        die(f'{it["id"]} isn\'t linked to {", ".join(missing)}.', 1)
    left = [k for k in it["jira"] if k not in keys]
    store.update_todo(root, it["id"], {"jira": left})
    print(f'{it["id"]}: jira {", ".join(left) or "—"}')


def cmd_ask(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    new_id = store.add_note(root, it["id"], _text(args, "question"), now(), kind="clarification", extra=_thread(it, args.re))
    print(f'{it["id"]}: asked [{new_id}] (open until answered)' + (f" in question [{args.re}]'s thread" if args.re else ""))


def cmd_answer(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _note_id(it, args.id)
    note = next(n for n in it["notes"] if n["id"] == args.id)
    if note["kind"] != "clarification":
        die(f"Note [{args.id}] is a {note['kind']} note, not a clarification.", 2)
    store.answer_note(root, it["id"], args.id, _text(args, "answer"), now())
    print(f'{it["id"]}: answered [{args.id}]')


def cmd_updates(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    party = identity.party()
    rows = store.unseen(it, party)
    if not rows:
        print(f'{it["id"]}: nothing new for {party}')
        return
    print(f'{it["id"]}: {len(rows)} not yet acknowledged by {party}')
    for line in render.update_lines(rows, every=it["notes"]):
        print(line)
    refs = [f"{kind}{e['id']}" for kind, e in rows]
    if args.ack:
        store.acknowledge(root, it["id"], [(kind, e["id"]) for kind, e in rows], party)
        print(f"acknowledged {' '.join(refs)}")
    else:
        print(f'once handled: todo ack {it["id"]} {" ".join(refs)}')


def _entry_ref(raw: str) -> tuple:
    m = re.fullmatch(r"([nl]?)(\d+)", raw.strip().lower())
    if not m:
        die(f"'{raw}' isn't an entry: use n<id> for a note or question, l<id> for a log entry.", 2)
    return m.group(1) or "n", int(m.group(2))


def cmd_ack(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    refs = [_entry_ref(r) for r in args.refs]
    missing = store.acknowledge(root, it["id"], refs, identity.party())
    if missing:
        die(f'{it["id"]} has no {", ".join(f"{k}{i}" for k, i in missing)}.', 1)
    print(f'{it["id"]}: acknowledged {" ".join(f"{k}{i}" for k, i in refs)} as {identity.party()}')


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


ENV_NAMES = {**{e: e for e in store.ENVIRONMENTS}, **{l.lower(): e for e, l in store.ENVIRONMENTS.items()},
             "prod": "production"}


def cmd_check_status(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _check_id(it, args.id)
    unknown = [n for n in args.envs if n.lower() not in ENV_NAMES]
    if unknown:
        known = ", ".join(f"{e} ({l})" for e, l in store.ENVIRONMENTS.items())
        die(f'Unknown environment {", ".join(unknown)}; one of: {known}', 2)
    named = {ENV_NAMES[n.lower()] for n in args.envs} or set(store.ENVIRONMENTS)
    c = next(c for c in it["checks"] if c["id"] == args.id)
    now_on = set(store.ticked(c)) | named if args.checkcmd == "done" else set(store.ticked(c)) - named
    store.set_check_envs(root, it["id"], args.id, now_on)
    marks = " ".join(l if e in now_on else "·" for e, l in store.ENVIRONMENTS.items())
    status = "done" if store.DONE_ENV in now_on else "pending"
    print(f'{it["id"]}: check [{args.id}] → [{marks}] {status}')


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
    prepping = [it for it in everything if it["status"] == "qa-approved"]
    after = [store.get_item(root, it["id"]) for it in everything if it["status"] == "deployed"]
    after = [it for it in after
             if any(c["timing"] == "post-deploy" and c["status"] != "done" for c in it["checks"])]
    complete = {it["id"] for it in everything if it["status"] in COMPLETE}
    render.print_deploy_plan(ready, after, complete, {it["id"] for it in everything}, prepping)


def cmd_deps(root: Path, args) -> None:
    _require_root(root)
    if args.from_checks:
        rows = gitfacts.from_checks(root)
        for item_id, c in rows:
            print(f'{item_id}  [{c["id"]}]  {c["title"]}  {c["payload"] or "—"}')
        if not rows:
            print("(no prereq-branch checks)")
        return
    items = [store.resolve_item(root, args.query)] if args.query else store.list_todos(root, [store.OPEN])
    shown = 0
    for it in items:
        lines = render.dep_lines(gitfacts.view(root, store.get_item(root, it["id"])))
        if lines or args.query:
            print(it["id"])
            for line in lines or ["  (no dependencies, conflicts or overlaps)"]:
                print(line)
            shown += 1
    if not shown:
        print("(no dependencies, conflicts or overlaps)")


def cmd_refresh(root: Path, args) -> None:
    _require_root(root)
    items = [store.resolve_item(root, args.query)] if args.query else None
    changed = gitfacts.refresh(root, items)
    gitfacts.post_pending(root)
    print(f'git facts: {len(changed)} item(s) changed' + (f' ({", ".join(changed)})' if changed else ""))
    if plugins_mod.off():
        print(f"plugins: off on this host ({plugins_mod.OFF_ENV})")
        return
    targets = items if items is not None else [it for it in store.list_todos(root, [store.OPEN, store.DEFERRED])
                                               if plugins_mod.is_open(root, it)]
    # A store-wide refresh holds each item only while writing it; a named item is held by the command.
    ran = plugins_mod.run_jobs(plugins_mod.Context(root, fresh=True), [(it["id"], {"type": "refresh"}) for it in targets],
                               lock=items is None, report=True)
    if not ran and plugins_mod.host_command() is not None:
        print("plugins: nothing to run")


def cmd_renote(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _note_id(it, args.id)
    text = " ".join(args.text).strip()
    if not text:
        die("Missing note text.", 2)
    store.edit_note(root, it["id"], args.id, text)
    print(f'{it["id"]}: rewrote note [{args.id}]')


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


def cmd_task_title(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    _task_id(it, args.id)
    title = " ".join(args.title).strip()
    if not title:
        die("Missing task title.", 2)
    store.set_task_title(root, it["id"], args.id, title)
    print(f'{it["id"]}: task [{args.id}] · {title}')


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
    url = _url(args.url)
    if url and not request:
        die("--url goes with --request.", 2)
    it = store.add_todo(root, title, now(), status="requested" if request else "todo")
    if not it:
        die("Could not add (empty title?).", 1)
    if args.app or args.section or args.type:
        store.update_todo(root, it["id"], {"app": args.app, "section": args.section,
                                          **({"type": args.type} if args.type else {})})
    if request:
        store.add_note(root, it["id"], request, now(), kind="ticket-request", extra={"url": url} if url else None)
    print(f'added {it["id"]}: {it["title"]}' + ("  (requested)" if request else ""))


def cmd_archive(root: Path, args) -> None:
    _require_root(root)
    count, path = store.archive_todos(root)
    if count == 0:
        print("Nothing to archive (no done or cancelled items).")
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
    repo = _repo_dir(args)
    print(link_mod.link(repo, args.name))
    if args.remote:
        _link_remote(repo, args)


def _link_remote(repo: Path, args) -> None:
    """Make the linked store a synced cache of a server project: create the
    project if needed, adopt what the server has, push what it lacks."""
    root = (repo.absolute() / store.ROOT_NAME).resolve()
    url = args.remote.rstrip("/")
    token = remote.token_for(url)
    if not token:
        die(f"No token for {url}. Run `todo login {url} <token>` first.", 2)
    key = args.project or root.parent.name
    rem = remote.Remote(url, token, timeout=30)
    try:
        project = rem.ensure_project(key)
    except remote.RemoteError as e:
        die(f"Could not reach the server: {e}", 1)
    old = remote.sync_config(root)
    if old and (old["url"].rstrip("/") != url or old["project"] != key):
        # A different server or project: what we knew about the old one is moot.
        for name in (sync.SNAPSHOT_FILE, sync.OUTBOX_FILE):
            (remote.sync_dir(root) / name).unlink(missing_ok=True)
    remote.save_sync_config(root, {"url": url, "project": key,
                                   "deploy_step": project.get("deploy_step", True)})
    report = sync.rounds(root, lambda: sync.run_round(root, rem, adopt=True), wait=True)
    for m in report.messages:
        print(f"sync: {m}")
    if report.doc_failures:
        print(sync.doc_notice(report))
    if report.error:
        die(f"Linked, but the first sync failed: {report.error}\nRun `todo sync` to retry.", 1)
    print(f"Syncing with {url} (project {key}): pushed {report.pushed}, pulled {report.pulled}")


def cmd_sync(root: Path, args) -> None:
    _require_root(root)
    rem = remote.remote_for(root, timeout=30)
    if rem is None:
        die("This store isn't synced. Run `todo link --remote <url>` first.", 2)
    report = sync.rounds(root, lambda: sync.run_round(root, rem, sweep=True), wait=True)
    left = sync.pending(root)
    for m in report.messages:
        print(f"sync: {m}")
    if report.doc_failures:
        print(sync.doc_notice(report))
    print(f"pushed {report.pushed} op(s), {report.rejected} rejected; pulled {report.pulled} change(s)")
    if report.error:
        print(f"offline: {report.error}")
    if left:
        print(f"{len(left)} change(s) not yet on the server:")
        for op in left:
            fields = ", ".join(sorted((op.get("data") or {}).keys())) if op["op"] == "set" else ""
            print(f'  {op["op"]} {op["entity"]} {op["uid"]}' + (f"  ({fields})" if fields else ""))
    if report.rejected:
        sys.exit(EXIT_SYNC_REJECTED)


def _login_token(args) -> str:
    if args.token:
        print("note: a token given on the command line stays in your shell history; "
              "run `todo login <url>` to sign in through your browser instead.", file=sys.stderr)
        return args.token
    if sys.stdin.isatty():
        token = getpass.getpass(f"API token for {args.url.rstrip('/')} (input hidden): ")
    else:
        token = sys.stdin.readline()
    token = token.strip()
    if not token:
        die("No token given.", 2)
    return token


def _browser_login(url: str) -> str | None:
    """Sign in by approving a code in the browser; the token comes back here
    without passing through the terminal. None when the server predates it."""
    rem = remote.Remote(url, None, timeout=15)
    try:
        started = rem.login_start(f"{getpass.getuser()}@{socket.gethostname()}")
    except remote.RemoteError as e:
        if e.status in (404, 405):
            return None
        die(f"Login failed: {e}", 1)
    code = started["user_code"]
    print(f"Open {url.rstrip('/')}/login/device?code={code} in your browser and approve code {code}.")
    deadline = time.monotonic() + started.get("expires_in", 600)
    interval = float(started.get("interval", 3))
    while time.monotonic() < deadline:
        time.sleep(interval)
        try:
            got = rem.login_poll(started["device_code"])
        except remote.RemoteError as e:
            die(f"Login failed: {e}", 1)
        if got["status"] == "approved":
            return got["token"]
        if got["status"] == "expired":
            die("Login failed: the request expired or was denied.", 1)
        if got["status"] == "slow_down":
            interval += 2
    die("Login failed: no approval in time.", 1)


def _still_signed_in(url: str) -> dict | None:
    token = remote.token_for(url)
    if not token:
        return None
    try:
        return remote.Remote(url, token, timeout=15).me()
    except remote.RemoteError:
        return None


def cmd_login(root: Path, args) -> None:
    if not (args.token or args.ask or args.new) and (me := _still_signed_in(args.url)):
        print(f"Already logged in to {args.url.rstrip('/')} as {me['handle']}; keeping the saved token "
              "(--new signs in again).")
        return
    if args.token or args.ask:
        args.token = _login_token(args)
    else:
        args.token = _browser_login(args.url)
        if args.token is None:
            print("This server can't sign in through a browser; paste an API token instead.", file=sys.stderr)
            args.token = _login_token(args)
    rem = remote.Remote(args.url, args.token, timeout=15)
    try:
        me = rem.me()
    except remote.RemoteError as e:
        die(f"Login failed: {e}", 1)
    remote.save_login(args.url, me["handle"], args.token)
    print(f"Logged in to {args.url.rstrip('/')} as {me['handle']}")


def cmd_whoami(root: Path, args) -> None:
    print(f"user: {identity.user()}  (via {identity.via()})")
    cfg = remote.sync_config(root) if root is not None and root.is_dir() else None
    if cfg:
        has = "token saved" if remote.token_for(cfg["url"]) else "no token — run `todo login`"
        print(f'synced: {cfg["url"]} project {cfg["project"]} ({has})')


def cmd_actions(root: Path, args) -> None:
    if not sync.enabled(root):
        die("Actions live on the team server; this store isn't linked with `--remote`.", 2)
    defs = _project_actions(root)
    if not defs:
        print("(no actions; add them on the project's settings page)")
        return
    for a in defs:
        auto = ", ".join(f'{r["from"]} → {r["to"]}' for r in a.get("auto") or []) or "by hand only"
        print(f'{a["id"]:<16} {a["name"]}  [{a["kind"]}, sent by {a["runner"]}]  {auto}')


def cmd_action(root: Path, args) -> None:
    if not sync.enabled(root):
        die("Actions live on the team server; this store isn't linked with `--remote`.", 2)
    it = store.resolve_item(root, args.query)
    action = next((a for a in _project_actions(root) if a["id"] == args.action), None)
    if action is None:
        ids = ", ".join(a["id"] for a in _project_actions(root)) or "none"
        die(f"No action {args.action} (have: {ids}).", 2)
    if action["runner"] == "cli":
        if not _run_cli_action(root, it, action, "", "manual"):
            sys.exit(1)
        return
    rem = remote.remote_for(root, timeout=120)
    try:
        state = rem.run_action(remote.sync_config(root)["project"], it["uid"] or it["id"], action["id"])
    except remote.RemoteError as e:
        die(str(e), 1)
    print(f'{it["id"]}: action {action["name"]}: {state.get("message")}')
    if state.get("done") and not state.get("ok"):
        sys.exit(1)


def cmd_inbox(root: Path, args) -> None:
    rem = remote.remote_for(root, timeout=15) if root is not None and root.is_dir() else None
    if rem is None:
        die("No synced store here; run this inside a project linked with `--remote`.", 2)
    try:
        box = rem.inbox(everything=args.all)
    except remote.RemoteError as e:
        die(str(e), 1)
    rows = box.get("notifications") or []
    if not rows:
        print("(inbox empty)")
        return
    render.print_inbox(rows)
    unread = [r["id"] for r in rows if not r.get("read_at")]
    if unread:
        with contextlib.suppress(remote.RemoteError):
            rem.mark_read(unread)


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


def cmd_migrate(root: Path, args) -> None:
    if args.all_projects:
        stores = [(p["key"], p["root"]) for p in link_mod.project_stores()]
    else:
        _require_root(root)
        stores = [(str(root), root)]
    for label, r in stores:
        fixed = migrate.to_block_style(r)
        print(f"{label}: {len(fixed)} file(s) rewritten in block style")
        for f in fixed:
            print(f"    {f.relative_to(r)}")


def cmd_init(root: Path, args) -> None:
    try:
        results = init_mod.do_init(force=args.force)
    except FileNotFoundError as e:
        die(str(e), 1)
    for label, status in results:
        print(f"{label}\n    {status}")


# ── connections and plugins ──────────────────────────────────────────────────
def _here_repo(root: Path | None) -> str:
    """The repo around the working directory, else the store's own."""
    here = checkout.local()["repo"]
    if here:
        return here
    return gitfacts.store_repo(root)[0] if root is not None and root.is_dir() else ""


def _repo_arg(root: Path, args) -> str:
    key = checkout.repo_key(getattr(args, "repo", None)) if getattr(args, "repo", None) else _here_repo(root)
    if not key:
        die("Which repo? Pass --repo owner/name, or run this inside the repo's checkout.", 2)
    return key


def _plugins_on() -> None:
    if plugins_mod.off():
        die(f"Plugins are off on this host ({plugins_mod.OFF_ENV}=0).", 2)


def _repo_declared(root: Path | None, key: str) -> dict:
    """The connections a repo's plugins file declares, read from its default branch here."""
    if not key or root is None or not root.is_dir():
        return {}
    try:
        described = plugins_mod.Context(root).repo(key)["described"]
    except plugins_mod.HostError:
        return {}
    return (described or {}).get("connections") or {}


def cmd_connection_add(root: Path, args) -> None:
    if bool(args.http) == bool(args.mcp_url):
        die("Give one of --http URL or --mcp-url URL.", 2)
    err = connections_mod.auth_error(args.auth)
    if err:
        die(err, 2)
    if args.mcp_url and args.auth:
        die("--auth goes with --http; an MCP connection sends its secret as a bearer token.", 2)
    for url in (args.http, args.mcp_url):
        if url and not re.match(r"^https?://\S+$", url):
            die("The URL must start with http:// or https://", 2)
    definition = {"http": {"url": args.http, **({"auth": args.auth} if args.auth else {})}} if args.http \
        else {"mcp": {"url": args.mcp_url}}
    connections_mod.save_connection(args.name, definition)
    print(f"connection {args.name}: {_conn_target(definition)} (host-wide, ~/.todo/{connections_mod.CONNECTIONS_FILE})")


def _conn_target(definition: dict) -> str:
    if "http" in definition:
        h = definition["http"] or {}
        return f'http {h.get("url")}' + (f' ({h["auth"]})' if h.get("auth") else "")
    m = definition.get("mcp") or {}
    return f'mcp {m.get("url")}' if m.get("url") else f'mcp command {" ".join([m.get("command") or "", *(m.get("args") or [])]).strip()}'


def _server_secrets(root: Path | None, key: str) -> set | None:
    if root is None or not root.is_dir() or not sync.enabled(root):
        return None
    return set(plugins_mod.Context(root).stored(key)["secrets"])


def cmd_connection_list(root: Path, args) -> None:
    key = checkout.repo_key(args.repo) if args.repo else _here_repo(root)
    rows = []
    declared = _repo_declared(root, key)
    held = _server_secrets(root, key) if key else None
    for name, d in sorted(connections_mod.host_connections().items()):
        if name not in declared:
            rows.append((name, d, connections_mod.host_source(name), None))
    for name, d in sorted(declared.items()):
        rows.append((name, d, f"repo {key}", key))
    if not rows:
        print("(no connections)")
        return
    for name, d, source, repo in rows:
        secret = connections_mod.secret_source(name, repo)
        line = f"{name:<14} {_conn_target(d)}  · {source} · secret here: {secret or 'none'}"
        if held is not None:
            line += f" · on the server: {'yes' if name in held else 'no'}"
        print(line)


def _find_connection(root: Path | None, name: str, repo: str | None) -> tuple:
    """(definition, the repo it belongs to or None for the host's)."""
    declared = _repo_declared(root, repo or _here_repo(root))
    if name in declared:
        return declared[name], repo or _here_repo(root)
    host = connections_mod.host_connections()
    if name in host and not repo:
        return host[name], None
    if repo:
        die(f"{repo}'s plugins file declares no connection {name}.", 2)
    die(f"No connection {name}: add one with `todo connection add {name} --http URL`, "
        "or declare it in the repo's .todo-plugins/plugins.yaml.", 2)


def cmd_connection_test(root: Path, args) -> None:
    repo = checkout.repo_key(args.repo) if args.repo else None
    definition, owner = _find_connection(root, args.name, repo)
    secrets = connections_mod.secrets_for(owner or "")
    secret = (secrets["repo"] if owner else secrets["host"]).get(args.name)
    ok, what = connections_mod.test(definition, secret)
    print(f"{args.name}: {'ok' if ok else 'failed'} — {what}")
    if not ok:
        sys.exit(1)


def _read_secret(name: str) -> str:
    if sys.stdin.isatty():
        secret = getpass.getpass(f"secret for {name} (hidden): ")
    else:
        secret = sys.stdin.readline()
    secret = secret.strip()
    if not secret:
        die("No secret given.", 2)
    return secret


def cmd_connection_auth(root: Path, args) -> None:
    repo = checkout.repo_key(args.repo) if args.repo else None
    cfg = None
    if args.server:
        cfg = remote.sync_config(root) if root is not None and root.is_dir() else None
        if not cfg:
            die("--server needs a synced store (todo link --remote URL).", 2)
        repo = repo or _here_repo(root)
        if not repo:
            die("--server needs the repo: pass --repo owner/name.", 2)
        if args.name not in _repo_declared(root, repo):
            die(f"{repo}'s plugins file declares no connection {args.name}, so this would be a host-wide secret, "
                "and those stay on this host. Declare the connection in the repo, or drop --server.", 2)
    elif repo is None and args.name not in connections_mod.host_connections():
        if args.name in _repo_declared(root, _here_repo(root)):
            repo = _here_repo(root)
    secret = _read_secret(args.name)
    try:
        connections_mod.save_credential(connections_mod.cred_key(args.name, repo), secret)
    except connections_mod.CredentialsError as e:
        die(str(e), 1)
    print(f"connection {args.name}: secret saved for {repo or 'this host'} (~/.todo/{connections_mod.CREDENTIALS_FILE})")
    if not args.server:
        return
    target = repo
    try:
        remote.remote_for(root).plugin_credential(cfg["project"], target, args.name, secret)
    except remote.RemoteError as e:
        if e.status == 503:
            die("The server has no key to encrypt credentials with (TODO_SECRET_KEY); it kept nothing.", 1)
        die(f"The server didn't take it: {e}", 1)
    print(f"connection {args.name}: secret sent to {cfg['url']} for {target}")


def _trigger_text(t) -> str:
    if isinstance(t, dict):
        st = t.get("status") or {}
        return f'status:{st.get("from") or "*"}:{st.get("to") or "*"}'
    return str(t)


_TRIGGERS = "push, pr, deployment, manual or status:<from>:<to> (* for any)"


def _status_pair(raw: str) -> tuple:
    """(from, to) from `status:<from>:<to>`, or None."""
    parts = raw.split(":")
    if len(parts) != 3 or parts[0] != "status" or not parts[1] or not parts[2]:
        return None
    return parts[1], parts[2]


def _parse_trigger(raw: str):
    if raw in ("push", "pr", "deployment", "manual"):
        return raw
    pair = _status_pair(raw)
    if pair is None:
        die(f"Unknown trigger {raw!r}: {_TRIGGERS}.", 2)
    return {"status": {"from": pair[0], "to": pair[1]}}


def _parse_settings(pairs) -> dict:
    out = {}
    for pair in pairs or []:
        k, sep, v = pair.partition("=")
        if not sep or not k:
            die(f"--set takes key=value, not {pair!r}", 2)
        try:
            from ruamel.yaml import YAML
            out[k] = YAML(typ="safe").load(v) if v else ""
        except Exception:  # noqa: BLE001 — anything unparseable is text
            out[k] = v
        if not isinstance(out[k], (str, int, float, bool, list)) or out[k] is None:
            out[k] = v
    return out


def cmd_plugin_list(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()
    ctx = plugins_mod.Context(root, fresh=True)
    keys = [checkout.repo_key(args.repo)] if args.repo else sorted(
        {ctx.repo_key(it) for it in store.list_todos(root, [store.OPEN, store.DEFERRED])} - {""}
        | ({_here_repo(root)} - {""}))
    if not keys:
        print("(no repos: give --repo owner/name)")
        return
    if plugins_mod.host_command() is None:
        die(plugins_mod.NO_NODE, 1)
    for key in keys:
        repo = ctx.repo(key)
        print(key + ("" if repo["payload"] else "  (no .todo-plugins/plugins.yaml; shipped defaults only)"))
        for err in (repo["described"] or {}).get("errors") or []:
            print(f"  error: {err}")
        for p, insts in plugins_mod.plugin_view(ctx, key):
            bits = [", ".join(_trigger_text(t) for t in p.get("on") or []) or "no triggers"]
            if p.get("every"):
                bits.append(f'every {p["every"]}')
            if p.get("connections"):
                bits.append("needs " + ", ".join(p["connections"]))
            print(f'  {p["name"]}{" (shipped)" if p.get("shipped") else ""}  on: ' + " · ".join(bits))
            for i in insts:
                state = "off" if i.get("enabled") is False else "on"
                extra = []
                if i.get("on") is not None:
                    extra.append("on: " + (", ".join(_trigger_text(t) for t in i["on"]) or "nothing"))
                if i.get("settings"):
                    extra.append("settings: " + ", ".join(f"{k}={v}" for k, v in i["settings"].items()))
                if i.get("dry_run"):
                    extra.append("dry-run")
                if i.get("implicit"):
                    extra.append("implicit")
                name = f' "{i["name"]}"' if i.get("name") and i["name"] != i.get("id") else ""
                print(f'    {i.get("id")}{name}  {state}' + "".join(f"  · {e}" for e in extra))
            if not insts:
                print("    (no instances: add one with `todo plugin add`)")


def _split_iid(raw: str) -> tuple:
    plugin, sep, inst = raw.partition("/")
    if not sep or not plugin or not inst:
        die(f"Name the instance as <plugin>/<id>, not {raw!r}.", 2)
    return plugin, inst


def _edit_instances(root: Path, args, plugin: str, edit) -> None:
    ctx = plugins_mod.Context(root, fresh=True)
    key = _repo_arg(root, args)
    rows = copy.deepcopy(ctx.stored(key)["instances"].get(plugin) or [])
    rows = edit(rows, ctx, key)
    try:
        ctx.save_stored(key, plugin, rows)
    except remote.RemoteError as e:
        die(f"The server didn't take it: {e}", 1)


def _known_plugin(ctx, key: str, plugin: str) -> dict | None:
    try:
        return next((p for p, _ in plugins_mod.plugin_view(ctx, key) if p["name"] == plugin), None)
    except plugins_mod.HostError:
        return None


def _instance_patch(args) -> dict:
    patch = {}
    if getattr(args, "label", None):
        patch["name"] = args.label
    if getattr(args, "on", None):
        patch["on"] = [] if args.on == ["none"] else [_parse_trigger(t) for t in args.on]
    if getattr(args, "button", None):
        patch["button"] = args.button
    if getattr(args, "enabled", None) is not None:
        patch["enabled"] = args.enabled
    if getattr(args, "dry_run", None) is not None:
        patch["dry_run"] = args.dry_run
    return patch


def cmd_plugin_add(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()

    def edit(rows, ctx, key):
        if _known_plugin(ctx, key, args.plugin) is None and plugins_mod.host_command() is not None:
            die(f"{key} runs no plugin {args.plugin} (see `todo plugin list --repo {key}`).", 2)
        if any(r.get("id") == args.id for r in rows):
            die(f"{args.plugin}/{args.id} exists; change it with `todo plugin set {args.plugin}/{args.id}`.", 2)
        row = {"id": args.id, "name": args.id, **_instance_patch(args)}
        settings = _parse_settings(args.set)
        if settings:
            row["settings"] = settings
        return rows + [row]
    _edit_instances(root, args, args.plugin, edit)
    print(f"plugin {args.plugin}: added instance {args.id}")


def cmd_plugin_set(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()
    plugin, inst = _split_iid(args.instance)

    def edit(rows, ctx, key):
        row = next((r for r in rows if r.get("id") == inst), None)
        if row is None:
            known = next((i for p, insts in plugins_mod.plugin_view(ctx, key) if p["name"] == plugin
                          for i in insts if i.get("id") == inst), None) if plugins_mod.host_command() else None
            if known is None and plugins_mod.host_command() is not None:
                die(f"No instance {plugin}/{inst} in {key} (see `todo plugin list`).", 2)
            row = {"id": inst, "name": (known or {}).get("name") or inst}
            rows = rows + [row]
        row.update(_instance_patch(args))
        settings = {**(row.get("settings") or {}), **_parse_settings(args.set)}
        for k in args.unset or []:
            settings.pop(k, None)
        if settings:
            row["settings"] = settings
        else:
            row.pop("settings", None)
        return rows
    _edit_instances(root, args, plugin, edit)
    print(f"plugin {plugin}: set instance {inst}")


def cmd_plugin_rm(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()
    plugin, inst = _split_iid(args.instance)

    def edit(rows, ctx, key):
        if not any(r.get("id") == inst for r in rows):
            die(f"No stored instance {plugin}/{inst} in {key}; one the repo file declares is turned off with "
                f"`todo plugin set {plugin}/{inst} --disable`.", 2)
        return [r for r in rows if r.get("id") != inst]
    _edit_instances(root, args, plugin, edit)
    print(f"plugin {plugin}: removed instance {inst}")


def _parse_event(raw: str | None, it) -> dict:
    """refresh | push[:branch] | pr[:branch] | deployment[:branch] | status:<from>:<to> | manual:<instance>"""
    raw = raw or "refresh"
    kind, _, rest = raw.partition(":")
    if kind == "refresh" and not rest:
        return {"type": "refresh"}
    if kind in plugins_mod.GIT_TRIGGERS:
        branch = rest or (it["branches"][0] if it["branches"] else "")
        if not branch:
            die(f"{it['id']} has no branch; give one as {kind}:<branch>.", 2)
        return {"type": kind, "branch": branch}
    if kind == "status":
        pair = _status_pair(raw)
        if pair is None or "*" in pair:
            die(f"An event names both statuses: status:<from>:<to>, not {raw!r}.", 2)
        return {"type": "status", "from": pair[0], "to": pair[1]}
    if kind == "manual" and rest:
        return {"type": "manual", "instance": rest}
    die(f"Unknown event {raw!r}: refresh, push[:branch], pr[:branch], deployment[:branch], "
        "status:<from>:<to> or manual:<instance>.", 2)


def _item_on_branch(root: Path):
    r = subprocess.run(["git", "branch", "--show-current"], capture_output=True, text=True)
    branch = r.stdout.strip() if r.returncode == 0 else ""
    found = [it for it in store.list_todos(root, [store.OPEN, store.DEFERRED]) if branch and branch in it["branches"]]
    if len(found) != 1:
        die("Name the item to test against: todo plugin test <plugin> <query>.", 2)
    return store.resolve_item(root, found[0]["id"])


def cmd_plugin_test(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()
    it = store.resolve_item(root, args.query) if args.query else _item_on_branch(root)
    event = _parse_event(args.event, it)
    ctx = plugins_mod.Context(root, local=args.local, fresh=True)
    runs = plugins_mod.run(ctx, it, event, dry_run=True, only=args.plugin, anywhere=True)
    if runs is None:
        sys.exit(1)
    print(f'{it["id"]}: {args.plugin} on {plugins_mod.event_label(event)}'
          + (" (working tree)" if args.local else "") + " — dry run")
    if not runs:
        print("  fires no instance for this event")
        return
    for r in runs:
        print("  " + "\n  ".join(render.plugin_run_lines(plugins_mod.instance_id(r["plugin"], r["instance"]), r["result"])))


def cmd_plugin_run(root: Path, args) -> None:
    _require_root(root)
    _plugins_on()
    it = store.resolve_item(root, args.query)
    inst = args.instance.rpartition("/")[2]
    event = {"type": "manual", "instance": inst}
    ctx = plugins_mod.Context(root, fresh=True)
    key = ctx.repo_key(it)
    candidates = [plugins_mod.instance_id(p["name"], i) for p, insts in (plugins_mod.plugin_view(ctx, key) if key else [])
                  for i in insts if plugins_mod.fires(p, i, event)
                  and args.instance in (i.get("id"), plugins_mod.instance_id(p["name"], i))]
    if not candidates:
        die(f"No manual instance {args.instance} for {it['id']} (see `todo plugin list`).", 2)
    if len(candidates) > 1:
        die(f"{args.instance} names more than one manual instance: {', '.join(candidates)}; give one of them.", 2)
    runs = plugins_mod.run(ctx, it, event, only=candidates[0], anywhere=True, lock=False)
    if runs is None:
        sys.exit(1)
    for line in plugins_mod.run_lines(it, runs, " (ran on this host)"):
        print(line)


def cmd_plugins(root: Path, args) -> None:
    it = store.resolve_item(root, args.query)
    recs = plugins_mod.records(root, it)
    server = plugins_mod.server_runs(root, it)
    if not recs and not server:
        print(f'{it["id"]}: no plugin has run on it here')
        return
    for iid, rec in sorted(recs.items()):
        print(f'{iid}  {render.stamp(rec.get("at") or "")}  ({rec.get("event") or "?"})')
        for line in render.plugin_record_lines(rec):
            print("  " + line)
    for iid, rec in sorted(server.items()):
        what = f'error: {rec["error"]}' if rec.get("error") else f'skipped: {rec["skipped"]}' if rec.get("skipped") else "ran"
        print(f'{iid}  {render.stamp(str(rec.get("at") or ""))}  (on the server)  {what}')


# ── argument parsing ──────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="todo",
        description="Manage a project's structured .TODO/ store from the command line.",
        epilog="lifecycle:\n"
               "  todo → in-triage (planning) → in-progress (developing) → done\n"
               "  team: requested → in-triage → todo → in-progress ⇄ review\n"
               "        → ready-for-qa → in-qa → qa-approved → ready-to-deploy → deployed\n"
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
               "  todo archive                    # archive done and cancelled items\n"
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
    p.add_argument("--app", metavar="A", help="only items for this app")
    p.add_argument("--type", choices=store.ITEM_TYPES, help="only items of this type")
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
                   help="stage or deploy past pending pre-deploy checks or unresolved dependencies; "
                        "as an agent, hand to QA when a person asked")
    p.add_argument("--reason", default=None, help=f"why; required for {' and '.join(REASONED)}")
    p.set_defaults(func=cmd_status)

    for name, helptext in SHORTCUT_HELP.items():
        if name == "request":
            p = sub.add_parser(name, parents=[common],
                               help="→ requested; with --text, post a new version of the ticket request")
            p.add_argument("query", help="id or part of a title")
            p.add_argument("-t", "--text", default=None, help="the full new request text")
            p.add_argument("--url", default=None, help="where it happens")
            p.set_defaults(func=cmd_request)
            continue
        p = sub.add_parser(name, parents=[common], help=helptext)
        p.add_argument("query", help="id or part of a title")
        if SHORTCUTS[name] == "deployed":
            p.add_argument("--force", action="store_true",
                           help="deploy even with pending pre-deploy checks or unresolved dependencies")
        if SHORTCUTS[name] == "ready-to-deploy":
            p.add_argument("--force", action="store_true", help="stage even with unresolved dependencies")
        if SHORTCUTS[name] == "ready-for-qa":
            p.add_argument("--force", action="store_true",
                           help="as an agent, hand to QA when a person asked")
        if SHORTCUTS[name] in REASONED:
            p.add_argument("reason", nargs="*", help="why (required; posted as a comment)")
        p.set_defaults(func=cmd_shortcut)

    p = sub.add_parser("reject", parents=[common],
                       help="→ qa-rejected with a required qa-rejection comment")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="*", help="what failed QA")
    p.set_defaults(func=cmd_reject)

    p = sub.add_parser("note", parents=[common], help="append a note")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the note text")
    p.add_argument("--kind", choices=[k for k in store.NOTE_KINDS if k != "dependency"], default="context",
                   help="note kind (default: context)")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("comment", parents=[common], help="add a comment (@handle mentions)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("text", nargs="+", help="the comment")
    p.add_argument("--re", type=int, metavar="ID", help="reply in the thread of question [ID]")
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
    p.add_argument("--re", type=int, metavar="ID", help="a follow-up in the thread of question [ID]")
    p.set_defaults(func=cmd_ask)

    p = sub.add_parser("answer", parents=[common], help="answer a clarification")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("id", type=int, help="the clarification's note id")
    p.add_argument("text", nargs="+", help="the answer")
    p.set_defaults(func=cmd_answer)

    p = sub.add_parser("updates", parents=[common],
                       help="list the notes, answers and log entries you haven't acknowledged")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("--ack", action="store_true", help="acknowledge everything listed")
    p.set_defaults(func=cmd_updates)

    p = sub.add_parser("ack", parents=[common], help="acknowledge notes (n<id>) or log entries (l<id>)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("refs", nargs="+", help="n<id> for a note or question, l<id> for a log entry")
    p.set_defaults(func=cmd_ack)

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
    for name, helptext in (("done", "tick a check for environments (all when none named)"),
                           ("reopen", "untick a check for environments (all when none named)")):
        cs = csub.add_parser(name, parents=[common], help=helptext)
        cs.add_argument("query", help="id or part of a title")
        cs.add_argument("id", type=int, help="check id (see `todo checks`)")
        cs.add_argument("envs", nargs="*", metavar="ENV", help="dev|staging|production, or D|S|P")
        cs.set_defaults(func=cmd_check_status)
    cr = csub.add_parser("rm", parents=[common], help="remove a check")
    cr.add_argument("query", help="id or part of a title")
    cr.add_argument("id", type=int, help="check id (see `todo checks`)")
    cr.set_defaults(func=cmd_check_rm)

    p = sub.add_parser("deploy-plan", parents=[common],
                       help="every check the next deploy needs, across ready-to-deploy items")
    p.set_defaults(func=cmd_deploy_plan)

    p = sub.add_parser("deps", parents=[common],
                       help="what an item needs and what needs it, with conflicts and overlaps (from git)")
    p.add_argument("query", nargs="?", help="id or part of a title (default: every open item with any)")
    p.add_argument("--from-checks", action="store_true",
                   help="list every prereq-branch check, to drop or confirm")
    p.set_defaults(func=cmd_deps)

    p = sub.add_parser("refresh", parents=[common], help="recompute git facts and run refreshed plugins now")
    p.add_argument("query", nargs="?", help="id or part of a title (default: every open item)")
    p.set_defaults(func=cmd_refresh)

    cp = sub.add_parser("connection", parents=[common], help="endpoints plugins call, and this host's secrets for them")
    csub = cp.add_subparsers(dest="conncmd", metavar="<conncmd>")
    ca = csub.add_parser("add", parents=[common], help="add or replace a host-wide connection")
    ca.add_argument("name")
    ca.add_argument("--http", metavar="URL", help="an HTTP API's base URL")
    ca.add_argument("--auth", help="how the secret is sent: bearer, basic (user:password) or header:<name>")
    ca.add_argument("--mcp-url", metavar="URL", help="an MCP server's streamable-HTTP URL")
    ca.set_defaults(func=cmd_connection_add)
    cl = csub.add_parser("list", parents=[common], help="each connection, where it's declared, and who holds its secret")
    cl.add_argument("--repo", help="owner/name (default: the repo here)")
    cl.set_defaults(func=cmd_connection_list)
    ct = csub.add_parser("test", parents=[common], help="make one read-only call through a connection")
    ct.add_argument("name")
    ct.add_argument("--repo", help="the repo that declares it (owner/name)")
    ct.set_defaults(func=cmd_connection_test)
    cu = csub.add_parser("auth", parents=[common], help="store a connection's secret (read hidden, or from stdin)")
    cu.add_argument("name")
    cu.add_argument("--repo", help="for this repo's connection of that name (owner/name); default: the host's")
    cu.add_argument("--server", action="store_true", help="also send it to the server, which keeps it encrypted")
    cu.set_defaults(func=cmd_connection_auth)

    pp = sub.add_parser("plugin", parents=[common], help="list, configure, test and run a repo's plugins")
    psub = pp.add_subparsers(dest="plugincmd", metavar="<plugincmd>")
    pl = psub.add_parser("list", parents=[common], help="each repo's plugins, instances, triggers and on/off state")
    pl.add_argument("--repo", help="owner/name (default: every repo with open items)")
    pl.set_defaults(func=cmd_plugin_list)

    def instance_flags(q, adding: bool):
        q.add_argument("--repo", help="owner/name (default: the repo here)")
        q.add_argument("--name", dest="label", help="the instance's display name")
        q.add_argument("--on", action="append", metavar="TRIGGER",
                       help="push, pr, deployment, manual or status:<from>:<to> (* for any); repeat for more "
                            "(overrides the plugin's own; `none` for no triggers)")
        q.add_argument("--set", action="append", metavar="KEY=VALUE", help="a setting; repeat for more")
        q.add_argument("--button", help="the label of its manual button")
        q.add_argument("--enable", dest="enabled", action="store_const", const=True, default=None)
        q.add_argument("--disable", dest="enabled", action="store_const", const=False)
        q.add_argument("--dry-run", dest="dry_run", action="store_const", const=True, default=None,
                       help="only make read-only calls; log the rest as would-send")
        if not adding:
            q.add_argument("--live", dest="dry_run", action="store_const", const=False, help="turn dry-run off")
            q.add_argument("--unset", action="append", metavar="KEY", help="drop a setting back to its default")
    pa = psub.add_parser("add", parents=[common], help="add an instance of a plugin")
    pa.add_argument("plugin")
    pa.add_argument("id", help="the instance's id, unique within the plugin")
    instance_flags(pa, True)
    pa.set_defaults(func=cmd_plugin_add)
    ps = psub.add_parser("set", parents=[common], help="change an instance, or override one the repo file declares")
    ps.add_argument("instance", help="<plugin>/<id>")
    instance_flags(ps, False)
    ps.set_defaults(func=cmd_plugin_set)
    pr = psub.add_parser("rm", parents=[common], help="remove a stored instance")
    pr.add_argument("instance", help="<plugin>/<id>")
    pr.add_argument("--repo", help="owner/name (default: the repo here)")
    pr.set_defaults(func=cmd_plugin_rm)
    pt = psub.add_parser("test", parents=[common], help="dry-run one plugin against an item: what it would attach and send")
    pt.add_argument("plugin", help="<plugin> or <plugin>/<id>")
    pt.add_argument("query", nargs="?", help="id or part of a title (default: the item on the current branch)")
    pt.add_argument("--local", action="store_true", help="read .todo-plugins/ from the working tree, not the default branch")
    pt.add_argument("--event", help="refresh (default), push[:branch], pr[:branch], deployment[:branch], "
                                    "status:<from>:<to> or manual:<instance>")
    pt.set_defaults(func=cmd_plugin_test)
    pn = psub.add_parser("run", parents=[common], help="run a manual instance on an item now")
    pn.add_argument("query", help="id or part of a title")
    pn.add_argument("instance", help="<id> or <plugin>/<id>")
    pn.set_defaults(func=cmd_plugin_run)

    p = sub.add_parser("plugins", parents=[common], help="an item's plugin results: what each attached, skipped or failed")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_plugins)

    p = sub.add_parser("renote", parents=[common], help="replace a note's text, keeping its id")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("id", type=int, help="note id (see `todo notes`)")
    p.add_argument("text", nargs="+", help="the new text")
    p.set_defaults(func=cmd_renote)

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

    tt = tsub.add_parser("title", parents=[common], help="retitle a task")
    tt.add_argument("query", help="id or part of a title")
    tt.add_argument("id", type=int, help="task id (see `todo tasks`)")
    tt.add_argument("title", nargs="+", help="the new title")
    tt.set_defaults(func=cmd_task_title)

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
    p.add_argument("--url", default=None, help="with --request: where it happens")
    p.add_argument("--app", default=None, help="the app it's about")
    p.add_argument("--section", default=None, help="the section of that app")
    p.add_argument("--type", choices=store.ITEM_TYPES, default=None, help="item type (default: feature)")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("set", parents=[common], help="set an item's title, type, priority, app, section, repo or branch "
                            "(branch replaces the list; none clears all but title, type and priority)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("field", choices=["title", "type", "priority", "app", "section", "repo", "branch"])
    p.add_argument("value", nargs="+", help="the value, or none")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("phase", parents=[common], help="name a phase of an item's tasks (no title clears it)")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("phase", type=int, help="phase number")
    p.add_argument("title", nargs="*", help="the phase title")
    p.set_defaults(func=cmd_phase)

    p = sub.add_parser("relate", parents=[common], help="mark two items as related work")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("other", help="the related item")
    p.set_defaults(func=cmd_relate)

    p = sub.add_parser("unrelate", parents=[common], help="remove a relation, from whichever side holds it")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("other", help="the related item")
    p.set_defaults(func=cmd_unrelate)

    p = sub.add_parser("branch", parents=[common], usage=_BRANCH_USAGE[len("usage: "):],
                       help="show an item's branches, or add or remove one")
    p.add_argument("words", nargs="+", metavar="[add|rm] <query> [<name>]",
                   help="an item to show; or add|rm, the item, and the branch, e.g. feat/login")
    p.set_defaults(func=cmd_branch)

    dp = sub.add_parser("doc", parents=[common], help="add, remove or locate an item's docs")
    dsub = dp.add_subparsers(dest="doccmd", metavar="<doccmd>")
    da = dsub.add_parser("add", parents=[common], help="copy a file in as a doc (replaces one of the same name)")
    da.add_argument("query", help="id or part of a title")
    da.add_argument("file", help='the file, or "-" for stdin (needs --name)')
    da.add_argument("--name", default=None, help="the doc's name (default: the file's)")
    da.set_defaults(func=cmd_doc_add)
    for name, func, helptext in (("rm", cmd_doc_rm, "delete a doc"),
                                 ("path", cmd_doc_path, "print a doc's path, for editing in place")):
        dl = dsub.add_parser(name, parents=[common], help=helptext)
        dl.add_argument("query", help="id or part of a title")
        dl.add_argument("name", help="the doc's name")
        dl.set_defaults(func=func)

    p = sub.add_parser("docs", parents=[common], help="list an item's docs: name, size, who and when, and where")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_docs)

    jp = sub.add_parser("jira", parents=[common], help="link an item to Jira tickets")
    jsub = jp.add_subparsers(dest="jiracmd", metavar="<jiracmd>")
    for name, func, helptext in (("link", cmd_jira_link, "link Jira tickets to an item"),
                                 ("unlink", cmd_jira_unlink, "remove Jira tickets from an item")):
        jl = jsub.add_parser(name, parents=[common], help=helptext)
        jl.add_argument("query", help="id or part of a title")
        jl.add_argument("keys", nargs="+", metavar="KEY", help="Jira issue key, e.g. CNS-123")
        jl.set_defaults(func=func)

    p = sub.add_parser("archive", parents=[common], help="archive done and cancelled items")
    p.set_defaults(func=cmd_archive)

    p = sub.add_parser("link", parents=[common],
                       help="store this project's todos in the global store (~/.todo), via a symlink")
    p.add_argument("--name", default=None, metavar="KEY",
                   help="store key (default: repo basename)")
    p.add_argument("--remote", default=None, metavar="URL",
                   help="also sync the store with a team server")
    p.add_argument("--project", default=None, metavar="KEY",
                   help="server project key (default: the store key)")
    p.set_defaults(func=cmd_link)

    p = sub.add_parser("sync", parents=[common], help="sync now and show what's still unpushed")
    p.set_defaults(func=cmd_sync)

    p = sub.add_parser("login", help="save a server token (and your handle) for syncing")
    p.add_argument("url", help="server URL, e.g. https://todo.example.com")
    p.add_argument("token", nargs="?", help="an API token (it stays in shell history; prefer the browser or --token)")
    p.add_argument("--token", dest="ask", action="store_true",
                   help="paste an API token (hidden) instead of approving in the browser")
    p.add_argument("--new", action="store_true", help="sign in again even when the saved token still works")
    p.set_defaults(func=cmd_login)

    p = sub.add_parser("whoami", parents=[common], help="show your identity and sync setup")
    p.set_defaults(func=cmd_whoami)

    p = sub.add_parser("actions", parents=[common], help="list the project's Actions")
    p.set_defaults(func=cmd_actions)

    p = sub.add_parser("action", parents=[common], help="run one of the project's Actions on an item")
    p.add_argument("query", help="id or part of a title")
    p.add_argument("action", help="the Action's id (see `todo actions`)")
    p.set_defaults(func=cmd_action)

    p = sub.add_parser("inbox", parents=[common], help="mentions, rejections and hand-offs for you")
    p.add_argument("--all", action="store_true", help="include read notifications")
    p.set_defaults(func=cmd_inbox)

    p = sub.add_parser("unlink", parents=[common],
                       help="move the global store back into a real ./.TODO")
    p.set_defaults(func=cmd_unlink)

    p = sub.add_parser("projects", help="list all global-stored projects (~/.todo/projects/*)")
    p.set_defaults(func=cmd_projects)

    p = sub.add_parser("migrate", parents=[common],
                       help="rewrite store files the fast YAML loader rejects in block style")
    p.add_argument("-g", "--all-projects", action="store_true",
                   help="every linked project's store")
    p.set_defaults(func=cmd_migrate)

    p = sub.add_parser("init", help="install the todo skill into ~/.agents and ~/.claude")
    p.add_argument("--force", action="store_true",
                   help="repoint/replace an existing ~/.claude/skills/todo")
    p.set_defaults(func=cmd_init)

    # Legacy aliases: each status name usable directly as a command
    # (`todo in-progress X`). Hidden from help (the verb shortcuts above are the
    # intended UX); names already taken as commands — review, done — are skipped
    # since their shortcut sets the same status.
    for status in STATUSES:
        # qa-rejected goes through `todo reject`, which asks for the comment.
        if status in sub.choices or status == "qa-rejected":
            continue
        # No `help=`: argparse keeps the subcommand callable but leaves it out
        # of the listed commands (SUPPRESS would print a literal "==SUPPRESS==").
        p = sub.add_parser(status, parents=[common])
        p.add_argument("query", help="id or part of a title")
        if status in ("deployed", "ready-for-qa", "ready-to-deploy"):
            p.add_argument("--force", action="store_true")
        if status in REASONED:
            p.add_argument("reason", nargs="*")
        p.set_defaults(func=cmd_status_alias)

    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not getattr(args, "command", None):
        parser.print_help()
        sys.exit(0)
    if args.command in ("task", "check", "jira", "doc", "connection", "plugin") and not getattr(args, "func", None):
        parser.parse_args([args.command, "--help"])
        sys.exit(0)
    if getattr(args, "via", None):
        identity.set_via(args.via)
    # `init`/`projects` are machine-level; `link`/`unlink` act on the unresolved
    # repo-root path themselves — none of them want a resolved store path.
    if args.command in ("init", "projects", "link", "unlink", "login"):
        root = None
    else:
        root = _resolve_root(args.dir)
    if root is not None and root.is_dir():
        filecache.load(root)
        if migrate.convert_note_meta(root) and sync.enabled(root):
            sync.request_sweep(root)
    try:
        if root is not None and args.command not in NO_AUTO_SYNC and sync.enabled(root) \
                and not getattr(args, "all_projects", False):
            code = run_synced(root, args)
            if code:
                sys.exit(code)
            return
        args.func(root, args)
        if root is not None:
            seen: dict = {}
            gitfacts.maybe_local(root, seen)
            plugins_mod.after_command(root, seen)
    finally:
        if root is not None and root.is_dir():
            filecache.save(root)


def run_synced(root: Path, args) -> int:
    """Run a command between two sync rounds; EXIT_SYNC_REJECTED if either
    round had a change of ours turned down by the server. A round already
    running elsewhere stands in for the first and pushes for the second, so
    its rejections are reported there."""
    before = sync.rounds(root, lambda: sync.quiet_round(root))
    named = _named_items(root, args)
    existing = {d.name for d in store._item_dirs(root)}
    try:
        with sync.locked(root, _lock_keys(args, named)):
            args.func(root, args)
    finally:
        _mark_changes(root, named, existing)
    plugins_mod.after_command(root)
    sync.flag_changes(root)
    after = sync.rounds(root)
    rejected = any(r is not None and r.rejected for r in (before, after))
    return EXIT_SYNC_REJECTED if rejected else 0


def _mark_changes(root: Path, named, existing: set) -> None:
    """Mark what a command may have changed for the next round: the items it
    named and any it created, or everything when it acted on the whole store."""
    if named is None:
        sync.request_sweep(root)
        return
    for it in named:
        sync.mark_changed(root, it["id"])
    for d in store._item_dirs(root):
        if d.name not in existing:
            sync.mark_changed(root, d.name)


READ_ONLY = {"list", "ls", "deploy-plan", "deps", "connection", "plugin"}


def _lock_keys(args, named) -> list | None:
    if named is None:
        return None
    return [it["uid"] or it["id"] for it in named] + ([sync.NEW_ITEMS] if args.command == "add" else [])


def _named_items(root: Path, args) -> list | None:
    """The items a command names, for the lock it runs under and the changes
    it marks; None when it acts on the store as a whole or names an item that
    doesn't resolve."""
    if args.command == "add":
        return []
    queries = [q for q in (getattr(args, "query", None), getattr(args, "other", None)) if q]
    if not queries:
        return [] if args.command in READ_ONLY or args.command == "refresh" else None
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            items = [store.resolve_item(root, q) for q in queries]
    except SystemExit:
        return None
    return items


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
