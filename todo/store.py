"""CRUD over a `.TODO/` directory store, plus fuzzy item lookup.

    .TODO/{OPEN,DEFERRED,CANCELLED,ARCHIVED}/{item-id}/
        TODO.yaml               the item's own fields
        phase-{n}/TASKS.yaml    tasks per phase, in order (unphased/ for none)
        notes/{ts}-{id}.md      one note per file (front matter + Markdown)
        devlogs/{ts}-{id}.md    one dev-log entry per file
        history/{ts}-{id}.yaml  one status transition per file
        checks/CHECKS.yaml      deployment checks, in order

An item's `status:` decides its folder; changing status moves the directory.
Every write is atomic and touches only the files it changes. See
docs/plans/2026-10-01-dir-store-design.md.
"""

from __future__ import annotations  # `int | None` hints stay valid on Python 3.9

import os
import re
from pathlib import Path

from . import frontmatter, identity, ulid, yamlio
from .status import COMPLETE, derive_calc_status
from .util import die, to_str

ROOT_NAME = ".TODO"
ITEM_FILE = "TODO.yaml"
TASKS_FILE = "TASKS.yaml"
NOTES_DIR = "notes"
LOG_DIR = "devlogs"
HISTORY_DIR = "history"
CHECKS_DIR = "checks"
CHECKS_FILE = "CHECKS.yaml"
UNPHASED_DIR = "unphased"

PEOPLE = ("creator", "developer", "qa_assignee")
NOTE_KINDS = ["context", "ticket-request", "comment", "qa-rejection", "link",
              "clarification"]
LINK_TYPES = ["pr", "preview", "qa-handoff", "other"]
CHECK_KINDS = ["prereq-branch", "db-script", "env-var", "feature-flag",
               "manual-step", "other"]
CHECK_TIMINGS = ["pre-deploy", "post-deploy"]

OPEN, DEFERRED, CANCELLED, ARCHIVED = "OPEN", "DEFERRED", "CANCELLED", "ARCHIVED"
FOLDERS = [OPEN, DEFERRED, CANCELLED, ARCHIVED]

_PHASE_DIR = re.compile(r"^phase-(-?\d+)$")
_ENTRY_FILE = re.compile(r"^(?P<ts>.+)-(?P<id>\d+)\.(?P<ext>md|yaml)$")
_MENTION = re.compile(r"(?<![\w@])@([A-Za-z0-9][\w.\-]*)")
_TS_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(.+)$")
UNDATED = "0000-00-00T00:00:00.000Z"


def folder_for(status: str, current: str | None = None) -> str:
    """The folder an item with `status` belongs in. A complete item (`done`,
    `deployed`) stays in ARCHIVED once archived, and otherwise sits in OPEN until
    `todo archive`."""
    if status == "deferred":
        return DEFERRED
    if status == "cancelled":
        return CANCELLED
    if status in COMPLETE and current == ARCHIVED:
        return ARCHIVED
    return OPEN


# ── filesystem helpers ────────────────────────────────────────────────────────
def _item_dirs(root: Path, folders=FOLDERS) -> list:
    out = []
    for folder in folders:
        d = root / folder
        if d.is_dir():
            out.extend(p for p in d.iterdir() if (p / ITEM_FILE).is_file())
    return out


def _find_dir(root: Path, item_id: str) -> Path | None:
    for folder in FOLDERS:
        d = root / folder / item_id
        if (d / ITEM_FILE).is_file():
            return d
    return None


def _place(item_dir: Path, status: str) -> Path:
    """Move the item directory into the folder its status selects. Returns its
    (possibly new) path."""
    current = item_dir.parent.name
    want = folder_for(status, current)
    if want == current:
        return item_dir
    dest = item_dir.parent.parent / want / item_dir.name
    if dest.exists():
        die(f"Can't move {item_dir.name} to {want}/: {dest} already exists.", 1)
    dest.parent.mkdir(exist_ok=True)
    os.rename(item_dir, dest)
    return dest


def ts_to_name(ts: str) -> str:
    return ts.replace(":", "-")


def name_to_ts(name: str) -> str:
    m = _TS_FILE.match(name)
    return f"{m.group(1)}:{m.group(2)}:{m.group(3)}" if m else name


def _phase_dir_name(phase: int | None) -> str:
    return UNPHASED_DIR if phase is None else f"phase-{phase}"


