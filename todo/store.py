"""CRUD over the `todos:` sequence plus fuzzy item lookup.

All mutations route through yamlio's fresh-read + atomic-write core, so they're
safe to run alongside another writer (e.g. the web drawer editing the same file).
"""

import re
from pathlib import Path

from . import yamlio
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


def _to_item(node) -> dict:
    notes_raw = node.get("notes")
    notes = [to_str(n) for n in notes_raw] if isinstance(notes_raw, list) else []
    tasks_raw = node.get("tasks")
    tasks = []
    if isinstance(tasks_raw, list):
        for t in tasks_raw:
            if isinstance(t, dict):
                tasks.append({
                    "title": to_str(t.get("title")),
                    "status": to_str(t.get("status")) or "todo",
                })
    calc = node.get("calc-status")
    phase = node.get("phase")
    created = node.get("created")
    completed = node.get("completed")
    return {
        "id": to_str(node.get("id")),
        "title": to_str(node.get("title")),
        "type": to_str(node.get("type")) or "feature",
        "status": to_str(node.get("status")) or "todo",
        "priority": to_str(node.get("priority")) if node.get("priority") is not None else None,
        "phase": int(phase) if phase not in (None, "") else None,
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
    item["phase"] = None
    item["created"] = now_iso
    item["completed"] = None
    seq.append(item)
    yamlio.save(y, file, data)
    return {"id": item_id, "title": t, "type": "feature", "status": "todo",
            "priority": "medium", "phase": None, "notes": [],
            "created": now_iso, "completed": None}


def update_todo(file: Path, item_id: str, patch: dict, now_iso=None) -> bool:
    """Patch status/notes/priority/type on an item. `now_iso` stamps `completed`
    when status flips to done and clears it when status leaves done."""
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
    if isinstance(patch.get("notes"), list):
        node["notes"] = yamlio.notes_node(patch["notes"])
    if isinstance(patch.get("priority"), str):
        node["priority"] = patch["priority"]
    if isinstance(patch.get("type"), str):
        node["type"] = patch["type"]
    yamlio.save(y, file, data)
    return True


def archive_todos(file: Path, stamp: str):
    """Move every `done` item out of TODO.yaml into ARCHIVE/TODO/todo_<stamp>.yaml
    (relative to TODO.yaml's dir). The archive is written FIRST, then the main
    file is pruned — a crash between the two atomic writes duplicates the done
    items (recoverable), never loses them. Returns (count, archive_path)."""
    from ruamel.yaml.comments import CommentedSeq

    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return 0, None
    done_idx = [i for i, n in enumerate(seq)
                if isinstance(n, dict) and to_str(n.get("status")) == "done"]
    if not done_idx:
        return 0, None
    done_nodes = [seq[i] for i in done_idx]

    safe = re.sub(r"[:.]", "-", stamp)
    archive_dir = file.parent / "ARCHIVE" / "TODO"
    archive_file = archive_dir / f"todo_{safe}.yaml"
    ay = yamlio.yaml()
    adata = ay.load("todos: []\n")
    adata.yaml_set_start_comment(f" Archived done items — moved out of TODO.yaml at {stamp}.")
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
