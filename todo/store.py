"""CRUD over the `todos:` sequence plus fuzzy item lookup.

All mutations route through yamlio's fresh-read + atomic-write core, so they're
safe to run alongside another writer (e.g. the web drawer editing the same file).
"""

from __future__ import annotations  # `int | None` hints stay valid on Python 3.9

import re
from pathlib import Path

from . import yamlio
from .status import TERMINAL, derive_calc_status
from .util import die, to_str


# ── node helpers ──────────────────────────────────────────────────────────────
def _seq(data):
    s = data.get("todos") if isinstance(data, dict) else None
    return s if isinstance(s, list) else None


def _find_node(seq, item_id: str):
    for n in seq:
        if isinstance(n, dict) and to_str(n.get("id")) == item_id:
            return n
    return None


def _assign_ids(items: list) -> list:
    """Ensure every task/note carries a constant per-item id. Items that already
    have one keep it; those missing one (legacy entries, or freshly parsed) are
    filled deterministically by position with the next free serial (max seen so
    far + 1). Deterministic for a fixed input, so on-the-fly ids for an
    un-migrated file stay consistent across reads and match what gets persisted
    on the next mutation."""
    used = {it["id"] for it in items if it.get("id") is not None}
    nxt = max(used) + 1 if used else 1
    for it in items:
        if it.get("id") is None:
            while nxt in used:
                nxt += 1
            it["id"] = nxt
            used.add(nxt)
            nxt += 1
    return items


def _to_item(node) -> dict:
    notes = _notes_of(node)
    tasks = _tasks_of(node)
    calc = node.get("calc-status")
    super_phase = node.get("super-phase")
    created = node.get("created")
    completed = node.get("completed")
    return {
        "id": to_str(node.get("id")),
        "title": to_str(node.get("title")),
        "type": to_str(node.get("type")) or "feature",
        "status": to_str(node.get("status")) or "todo",
        "priority": to_str(node.get("priority")) if node.get("priority") is not None else None,
        "super_phase": int(super_phase) if super_phase not in (None, "") else None,
        "notes": notes,
        "tasks": tasks,
        "calc_status": to_str(calc) if calc not in (None, "") else None,
        "created": to_str(created) if created not in (None, "") else None,
        "completed": to_str(completed) if completed not in (None, "") else None,
    }


# ── CRUD ──────────────────────────────────────────────────────────────────────
def list_todos(file: Path) -> list:
    try:
        _, data = yamlio.load(file)
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
    from ruamel.yaml.comments import CommentedMap, CommentedSeq

    t = title.strip()
    if not t:
        return None
    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        data["todos"] = CommentedSeq()
        seq = data["todos"]
    taken = {to_str(n.get("id")) for n in seq if isinstance(n, dict)}
    item_id = _slug_id(t, taken)
    item = CommentedMap()
    item["id"] = item_id
    item["title"] = t
    item["type"] = "feature"
    item["status"] = "todo"
    item["priority"] = "medium"
    item["super-phase"] = None
    item["created"] = now_iso
    item["completed"] = None
    seq.append(item)
    yamlio.save(y, file, data)
    return {"id": item_id, "title": t, "type": "feature", "status": "todo",
            "priority": "medium", "super_phase": None, "notes": [],
            "created": now_iso, "completed": None}


def update_todo(file: Path, item_id: str, patch: dict, now_iso=None) -> bool:
    """Patch status/priority/type on an item. `now_iso` stamps `completed` when
    status flips to done and clears it when status leaves done. (Notes and tasks
    have their own id-based CRUD — see add_note/remove_note and the task fns.)"""
    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return False
    node = _find_node(seq, item_id)
    if node is None:
        return False
    if isinstance(patch.get("status"), str):
        was = to_str(node.get("status"))
        node["status"] = patch["status"]
        if patch["status"] == "done" and was != "done":
            node["completed"] = now_iso
        elif patch["status"] != "done" and was == "done":
            node["completed"] = None
    if isinstance(patch.get("priority"), str):
        node["priority"] = patch["priority"]
    if isinstance(patch.get("type"), str):
        node["type"] = patch["type"]
    yamlio.save(y, file, data)
    return True


# ── notes CRUD (id-addressed) ─────────────────────────────────────────────────
def _mutate_notes(file: Path, item_id: str, transform):
    """Load fresh, hand the item's `{id, text}` note list to `transform` (mutates
    in place), rewrite it as block maps, save. Returns transform's return value
    (or False if the item is missing). Notes have no phase/calc — simpler than
    the task path."""
    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return False
    node = _find_node(seq, item_id)
    if node is None:
        return False
    notes = _notes_of(node)
    result = transform(notes)
    node["notes"] = yamlio.notes_node(notes)
    yamlio.save(y, file, data)
    return result


def add_note(file: Path, item_id: str, text: str):
    """Append a note with a fresh per-item id (max existing + 1). Returns the new
    id, or None if the item is missing."""
    def _add(notes):
        ids = [n["id"] for n in notes if n.get("id") is not None]
        new_id = max(ids) + 1 if ids else 1
        notes.append({"id": new_id, "text": text})
        return new_id
    result = _mutate_notes(file, item_id, _add)
    return result if result is not False else None


def remove_note(file: Path, item_id: str, note_id: int) -> bool:
    """Remove the note with this id. Returns True if one was removed."""
    def _rm(notes):
        for i, n in enumerate(notes):
            if n["id"] == note_id:
                del notes[i]
                return True
        return False
    return _mutate_notes(file, item_id, _rm) is True


# ── notes ───────────────────────────────────────────────────────────────────
def _id_of(x) -> int | None:
    v = x.get("id")
    return int(v) if v not in (None, "") else None