def _dir_phase(name: str):
    """A phase directory's phase number, None for unphased, or False when the
    name isn't a phase directory at all."""
    if name == UNPHASED_DIR:
        return None
    m = _PHASE_DIR.match(name)
    return int(m.group(1)) if m else False


# ── reading ───────────────────────────────────────────────────────────────────
def _read_entries(d: Path) -> list:
    """`{id, ts, text, meta, file}` for each `{ts}-{id}.md` in `d`, ordered by
    id. `meta` is the front matter ({} for a legacy file). A history
    `{ts}-{id}.yaml` puts its whole map in `meta` and leaves `text` empty."""
    if not d.is_dir():
        return []
    out = []
    for f in d.iterdir():
        m = _ENTRY_FILE.match(f.name)
        if not m:
            continue
        raw = f.read_text()
        if m.group("ext") == "yaml":
            meta, text = frontmatter.load_map(raw), ""
        else:
            meta, text = frontmatter.split(raw)
        out.append({"id": int(m.group("id")), "ts": name_to_ts(m.group("ts")),
                    "text": text[:-1] if text.endswith("\n") else text,
                    "meta": meta, "file": f})
    return sorted(out, key=lambda e: e["id"])


def _note(e) -> dict:
    meta = e["meta"]
    return {"id": e["id"], "ts": e["ts"], "text": e["text"],
            "uid": meta.get("uid"), "kind": meta.get("kind") or "context",
            "author": meta.get("author"), "via": meta.get("via"),
            "meta": {k: v for k, v in meta.items()
                     if k not in ("uid", "kind", "author", "via")}}


def _log(e) -> dict:
    meta = e["meta"]
    return {"id": e["id"], "ts": e["ts"], "text": e["text"], "uid": meta.get("uid"),
            "author": meta.get("author"), "via": meta.get("via")}


def _history(e) -> dict:
    meta = e["meta"]
    return {"id": e["id"], "ts": e["ts"], "uid": meta.get("uid"),
            "from": meta.get("from"), "to": meta.get("to"), "by": meta.get("by"),
            "via": meta.get("via"), "forced": bool(meta.get("forced")),
            "provisional": not meta.get("server")}


def _read_tasks(item_dir: Path) -> list:
    """Every task with its phase, in display order: phased ascending, then
    unphased; file order within a phase."""
    groups = []
    for d in item_dir.iterdir():
        phase = _dir_phase(d.name) if d.is_dir() else False
        if phase is False or not (d / TASKS_FILE).is_file():
            continue
        doc = yamlio.read(d / TASKS_FILE)
        raw = doc.get("tasks") if isinstance(doc, dict) else None
        tasks = [
            {"id": int(t["id"]), "uid": t.get("uid"), "title": to_str(t.get("title")),
             "status": to_str(t.get("status")) or "todo", "phase": phase}
            for t in (raw or []) if isinstance(t, dict) and t.get("id") is not None
        ]
        groups.append((phase is None, phase or 0, tasks))
    groups.sort(key=lambda g: (g[0], g[1]))
    return [t for _, _, tasks in groups for t in tasks]


def _read_checks(item_dir: Path) -> list:
    f = item_dir / CHECKS_DIR / CHECKS_FILE
    if not f.is_file():
        return []
    doc = yamlio.read(f)
    raw = doc.get("checks") if isinstance(doc, dict) else None
    return [
        {"id": int(c["id"]), "uid": c.get("uid"), "kind": to_str(c.get("kind")) or "other",
         "title": to_str(c.get("title")),
         "payload": to_str(c.get("payload")) if c.get("payload") is not None else None,
         "timing": to_str(c.get("timing")) or "pre-deploy",
         "status": to_str(c.get("status")) or "pending"}
        for c in (raw or []) if isinstance(c, dict) and c.get("id") is not None
    ]


def _load_meta(item_dir: Path):
    return yamlio.load(item_dir / ITEM_FILE)


