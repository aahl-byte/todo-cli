"""CRUD over a `.TODO/` directory store, plus fuzzy item lookup.

    .TODO/{OPEN,DEFERRED,CANCELLED,ARCHIVED}/{item-id}/
        TODO.yaml               the item's own fields
        phase-{n}/TASKS.yaml    tasks per phase, in order (unphased/ for none)
        notes/{ts}-{id}.md      one note per file
        devlogs/{ts}-{id}.md    one dev-log entry per file

An item's `status:` decides its folder; changing status moves the directory.
Every write is atomic and touches only the files it changes. See
docs/plans/2026-10-01-dir-store-design.md.
"""

from __future__ import annotations  # `int | None` hints stay valid on Python 3.9

import os
import re
from pathlib import Path

from . import yamlio
from .status import TERMINAL, derive_calc_status
from .util import die, to_str

ROOT_NAME = ".TODO"
ITEM_FILE = "TODO.yaml"
TASKS_FILE = "TASKS.yaml"
NOTES_DIR = "notes"
LOG_DIR = "devlogs"
UNPHASED_DIR = "unphased"

OPEN, DEFERRED, CANCELLED, ARCHIVED = "OPEN", "DEFERRED", "CANCELLED", "ARCHIVED"
FOLDERS = [OPEN, DEFERRED, CANCELLED, ARCHIVED]

_PHASE_DIR = re.compile(r"^phase-(-?\d+)$")
_ENTRY_FILE = re.compile(r"^(?P<ts>.+)-(?P<id>\d+)\.md$")
_TS_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(.+)$")
UNDATED = "0000-00-00T00:00:00.000Z"


def folder_for(status: str, current: str | None = None) -> str:
    """The folder an item with `status` belongs in. `done` stays in ARCHIVED once
    archived, and otherwise sits in OPEN until `todo archive`."""
    if status == "deferred":
        return DEFERRED
    if status == "cancelled":
        return CANCELLED
    if status == "done" and current == ARCHIVED:
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
    """`{id, ts, text}` for each `{ts}-{id}.md` in `d`, ordered by id."""
    if not d.is_dir():
        return []
    out = []
    for f in d.iterdir():
        m = _ENTRY_FILE.match(f.name)
        if not m:
            continue
        text = f.read_text()
        out.append({"id": int(m.group("id")), "ts": name_to_ts(m.group("ts")),
                    "text": text[:-1] if text.endswith("\n") else text})
    return sorted(out, key=lambda e: e["id"])


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
            {"id": int(t["id"]), "title": to_str(t.get("title")),
             "status": to_str(t.get("status")) or "todo", "phase": phase}
            for t in (raw or []) if isinstance(t, dict) and t.get("id") is not None
        ]
        groups.append((phase is None, phase or 0, tasks))
    groups.sort(key=lambda g: (g[0], g[1]))
    return [t for _, _, tasks in groups for t in tasks]


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
        "notes": [{"id": e["id"], "text": e["text"]}
                  for e in _read_entries(item_dir / NOTES_DIR)] if full else [],
        "log": _read_entries(item_dir / LOG_DIR) if full else [],
        "tasks": _read_tasks(item_dir),
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


def add_todo(root: Path, title: str, now_iso: str):
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
    meta["title"] = t
    meta["type"] = "feature"
    meta["status"] = "todo"
    meta["priority"] = "medium"
    meta["super-phase"] = None
    meta["created"] = now_iso
    meta["completed"] = None
    yamlio.save(yamlio.yaml(), item_dir / ITEM_FILE, meta)
    return {"id": item_id, "title": t, "type": "feature", "status": "todo",
            "priority": "medium", "super_phase": None, "notes": [], "log": [],
            "tasks": [], "calc_status": None, "created": now_iso, "completed": None,
            "folder": OPEN}


def update_todo(root: Path, item_id: str, patch: dict, now_iso=None) -> bool:
    """Patch status/priority/type on an item. `now_iso` stamps `completed` when
    status flips to done and clears it when status leaves done. A status change
    then moves the item into its folder."""
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return False
    y, meta = _load_meta(item_dir)
    if isinstance(patch.get("status"), str):
        was = to_str(meta.get("status"))
        meta["status"] = patch["status"]
        if patch["status"] == "done" and was != "done":
            meta["completed"] = now_iso
        elif patch["status"] != "done" and was == "done":
            meta["completed"] = None
    if isinstance(patch.get("priority"), str):
        meta["priority"] = patch["priority"]
    if isinstance(patch.get("type"), str):
        meta["type"] = patch["type"]
    yamlio.save(y, item_dir / ITEM_FILE, meta)
    _place(item_dir, to_str(meta.get("status")) or "todo")
    return True


def archive_todos(root: Path):
    """Move every `done` item out of OPEN into ARCHIVED. Returns
    (count, archive_dir)."""
    moved = 0
    for d in _item_dirs(root, [OPEN]):
        if to_str(yamlio.read(d / ITEM_FILE).get("status")) == "done":
            dest = root / ARCHIVED / d.name
            if dest.exists():
                die(f"Can't archive {d.name}: {dest} already exists.", 1)
            dest.parent.mkdir(exist_ok=True)
            os.rename(d, dest)
            moved += 1
    return moved, root / ARCHIVED


# ── notes and dev log (one file per entry) ────────────────────────────────────
def _add_entry(root: Path, item_id: str, sub: str, text: str, ts: str):
    item_dir = _find_dir(root, item_id)
    if item_dir is None:
        return None
    d = item_dir / sub
    d.mkdir(exist_ok=True)
    ids = [e["id"] for e in _read_entries(d)]
    new_id = max(ids) + 1 if ids else 1
    yamlio.write_atomic(d / f"{ts_to_name(ts)}-{new_id}.md", text + "\n")
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


def add_note(root: Path, item_id: str, text: str, now_iso: str):
    """Append a note with a fresh per-item id. Returns the id, or None if the
    item is missing."""
    return _add_entry(root, item_id, NOTES_DIR, text, now_iso)


def remove_note(root: Path, item_id: str, note_id: int) -> bool:
    return _remove_entry(root, item_id, NOTES_DIR, note_id)


def add_log(root: Path, item_id: str, text: str, now_iso: str):
    """Append a dated log entry with a fresh per-item id. Returns the id, or None
    if the item is missing."""
    return _add_entry(root, item_id, LOG_DIR, text, now_iso)


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
        tasks.append({"id": new_id, "title": t, "status": "todo", "phase": phase})
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