def _notes_of(node) -> list:
    """Read notes as `{id, text}` dicts. Both the current block-map form and the
    legacy plain-scalar form are accepted; scalars come back with `id: None` and
    get a serial assigned by `_assign_ids` (persisted on the next note mutation)."""
    raw = node.get("notes")
    if not isinstance(raw, list):
        return []
    notes = [
        {"id": _id_of(n), "text": to_str(n.get("text"))} if isinstance(n, dict)
        else {"id": None, "text": to_str(n)}
        for n in raw
    ]
    return _assign_ids(notes)


# ── child tasks ─────────────────────────────────────────────────────────────
def _task_phase(t) -> int | None:
    ph = t.get("phase")
    return int(ph) if ph not in (None, "") else None


def _tasks_of(node) -> list:
    raw = node.get("tasks")
    if not isinstance(raw, list):
        return []
    tasks = [
        {
            "id": _id_of(t),
            "title": to_str(t.get("title")),
            "status": to_str(t.get("status")) or "todo",
            "phase": _task_phase(t),
        }
        for t in raw if isinstance(t, dict)
    ]
    return _assign_ids(tasks)


def _sort_tasks(tasks) -> list:
    """Order tasks by phase: phased first (ascending), unphased last. Stable, so
    tasks sharing a phase keep their insertion order. The stored order IS the
    display order, so `[i]` indices stay meaningful after an auto-sort."""
    return sorted(tasks, key=lambda t: (t.get("phase") is None, t.get("phase") or 0))


def _write_tasks(node, tasks) -> None:
    """Rewrite the node's tasks (auto-sorted by phase) and recompute its derived
    calc-status. Never touches the manual `status` or `completed` — those stay
    human-driven."""
    tasks = _sort_tasks(tasks)
    node["tasks"] = yamlio.tasks_node(tasks)
    calc = derive_calc_status([t["status"] for t in tasks])
    if calc is None:
        node.pop("calc-status", None)
    else:
        node["calc-status"] = calc


def _mutate_tasks(file: Path, item_id: str, transform):
    """Load fresh, find the item, hand its task list to `transform` (which
    mutates it in place), then rewrite + recompute + save. Returns `transform`'s
    return value on success, or False if the item doesn't exist."""
    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return False
    node = _find_node(seq, item_id)
    if node is None:
        return False
    tasks = _tasks_of(node)
    result = transform(tasks)
    _write_tasks(node, tasks)
    yamlio.save(y, file, data)
    return result


def add_task(file: Path, item_id: str, title: str, phase: int | None = None):
    """Append a task with a fresh per-item id (max existing + 1). Returns the new
    id, or None if the title is empty or the item is missing."""
    t = title.strip()
    if not t:
        return None
    def _add(tasks):
        ids = [x["id"] for x in tasks if x.get("id") is not None]
        new_id = max(ids) + 1 if ids else 1
        tasks.append({"id": new_id, "title": t, "status": "todo", "phase": phase})
        return new_id
    result = _mutate_tasks(file, item_id, _add)
    return result if result is not False else None


def set_task_status(file: Path, item_id: str, task_id: int, status: str) -> bool:
    def _set(tasks):
        for t in tasks:
            if t["id"] == task_id:
                t["status"] = status
        return True
    return _mutate_tasks(file, item_id, _set) is True


def set_task_phase(file: Path, item_id: str, task_id: int, phase: int | None) -> bool:
    """Re-phase a task and drop it to the bottom of its new phase — its position
    among the old phase's tasks says nothing about where it belongs among the
    new ones. (Moving it to the end of the list suffices: the sort is stable, so
    it lands last within its phase.)"""
    def _set(tasks):
        for i, t in enumerate(tasks):
            if t["id"] == task_id:
                t["phase"] = phase
                tasks.append(tasks.pop(i))
                break
        return True
    return _mutate_tasks(file, item_id, _set) is True


def move_task(file: Path, item_id: str, task_id: int, *, before=None, after=None,
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
    return _mutate_tasks(file, item_id, _move)


def remove_task(file: Path, item_id: str, task_id: int) -> bool:
    def _rm(tasks):
        for i, t in enumerate(tasks):
            if t["id"] == task_id:
                del tasks[i]
                break
        return True
    return _mutate_tasks(file, item_id, _rm) is True


def archive_todos(file: Path, stamp: str):
    """Move every finished item — `done` or `cancelled` — out of TODO.yaml into
    ARCHIVE/TODO/todo_<stamp>.yaml (relative to TODO.yaml's dir). The archive is
    written FIRST, then the main file is pruned — a crash between the two atomic
    writes duplicates the archived items (recoverable), never loses them.
    Returns (count, archive_path)."""
    from ruamel.yaml.comments import CommentedSeq

    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return 0, None
    done_idx = [i for i, n in enumerate(seq)
                if isinstance(n, dict) and to_str(n.get("status")) in TERMINAL]
    if not done_idx:
        return 0, None
    done_nodes = [seq[i] for i in done_idx]

    safe = re.sub(r"[:.]", "-", stamp)
    archive_dir = file.parent / "ARCHIVE" / "TODO"
    archive_file = archive_dir / f"todo_{safe}.yaml"
    ay = yamlio.yaml()
    adata = ay.load("todos: []\n")
    adata.yaml_set_start_comment(
        f" Archived done/cancelled items — moved out of TODO.yaml at {stamp}.")
    aseq = CommentedSeq()
    for node in done_nodes:                 # reuse AST nodes → inline comments survive
        aseq.append(node)
    adata["todos"] = aseq

    archive_dir.mkdir(parents=True, exist_ok=True)
    yamlio.save(ay, archive_file, adata)    # 1. archive lands first

    for i in reversed(done_idx):            # 2. then prune main file (reverse: stable indices)
        del seq[i]
    yamlio.save(y, file, data)
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