def _to_item(item_dir: Path, meta, *, full: bool = True) -> dict:
    super_phase = meta.get("super-phase")
    calc = meta.get("calc-status")
    created = meta.get("created")
    completed = meta.get("completed")
    return {
        "id": item_dir.name,
        "title": to_str(meta.get("title")),
        "type": to_str(meta.get("type")) or "feature",
        "status": to_str(meta.get("status")) or "todo",
        "priority": to_str(meta.get("priority")) if meta.get("priority") is not None else None,
        "super_phase": int(super_phase) if super_phase not in (None, "") else None,
        "uid": to_str(meta.get("uid")) or None,
        "creator": to_str(meta.get("creator")) or None,
        "developer": to_str(meta.get("developer")) or None,
        "qa_assignee": to_str(meta.get("qa_assignee")) or None,
        "notes": [_note(e) for e in _read_entries(item_dir / NOTES_DIR)] if full else [],
        "log": [_log(e) for e in _read_entries(item_dir / LOG_DIR)] if full else [],
        "history": [_history(e) for e in _read_entries(item_dir / HISTORY_DIR)]
                   if full else [],
        "tasks": _read_tasks(item_dir),
        "checks": _read_checks(item_dir),
        "calc_status": to_str(calc) if calc not in (None, "") else None,
        "created": to_str(created) if created not in (None, "") else None,
        "completed": to_str(completed) if completed not in (None, "") else None,
        "folder": item_dir.parent.name,
    }


def _read_item(item_dir: Path, *, full: bool = True) -> dict:
    """Load one item, first moving it if it sits in the wrong folder."""
    meta = yamlio.read(item_dir / ITEM_FILE)
    meta = meta if isinstance(meta, dict) else {}
    item_dir = _place(item_dir, to_str(meta.get("status")) or "todo")
    return _to_item(item_dir, meta, full=full)


def list_todos(root: Path, folders=FOLDERS) -> list:
    """Items in `folders`, by created then id. Notes and log are left out — the
    list views never show them."""
    items = [_read_item(d, full=False) for d in _item_dirs(root, folders)]
    return sorted(items, key=lambda it: (it["created"] or "", it["id"]))


def get_item(root: Path, item_id: str) -> dict | None:
    d = _find_dir(root, item_id)
    return _read_item(d) if d else None


# ── items ─────────────────────────────────────────────────────────────────────
def _slug_id(title: str, taken: set) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40] or "item"
    item_id, n = base, 2
    while item_id in taken:
        item_id = f"{base}-{n}"
        n += 1
    return item_id


def add_todo(root: Path, title: str, now_iso: str, status: str = "todo"):
    from ruamel.yaml.comments import CommentedMap

    t = title.strip()
    if not t:
        return None
    taken = {d.name for d in _item_dirs(root)}
    while True:
        item_id = _slug_id(t, taken)
        item_dir = root / OPEN / item_id
        item_dir.parent.mkdir(parents=True, exist_ok=True)
        try:
            item_dir.mkdir()                # exclusive: a racing add takes the next slug
            break
        except FileExistsError:
            taken.add(item_id)
    meta = CommentedMap()
    meta["id"] = item_id
    meta["uid"] = ulid.new()
    meta["title"] = t
    meta["type"] = "feature"
    meta["status"] = status
    meta["priority"] = "medium"
    meta["super-phase"] = None
    meta["created"] = now_iso
    meta["completed"] = None
    meta["creator"] = identity.user()
    meta["developer"] = None
    meta["qa_assignee"] = None
    yamlio.save(yamlio.yaml(), item_dir / ITEM_FILE, meta)
    return get_item(root, item_id)


def update_todo(root: Path, item_id: str, patch: dict, now_iso=None, *,
                forced: bool = False) -> bool:
    """Patch status/priority/type/title or a people field on an item. `now_iso`
    stamps `completed` when status becomes complete and clears it when status
    leaves complete. A real status change appends a history entry (`forced`
    marks a deploy past the check gate), then moves the item into its folder.
    A people field set to None is cleared."""
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return False
    y, meta = _load_meta(item_dir)
    moved = None
    if isinstance(patch.get("status"), str):
        was = to_str(meta.get("status")) or "todo"
        new = patch["status"]
        meta["status"] = new
        if new in COMPLETE and was not in COMPLETE:
            meta["completed"] = now_iso
        elif new not in COMPLETE and was in COMPLETE:
            meta["completed"] = None
        if new != was:
            moved = (was, new)
    for key in ("priority", "type", "title"):
        if isinstance(patch.get(key), str):
            meta[key] = patch[key]
    for key in PEOPLE:
        if key in patch:
            meta[key] = patch[key] or None
    yamlio.save(y, item_dir / ITEM_FILE, meta)
    if moved:
        _write_history(item_dir, moved[0], moved[1], now_iso, forced)
    _place(item_dir, to_str(meta.get("status")) or "todo")
    return True


def _write_history(item_dir: Path, was: str, new: str, ts, forced: bool) -> None:
    d = item_dir / HISTORY_DIR
    d.mkdir(exist_ok=True)
    ids = [e["id"] for e in _read_entries(d)]
    new_id = max(ids) + 1 if ids else 1
    ts = ts or _now()
    entry = {"uid": ulid.new(), "from": was, "to": new, "by": identity.user(),
             "via": identity.via()}
    if forced:
        entry["forced"] = True
    yamlio.write_atomic(d / f"{ts_to_name(ts)}-{new_id}.yaml", frontmatter.dump_map(entry))


def _now() -> str:
    from .util import now
    return now()


def archive_todos(root: Path):
    """Move every `done` item out of OPEN into ARCHIVED. Returns
    (count, archive_dir)."""
    moved = 0
    for d in _item_dirs(root, [OPEN]):
        if to_str(yamlio.read(d / ITEM_FILE).get("status")) in COMPLETE:
            dest = root / ARCHIVED / d.name
            if dest.exists():
                die(f"Can't archive {d.name}: {dest} already exists.", 1)
            dest.parent.mkdir(exist_ok=True)
            os.rename(d, dest)
            moved += 1
    return moved, root / ARCHIVED


# ── notes and dev log (one file per entry) ────────────────────────────────────
def _add_entry(root: Path, item_id: str, sub: str, text: str, ts: str, meta: dict):
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return None
    d = item_dir / sub
    d.mkdir(exist_ok=True)
    ids = [e["id"] for e in _read_entries(d)]
    new_id = max(ids) + 1 if ids else 1
    full = {"uid": ulid.new(), **meta, "author": identity.user(), "via": identity.via()}
    yamlio.write_atomic(d / f"{ts_to_name(ts)}-{new_id}.md",
                        frontmatter.join(full, text + "\n"))
    return new_id


def _remove_entry(root: Path, item_id: str, sub: str, entry_id: int) -> bool:
    item_dir = _find_dir(root, item_id)
    if item_dir is None or not (item_dir / sub).is_dir():
        return False
    removed = False
    for f in (item_dir / sub).iterdir():
        m = _ENTRY_FILE.match(f.name)
        if m and int(m.group("id")) == entry_id:
            f.unlink()
            removed = True
    return removed


def mentions(text: str) -> list:
    seen = []
    for h in _MENTION.findall(text):
        h = h.rstrip(".")
        if h not in seen:
            seen.append(h)
    return seen


def add_note(root: Path, item_id: str, text: str, now_iso: str, kind: str = "context",
             extra: dict | None = None):
    """Append a note of `kind` with a fresh per-item id. `comment` and
    `qa-rejection` notes record their @mentions; `clarification` notes start
    open. Returns the id, or None if the item is missing."""
    meta = {"kind": kind, **(extra or {})}
    if kind in ("comment", "qa-rejection"):
        found = mentions(text)
        if found:
            meta["mentions"] = found
    if kind == "clarification":
        meta.setdefault("state", "open")
    return _add_entry(root, item_id, NOTES_DIR, text, now_iso, meta)


def answer_note(root: Path, item_id: str, note_id: int, answer: str, now_iso: str) -> bool:
    """Close a clarification with `answer`, keeping its file and id."""
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return False
    for e in _read_entries(item_dir / NOTES_DIR):
        if e["id"] == note_id:
            meta = dict(e["meta"]) or {"uid": None, "kind": "context"}
            meta.update(state="answered", answer=answer, answered_by=identity.user(),
                        answered_at=now_iso)
            yamlio.write_atomic(e["file"], frontmatter.join(meta, e["text"] + "\n"))
            return True
    return False


def remove_note(root: Path, item_id: str, note_id: int) -> bool:
    return _remove_entry(root, item_id, NOTES_DIR, note_id)


def add_log(root: Path, item_id: str, text: str, now_iso: str):
    """Append a dated log entry with a fresh per-item id. Returns the id, or None
    if the item is missing."""
    return _add_entry(root, item_id, LOG_DIR, text, now_iso, {})


def remove_log(root: Path, item_id: str, log_id: int) -> bool:
    return _remove_entry(root, item_id, LOG_DIR, log_id)


# ── child tasks ───────────────────────────────────────────────────────────────
def _sort_tasks(tasks) -> list:
    """Phased first (ascending), unphased last. Stable, so tasks sharing a phase
    keep their order."""
    return sorted(tasks, key=lambda t: (t.get("phase") is None, t.get("phase") or 0))


def _write_tasks(item_dir: Path, before: list, after: list) -> None:
    """Persist `after` as per-phase TASKS.yaml files, writing only files whose
    content changed. Files that gained a task are written before files that lost
    one, and emptied phases are removed last, so a crash duplicates a task rather
    than losing it. Then recompute the item's calc-status."""
    def by_phase(tasks):
        out = {}
        for t in tasks:
            out.setdefault(t["phase"], []).append(t)
        return out

    old, new = by_phase(before), by_phase(after)
    y = yamlio.yaml()
    gained, other = [], []
    for phase, tasks in new.items():
        text = yamlio.dump(y, yamlio.tasks_doc(tasks))
        f = item_dir / _phase_dir_name(phase) / TASKS_FILE
        if f.is_file() and f.read_text() == text:
            continue
        old_ids = {t["id"] for t in old.get(phase, [])}
        (gained if {t["id"] for t in tasks} - old_ids else other).append((f, text))
    for f, text in gained + other:
        f.parent.mkdir(exist_ok=True)
        yamlio.write_atomic(f, text)
    for phase in set(old) - set(new):
        d = item_dir / _phase_dir_name(phase)
        (d / TASKS_FILE).unlink(missing_ok=True)
        try:
            d.rmdir()
        except OSError:
            pass

    y, meta = _load_meta(item_dir)
    calc = derive_calc_status([t["status"] for t in after])
    if calc != (to_str(meta.get("calc-status")) or None):
        if calc is None:
            meta.pop("calc-status", None)
        else:
            meta["calc-status"] = calc
        yamlio.save(y, item_dir / ITEM_FILE, meta)


def _mutate_tasks(root: Path, item_id: str, transform):
    """Load the item's tasks fresh, hand them to `transform` (which mutates the
    list in place), then sort, persist and recompute. Returns `transform`'s
    return value, or False if the item doesn't exist."""
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return False
    before = _read_tasks(item_dir)
    tasks = [dict(t) for t in before]
    result = transform(tasks)
    _write_tasks(item_dir, before, _sort_tasks(tasks))
    return result


def add_task(root: Path, item_id: str, title: str, phase: int | None = None):
    """Append a task with a fresh per-item id (max existing + 1). Returns the new
    id, or None if the title is empty or the item is missing."""
    t = title.strip()
    if not t:
        return None
    def _add(tasks):
        ids = [x["id"] for x in tasks]
        new_id = max(ids) + 1 if ids else 1
        tasks.append({"id": new_id, "uid": ulid.new(), "title": t, "status": "todo",
                      "phase": phase})
        return new_id
    result = _mutate_tasks(root, item_id, _add)
    return result if result is not False else None


def set_task_status(root: Path, item_id: str, task_id: int, status: str) -> bool:
    def _set(tasks):
        for t in tasks:
            if t["id"] == task_id:
                t["status"] = status
        return True
    return _mutate_tasks(root, item_id, _set) is True


def set_task_phase(root: Path, item_id: str, task_id: int, phase: int | None) -> bool:
    """Re-phase a task and drop it to the bottom of its new phase — its position
    among the old phase's tasks says nothing about where it belongs among the
    new ones."""
    def _set(tasks):
        for i, t in enumerate(tasks):
            if t["id"] == task_id:
                t["phase"] = phase
                tasks.append(tasks.pop(i))
                break
        return True
    return _mutate_tasks(root, item_id, _set) is True


def move_task(root: Path, item_id: str, task_id: int, *, before=None, after=None,
              bottom: bool = False):
    """Reorder a task among its phase-mates. `before`/`after` place it next to
    another task and make it adopt that task's phase (otherwise the phase sort
    would just undo the move); with neither, it goes to the top of its own phase,
    or the bottom when `bottom` is set. Returns the task's phase afterwards
    (possibly None), or False if the item is missing."""
    def _move(tasks):
        i = next((i for i, t in enumerate(tasks) if t["id"] == task_id), None)
        if i is None:
            return False
        task = tasks.pop(i)
        target_id = before if before is not None else after
        if target_id is not None:
            j = next((j for j, t in enumerate(tasks) if t["id"] == target_id), None)
            if j is None:
                tasks.insert(i, task)       # unknown target: put it back untouched
                return False
            task["phase"] = tasks[j]["phase"]
            tasks.insert(j if before is not None else j + 1, task)
        else:
            peers = [j for j, t in enumerate(tasks) if t["phase"] == task["phase"]]
            if not peers:
                tasks.append(task)
            else:
                tasks.insert(peers[-1] + 1 if bottom else peers[0], task)
        return task["phase"]
    return _mutate_tasks(root, item_id, _move)


def remove_task(root: Path, item_id: str, task_id: int) -> bool:
    def _rm(tasks):
        for i, t in enumerate(tasks):
            if t["id"] == task_id:
                del tasks[i]
                break
        return True
    return _mutate_tasks(root, item_id, _rm) is True


# ── deployment checks ─────────────────────────────────────────────────────────
def _mutate_checks(root: Path, item_id: str, transform):
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return False
    checks = _read_checks(item_dir)
    result = transform(checks)
    f = item_dir / CHECKS_DIR / CHECKS_FILE
    if checks:
        f.parent.mkdir(exist_ok=True)
        yamlio.write_atomic(f, yamlio.dump(yamlio.yaml(), yamlio.checks_doc(checks)))
    elif f.exists():
        f.unlink()
        try:
            f.parent.rmdir()
        except OSError:
            pass
    return result


def add_check(root: Path, item_id: str, kind: str, title: str, payload=None,
              timing: str = "pre-deploy"):
    t = title.strip()
    if not t:
        return None
    def _add(checks):
        ids = [c["id"] for c in checks]
        new_id = max(ids) + 1 if ids else 1
        checks.append({"id": new_id, "uid": ulid.new(), "kind": kind, "title": t,
                       "payload": payload, "timing": timing, "status": "pending"})
        return new_id
    result = _mutate_checks(root, item_id, _add)
    return result if result is not False else None


def set_check_status(root: Path, item_id: str, check_id: int, status: str) -> bool:
    def _set(checks):
        for c in checks:
            if c["id"] == check_id:
                c["status"] = status
                return True
        return False
    return _mutate_checks(root, item_id, _set) is True


def remove_check(root: Path, item_id: str, check_id: int) -> bool:
    def _rm(checks):
        for i, c in enumerate(checks):
            if c["id"] == check_id:
                del checks[i]
                return True
        return False
    return _mutate_checks(root, item_id, _rm) is True


def pending_pre_deploy(item: dict) -> list:
    return [c for c in item["checks"]
            if c["timing"] == "pre-deploy" and c["status"] != "done"]


# ── fuzzy, case-insensitive item lookup ───────────────────────────────────────
def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(s).lower()).strip("-")


def _matches(items, q):
    id_exact = [it for it in items if _norm(it["id"]) == q]
    title_exact = [it for it in items if _norm(it["title"]) == q]
    substr = [it for it in items if q in _norm(it["id"]) or q in _norm(it["title"])]
    return id_exact or title_exact or substr


def resolve_item(root: Path, query: str) -> dict:
    """Find one item by id or title. An exact id matches in any folder; title and
    substring matches prefer OPEN items before searching the parked and finished
    folders."""
    if not root.is_dir():
        die(f"No {ROOT_NAME} found at {root}\n(use --dir to point elsewhere)", 2)
    if not query:
        die("Missing <query> (an id or part of a title).", 2)
    q = _norm(query)
    exact = [d for d in _item_dirs(root) if _norm(d.name) == q]
    if len(exact) == 1:
        return _read_item(exact[0])
    pick = _matches(list_todos(root, [OPEN]), q) or _matches(list_todos(root), q)
    if len(pick) == 1:
        return get_item(root, pick[0]["id"])
    if not pick:
        die(f'No todo matches "{query}". Try `todo list --all`.', 2)
    lines = "\n".join(f'  {it["id"]}  ({it["status"]})  {it["title"]}' for it in pick)
    die(f'"{query}" is ambiguous — {len(pick)} matches:\n{lines}'
        "\nNarrow the query or use the exact id.", 2)
