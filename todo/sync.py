"""Sync a `.TODO/` store with a team server.

A round diffs the local files against `.sync/snapshot.json` (what the server
last said, with a version per field), pushes the differences as ops, then pulls
every change after the saved cursor and writes it back into the files. Because
the diff compares files rather than commands, edits from the web drawer or by
hand sync too. See docs/plans/2026-10-02-team-store-implementation.md §2.5.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import checkout, docs, frontmatter, gitfacts, identity, store, ulid, yamlio
from .uids import hash_uid as _hash_uid  # noqa: F401 — the name callers know
from .remote import Remote, RemoteError, sync_config, sync_dir
from .util import to_str

SNAPSHOT_FILE = "snapshot.json"
OUTBOX_FILE = "outbox.json"
LOCK_FILE = "lock"
ROUND_LOCK_FILE = "round"
PUSH_FLAG_FILE = "push"
ITEM_LOCK_DIR = "locks"
CHANGED_DIR = "changed"       # one empty file per item id whose files changed since its last diff
SWEPT_FILE = "swept"          # touched by each full scan
SWEEP_EVERY = 300             # seconds between full scans, for edits nothing marked
NEW_ITEMS = "+new"           # the item lock `add` takes for the item it creates
BATCH = 200

ITEM_KEYS = {"id", "uid", "title", "type", "status", "priority", "super-phase", "created",
             "completed", "calc-status", "creator", "developer", "qa_assignee"}
SETTABLE = {
    "item": ["title", "type", "status", "priority", "super_phase", "creator", "developer",
             "qa_assignee"],
    "task": ["title", "status", "phase", "position"],
    "note": ["kind", "text"],
    "log": ["text"],
    "check": ["kind", "title", "payload", "timing", "status", "envs"],
}
JSON_FIELD = {"item": "extra", "note": "meta", "log": "meta"}
CREATE_ONLY = {"item": ["id", "created"], "task": ["n"], "note": ["n", "ts"],
               "log": ["n", "ts"], "check": ["n"]}
CHILDREN = ["task", "note", "log", "check"]


def enabled(root: Path) -> bool:
    return sync_config(root) is not None


try:
    import fcntl
except ImportError:              # Windows: no flock; commands and rounds may interleave
    fcntl = None


def _lock_file(root: Path, *parts: str):
    f = sync_dir(root).joinpath(*parts)
    f.parent.mkdir(parents=True, exist_ok=True)
    return open(f, "a+")


@contextlib.contextmanager
def locked(root: Path, items=None):
    """Hold the store for a command. With `items` (item uids, possibly none)
    the store is shared and only those items are held, so commands on other
    items and sync rounds run alongside; with None, the whole store is held."""
    if fcntl is None:
        yield
        return
    with contextlib.ExitStack() as stack:
        fh = stack.enter_context(_lock_file(root, LOCK_FILE))
        fcntl.flock(fh, fcntl.LOCK_EX if items is None else fcntl.LOCK_SH)
        for key in sorted(set(items or ())):
            fcntl.flock(stack.enter_context(_lock_file(root, ITEM_LOCK_DIR, key)), fcntl.LOCK_EX)
        yield


_held = threading.local()


@contextlib.contextmanager
def _hold(root: Path, key, wait: bool = True):
    """A round's hold on one item while it reads or writes that item's files;
    yields False when the item is busy and `wait` is off. Re-entrant, since
    writing a log entry can happen inside another write."""
    held = _held.__dict__.setdefault("keys", {})
    if fcntl is None or not key or key in held:
        yield True
        return
    with _lock_file(root, ITEM_LOCK_DIR, key) as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except BlockingIOError:
            yield False
            return
        held[key] = fh
        try:
            yield True
        finally:
            del held[key]


def flag_changes(root: Path) -> None:
    """Ask for a push round, from this process or whichever one is running rounds."""
    sync_dir(root).mkdir(exist_ok=True)
    (sync_dir(root) / PUSH_FLAG_FILE).touch()


def mark_changed(root: Path, item_id: str) -> None:
    """Tell the next round to diff this item. Mark after writing, never before."""
    d = sync_dir(root) / CHANGED_DIR
    d.mkdir(parents=True, exist_ok=True)
    (d / item_id).touch()


def request_sweep(root: Path) -> None:
    """Have the next round scan every item, for changes nothing marked."""
    (sync_dir(root) / SWEPT_FILE).unlink(missing_ok=True)


def _sweep_due(root: Path) -> bool:
    try:
        return time.time() - (sync_dir(root) / SWEPT_FILE).stat().st_mtime > SWEEP_EVERY
    except FileNotFoundError:
        return True


def _take_marks(root: Path) -> set:
    d = sync_dir(root) / CHANGED_DIR
    try:
        names = os.listdir(d)
    except FileNotFoundError:
        return set()
    for n in names:
        (d / n).unlink(missing_ok=True)
    return set(names)


def _take_flag(root: Path) -> bool:
    try:
        (sync_dir(root) / PUSH_FLAG_FILE).unlink()
        return True
    except FileNotFoundError:
        return False


def rounds(root: Path, first=None, *, wait: bool = False) -> Report | None:
    """Run `first()`, then a push round per `flag_changes`, as the store's only
    round runner. When another process is running rounds this returns None at
    once (after it, with `wait`), and that process pushes the flagged changes.
    The reports of the rounds run here, summed."""
    total = None
    while True:
        with _lock_file(root, ROUND_LOCK_FILE) as runner:
            if fcntl is not None:
                try:
                    fcntl.flock(runner, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
                except BlockingIOError:
                    return total
            with locked(root, []):
                if first is not None:
                    total = _sum(total, first())
                    first = None
                while _take_flag(root):
                    total = _sum(total, quiet_round(root, push_only=True))
        if not (sync_dir(root) / PUSH_FLAG_FILE).exists():
            return total
        wait = False


def _sum(a: Report | None, b: Report | None) -> Report | None:
    if a is None or b is None:
        return a or b
    return Report(a.pushed + b.pushed, a.rejected + b.rejected, a.pulled + b.pulled,
                  a.messages + b.messages, b.error or a.error, a.doc_failures + b.doc_failures)


# ── snapshot ──────────────────────────────────────────────────────────────────
def load_snapshot(root: Path) -> dict:
    f = sync_dir(root) / SNAPSHOT_FILE
    if f.is_file():
        try:
            data = json.loads(f.read_text())
            if isinstance(data, dict):
                data.setdefault("cursor", 0)
                data.setdefault("entities", {})
                data.setdefault("deferred", [])
                data.setdefault("stuck", {})
                data.setdefault("docs", {})
                return data
        except ValueError:
            pass
    return {"cursor": 0, "entities": {}, "deferred": [], "stuck": {}, "docs": {}}


def save_snapshot(root: Path, snap: dict) -> None:
    sync_dir(root).mkdir(exist_ok=True)
    yamlio.write_atomic(sync_dir(root) / SNAPSHOT_FILE, json.dumps(snap, sort_keys=True) + "\n")


def load_outbox(root: Path) -> list:
    """Ops pushed but not yet acknowledged. They are replayed with the same op
    ids, so a push whose response was lost is applied exactly once."""
    f = sync_dir(root) / OUTBOX_FILE
    if not f.is_file():
        return []
    try:
        data = json.loads(f.read_text())
    except ValueError:
        return []
    return data if isinstance(data, list) else []


def save_outbox(root: Path, ops: list) -> None:
    f = sync_dir(root) / OUTBOX_FILE
    if ops:
        sync_dir(root).mkdir(exist_ok=True)
        yamlio.write_atomic(f, json.dumps(ops) + "\n")
    elif f.exists():
        f.unlink()


def _fingerprint(data) -> str:
    return hashlib.sha1(json.dumps(data, sort_keys=True).encode()).hexdigest()


# ── uids ──────────────────────────────────────────────────────────────────────
def _plain(value):
    """A JSON-safe copy of a YAML value."""
    return json.loads(json.dumps(value, default=str))


def ensure_uids(root: Path, project: str, ids=None) -> None:
    """Give every entity (of the items in `ids`, if given) a uid and write it
    into its file. Never recomputes one that exists."""
    for d in store._item_dirs(root):
        if ids is not None and d.name not in ids:
            continue
        try:
            meta = yamlio.read(d / store.ITEM_FILE)
        except Exception:  # noqa: BLE001 — unreadable item file: scan skips it too
            continue
        if not isinstance(meta, dict):
            continue
        uid = to_str(meta.get("uid")) or _hash_uid(project, d.name, to_str(meta.get("created")))
        with _hold(root, uid, wait=False) as free:
            if not free or not (d / store.ITEM_FILE).is_file():
                continue                    # a command has it; the next round does
            if not meta.get("uid"):
                y, meta = store._load_meta(d)
                meta["uid"] = uid
                yamlio.save(y, d / store.ITEM_FILE, meta)
            try:
                _backfill_children(d, uid)
            except Exception:  # noqa: BLE001 — a malformed child file: scan marks the item incomplete
                continue


def _backfill_children(d: Path, uid: str) -> None:
    tasks = store._read_tasks(d)
    if any(not t.get("uid") for t in tasks):
        seen: dict = {}
        fixed = []
        for t in tasks:
            t = dict(t)
            if not t.get("uid"):
                k = t["title"]
                seen[k] = seen.get(k, 0) + 1
                t["uid"] = _hash_uid(uid, "task", t["title"], seen[k])
            fixed.append(t)
        store._write_tasks(d, tasks, fixed)
    for sub, entity in ((store.NOTES_DIR, "note"), (store.LOG_DIR, "log")):
        for e in store.read_entries(d / sub):
            if e["meta"].get("uid"):
                continue
            meta2 = dict(e["meta"])
            meta2["uid"] = _hash_uid(uid, entity, e["ts"],
                                     hashlib.sha1(e["text"].encode()).hexdigest())
            if entity == "note":
                meta2.setdefault("kind", "context")
            yamlio.write_atomic(e["file"], frontmatter.join(meta2, e["text"] + "\n"))
    checks = store._read_checks(d)
    if any(not c.get("uid") for c in checks):
        seen_checks: dict = {}
        for c in checks:
            if not c.get("uid"):
                k = (c["title"], c["kind"])
                seen_checks[k] = seen_checks.get(k, 0) + 1
                c["uid"] = _hash_uid(uid, "check", c["title"], c["kind"], seen_checks[k])
        _write_checks(d, checks)


def _write_checks(item_dir: Path, checks: list) -> None:
    f = item_dir / store.CHECKS_DIR / store.CHECKS_FILE
    if checks:
        f.parent.mkdir(exist_ok=True)
        yamlio.write_atomic(f, yamlio.dump(yamlio.yaml(), yamlio.checks_doc(checks)))
    elif f.exists():
        f.unlink()
        with contextlib.suppress(OSError):
            f.parent.rmdir()


# ── reading local entities ────────────────────────────────────────────────────
@dataclass
class Local:
    entities: dict = field(default_factory=dict)    # uid → {entity, item_uid, data}
    item_dirs: dict = field(default_factory=dict)   # item uid → directory
    files: dict = field(default_factory=dict)       # note/log/history uid → file
    incomplete: set = field(default_factory=set)    # item uids not fully read
    history: dict = field(default_factory=dict)     # item uid → provisional entries
    via: dict = field(default_factory=dict)         # note/log uid → who wrote it (human/agent)
    busy: set = field(default_factory=set)          # item uids a command held: left for the next round
    scanned: set = field(default_factory=set)       # item uids whose files were read; the rest only located


def _follow(root: Path, local: Local, item_uid: str) -> None:
    """Point `local` at the item's directory as it is now: a command may have
    moved it to another folder since the scan."""
    old = local.item_dirs.get(item_uid)
    if old is None or old.exists():
        return
    new = store._find_dir(root, old.name)
    if new is None:
        return
    local.item_dirs[item_uid] = new
    for k, f in list(local.files.items()):
        if f.is_relative_to(old):
            local.files[k] = new / f.relative_to(old)
    for e in local.history.get(item_uid, []):
        e["file"] = new / e["file"].relative_to(old)


def _reload(root: Path, local: Local, item_uid: str) -> None:
    """Re-read one item into `local`, for its current values."""
    _follow(root, local, item_uid)
    d = local.item_dirs.get(item_uid)
    if d is None or not d.exists():
        return
    mine = [u for u, e in local.entities.items() if e["item_uid"] == item_uid]
    for u in mine:
        local.entities.pop(u, None)
        local.files.pop(u, None)
        local.via.pop(u, None)
    for e in local.history.pop(item_uid, []):
        local.files.pop(e["meta"].get("uid"), None)
    local.incomplete.discard(item_uid)
    local.busy.discard(item_uid)
    _scan_item(local, d, item_uid)


def _flatten(entity: str, data: dict) -> dict:
    col = JSON_FIELD.get(entity)
    if not col or col not in data:
        return data
    out = {k: v for k, v in data.items() if k != col}
    for k, v in (data[col] or {}).items():
        out[f"{col}.{k}"] = v
    return out


def _unflatten(entity: str, flat: dict) -> dict:
    col = JSON_FIELD.get(entity)
    if not col:
        return dict(flat)
    out = {k: v for k, v in flat.items() if not k.startswith(col + ".")}
    out[col] = {k[len(col) + 1:]: v for k, v in flat.items()
                if k.startswith(col + ".") and (v is not None or entity == "item")}
    return out


def _item_flat(d: Path, meta: dict) -> dict:
    sp = meta.get("super-phase")
    flat = {
        "id": d.name, "title": to_str(meta.get("title")),
        "type": to_str(meta.get("type")) or "feature",
        "status": to_str(meta.get("status")) or "todo",
        "priority": to_str(meta.get("priority")) if meta.get("priority") is not None else None,
        "super_phase": int(sp) if sp not in (None, "") else None,
        "creator": to_str(meta.get("creator")) or None,
        "developer": to_str(meta.get("developer")) or None,
        "qa_assignee": to_str(meta.get("qa_assignee")) or None,
        "created": to_str(meta.get("created")) or None,
    }
    for k, v in meta.items():
        if k not in ITEM_KEYS:
            flat[f"extra.{k}"] = _plain(v)
    if flat.get("extra.phases") is not None:
        flat["extra.phases"] = store.phase_titles(meta.get("phases")) or None
    return flat


def _item_uid(d: Path) -> str | None:
    try:
        meta = yamlio.read(d / store.ITEM_FILE)
    except Exception:  # noqa: BLE001 — unreadable item: leave it out
        return None
    return to_str(meta.get("uid")) if isinstance(meta, dict) else None


def scan(root: Path, ids=None) -> Local:
    """Every item's files, or with `ids` only those items'; the others are
    just located."""
    local = Local()
    for d in store._item_dirs(root):
        uid = _item_uid(d)
        if uid and ids is not None and d.name not in ids:
            local.item_dirs[uid] = d
        elif uid:
            with _hold(root, uid, wait=False) as free:
                if not free:
                    local.item_dirs[uid] = d
                    local.busy.add(uid)
                elif (d / store.ITEM_FILE).is_file():
                    _scan_item(local, d, uid)
    return local


def _scan_item(local: Local, d: Path, uid: str) -> None:
    try:
        meta = yamlio.read(d / store.ITEM_FILE)
        meta = meta if isinstance(meta, dict) else {}
    except Exception:  # noqa: BLE001 — unreadable item: leave it out
        return
    local.item_dirs[uid] = d
    local.scanned.add(uid)
    try:
        local.entities[uid] = {"entity": "item", "item_uid": uid, "data": _item_flat(d, meta)}
    except Exception:  # noqa: BLE001 — e.g. a non-numeric super-phase: sync nothing of it
        local.incomplete.add(uid)
        return
    try:
        positions: dict = {}
        for t in store._read_tasks(d):
            pos = positions.get(t["phase"], 0)
            positions[t["phase"]] = pos + 1
            if t.get("uid"):
                local.entities[t["uid"]] = {"entity": "task", "item_uid": uid, "data": {
                    "n": t["id"], "title": t["title"], "status": t["status"],
                    "phase": t["phase"], "position": pos}}
        for e in store.read_entries(d / store.NOTES_DIR):
            m = e["meta"]
            if not m.get("uid"):
                continue
            flat = {"n": e["id"], "ts": e["ts"], "kind": m.get("kind") or "context",
                    "text": e["text"]}
            for k, v in m.items():
                if k not in ("uid", "kind", "author", "via"):
                    flat[f"meta.{k}"] = _plain(v)
            local.entities[m["uid"]] = {"entity": "note", "item_uid": uid, "data": flat}
            local.files[m["uid"]] = e["file"]
            if m.get("via"):
                local.via[m["uid"]] = m["via"]
        for e in store.read_entries(d / store.LOG_DIR):
            if e["meta"].get("uid"):
                flat = {"n": e["id"], "ts": e["ts"], "text": e["text"]}
                for k, v in e["meta"].items():
                    if k not in ("uid", "author", "via"):
                        flat[f"meta.{k}"] = _plain(v)
                local.entities[e["meta"]["uid"]] = {"entity": "log", "item_uid": uid, "data": flat}
                local.files[e["meta"]["uid"]] = e["file"]
                if e["meta"].get("via"):
                    local.via[e["meta"]["uid"]] = e["meta"]["via"]
        for c in store._read_checks(d):
            if c.get("uid"):
                local.entities[c["uid"]] = {"entity": "check", "item_uid": uid, "data": {
                    "n": c["id"], "kind": c["kind"], "title": c["title"],
                    "payload": c["payload"], "timing": c["timing"], "status": c["status"],
                    "envs": store.env_text(c["envs"])}}
        for e in store.read_entries(d / store.HISTORY_DIR):
            if e["meta"].get("uid"):
                local.files[e["meta"]["uid"]] = e["file"]
            if not e["meta"].get("server"):
                local.history.setdefault(uid, []).append(e)
    except Exception:  # noqa: BLE001 — partly read: never infer removes from it
        local.incomplete.add(uid)


# ── diff ──────────────────────────────────────────────────────────────────────
def _same(a, b) -> bool:
    return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)


def _set_fields(entity: str, local: dict, snap: dict) -> list:
    keys = list(SETTABLE[entity])
    col = JSON_FIELD.get(entity)
    if col:
        dotted = {k for k in list(local) + list(snap) if k.startswith(col + ".")}
        keys += sorted(dotted)
    return [k for k in keys if not _same(local.get(k), snap.get(k))]


def _op(op: str, entity: str, uid: str, item_uid: str, **extra) -> dict:
    from . import identity

    return {"op_id": ulid.new(), "op": op, "entity": entity, "uid": uid, "item_uid": item_uid,
            "via": identity.via(), **extra}


def diff(local: Local, snap: dict) -> list:
    """Ops that bring the server up to the local files, in apply order: item
    creates, child creates, child sets, item sets, removes. An entity whose
    last op was refused for good is skipped until its local data changes."""
    ents = snap["entities"]
    stuck = snap.get("stuck", {})
    buckets = {k: [] for k in ("item-create", "child-create", "child-set", "item-set", "request-set", "remove")}
    for uid, e in local.entities.items():
        entity, data = e["entity"], e["data"]
        if e["item_uid"] in local.incomplete or e["item_uid"] in local.busy:
            continue
        if uid in stuck:
            if stuck[uid] == _fingerprint(data):
                continue
            del stuck[uid]
        s = ents.get(uid)
        if s is None:
            body = _unflatten(entity, data)
            if entity == "item" and local.history.get(uid):
                body["history"] = [_history_entry(h) for h in local.history[uid]]
            key = "item-create" if entity == "item" else "child-create"
            op = _op("create", entity, uid, e["item_uid"], data=body, _fp=_fingerprint(data))
            if uid in local.via:
                op["via"] = local.via[uid]       # the author's, not this session's
            if entity == "item":
                _status_provenance(op, local.history.get(uid, []), data["status"])
            buckets[key].append(op)
            continue
        changed = _set_fields(entity, data, s["data"])
        if not changed:
            continue
        op = _op("set", entity, uid, e["item_uid"],
                 data={k: data.get(k) for k in changed},
                 base={k: s["versions"][k] for k in changed if k in s.get("versions", {})},
                 _fp=_fingerprint(data))
        if entity == "item" and "status" in changed:
            _status_provenance(op, local.history.get(uid, []), data["status"])
        # A request edit goes after status sets: the server only accepts it once
        # the item is back in requested or triage.
        late = entity == "note" and s["data"].get("kind") == "ticket-request"
        buckets["item-set" if entity == "item" else "request-set" if late else "child-set"].append(op)
    for uid, s in ents.items():
        if s["entity"] in ("item", "history") or uid in local.entities:
            continue
        if s["item_uid"] in local.incomplete or s["item_uid"] not in local.scanned:
            continue
        fp = _fingerprint({"remove": s.get("versions", {})})
        if stuck.get(uid) == fp:
            continue
        buckets["remove"].append(_op("remove", s["entity"], uid, s["item_uid"],
                                     base=dict(s.get("versions", {})), _fp=fp))
    ops = [op for k in buckets for op in buckets[k]]
    _group_rejections(ops)
    return ops


def _history_entry(e) -> dict:
    m = e["meta"]
    return {"uid": m.get("uid"), "from": m.get("from"), "to": m.get("to"), "by": m.get("by"),
            "via": m.get("via"), "forced": bool(m.get("forced")), "ts": e["ts"]}


def _status_provenance(op: dict, provisional: list, status: str) -> None:
    """A status set carries `via` and `forced` from the newest provisional
    history entry that reached that status."""
    for e in reversed(provisional):
        if e["meta"].get("to") == status:
            if e["meta"].get("via"):
                op["via"] = e["meta"]["via"]
            if e["meta"].get("forced"):
                op["force"] = True
            return


def _group_rejections(ops: list) -> None:
    """A qa-rejection note travels in one group with the status change it came
    with, so neither lands without the other."""
    status_sets = {op["item_uid"]: op for op in ops
                   if op["entity"] == "item" and op["op"] == "set" and "status" in op["data"]}
    for op in ops:
        if op["entity"] != "note" or op["op"] != "create":
            continue
        meta = op["data"].get("meta") or {}
        partner = status_sets.get(op["item_uid"])
        if (op["data"].get("kind") == "qa-rejection" and partner
                and meta.get("with_status") == partner["data"]["status"]):
            group = partner.get("group") or ulid.new()
            partner["group"] = op["group"] = group


# ── a round ───────────────────────────────────────────────────────────────────
@dataclass
class Report:
    pushed: int = 0
    rejected: int = 0
    pulled: int = 0
    messages: list = field(default_factory=list)
    error: str | None = None
    doc_failures: list = field(default_factory=list)    # docs not transferred this round, with why


def run_round(root: Path, remote: Remote, *, push_only: bool = False, adopt: bool = False,
              sweep: bool = False, doc_limit: int | None = None) -> Report:
    """One push + pull, then the docs. The push diffs the items marked
    changed, or every item when a sweep is asked for or due. Commands may run
    alongside: each item's files are read and written under that item's lock.
    A network failure stops the round where it is; nothing local is lost, the
    diff just runs again. Docs larger than `doc_limit` wait for a round
    without one; a doc failure is reported and never stops the round."""
    cfg = sync_config(root) or {}
    project = cfg.get("project")
    report = Report()
    full = sweep or adopt or _sweep_due(root)
    marks = _take_marks(root)
    if push_only and not full and not marks and not load_outbox(root) \
            and not (sync_dir(root) / LARGE_DOCS_FILE).exists():
        return report               # nothing to push
    snap = load_snapshot(root)
    full = full or not snap["entities"]
    ids = None if full else marks
    pushed = False
    rejected_fields: set = set()
    pushed_status: set = set()
    try:
        ensure_uids(root, project, ids)
        seen = _git_facts(root, remote, project)    # before the push: the server's guard reads them
        if adopt and not snap["entities"]:
            # First link: the server's state wins over the clone, and every
            # field it replaces is reported.
            _pull(root, remote, project, snap, report, Local(), set(), adopt=True)
            save_snapshot(root, snap)
        replay = load_outbox(root)
        if replay:
            local = scan(root)
            _push(root, remote, project, replay, local, snap, report, rejected_fields, pushed_status,
                  replay=True)
            _drop_provisional_history(root, local, pushed_status)
        local = scan(root, ids)
        if full:
            sync_dir(root).mkdir(exist_ok=True)
            (sync_dir(root) / SWEPT_FILE).touch()
        for uid in local.busy:
            mark_changed(root, local.item_dirs[uid].name)
        ops = diff(local, snap)
        if ops:
            save_snapshot(root, snap)
        _push(root, remote, project, ops, local, snap, report, rejected_fields, pushed_status)
        pushed = True
        _drop_provisional_history(root, local, pushed_status)
        if not push_only:
            _pull(root, remote, project, snap, report, local, rejected_fields)
        deferred = bool(snap.get("deferred"))
        _retry_deferred(root, snap, local, rejected_fields)
        docs_before = _same_meta([snap.get("docs"), snap.get(DOCS_BACKFILLED)])
        sync_docs(root, remote, project, local, snap, report, doc_limit)
        if ops or replay or deferred or full or docs_before != _same_meta([snap.get("docs"), snap.get(DOCS_BACKFILLED)]):
            save_snapshot(root, snap)
        try:
            checkout.report(sync_dir(root), remote, project)
        except RemoteError:
            pass                    # a server without checkout reports, or a blip; the next round retries
        from . import plugins
        plugins.after_round(root, remote, project, seen)
    except RemoteError as e:
        report.error = str(e)
    finally:
        if not pushed:
            for item_id in marks:
                mark_changed(root, item_id)
    return report


def _git_facts(root: Path, remote: Remote, project: str) -> dict:
    """Recompute git facts for branches that moved, and post what changed.
    Returns each repo's ls-remote answer, for the plugins' push events."""
    seen: dict = {}
    try:
        gitfacts.on_round(root, remote, project, seen=seen)
    except Exception as e:  # noqa: BLE001 — git facts must never break a round
        print(f"git facts: skipped ({type(e).__name__}: {e})", file=sys.stderr)
    return seen


BATCH_BYTES = 1_000_000          # well under Vercel's 4.5 MB request limit


def _wire(op: dict) -> dict:
    return {k: v for k, v in op.items() if not k.startswith("_")}


def _units(ops: list) -> list:
    """Ops grouped so a group's members are never separated."""
    units, groups = [], {}
    for op in ops:
        g = op.get("group")
        if g and g in groups:
            groups[g].append(op)
            continue
        unit = [op]
        if g:
            groups[g] = unit
        units.append(unit)
    return units


def _batches(ops: list) -> list:
    """Split ops into pushes of at most BATCH ops and BATCH_BYTES, never
    separating the members of a group."""
    out, cur, size = [], [], 0
    for unit in _units(ops):
        n = sum(len(json.dumps(_wire(op))) for op in unit)
        if cur and (len(cur) + len(unit) > BATCH or size + n > BATCH_BYTES):
            out.append(cur)
            cur, size = [], 0
        cur += unit
        size += n
    if cur:
        out.append(cur)
    return out


# Push refusals that will not change on a retry of the same batch.
# A 404 or 409 says the server or project is wrong, not the op, so it stays a
# round error and nothing is parked.
REFUSED = {400, 413, 422}


def _push(root, remote, project, ops, local, snap, report, rejected_fields, pushed_status,
          replay: bool = False) -> None:
    """Push `ops` in batches. Each batch sits in the outbox until its results
    are recorded, so a lost response is replayed with the same op ids. A batch
    the server refuses outright is split until the offending op is found; that
    op is parked so it can't wedge the outbox."""
    pending = _batches(ops)
    while pending:
        batch = pending.pop(0)
        save_outbox(root, [op for b in [batch] + pending for op in b])
        try:
            results = remote.push(project, [_wire(op) for op in batch])
        except RemoteError as e:
            if e.status not in REFUSED:
                raise
            units = _units(batch)
            if len(units) > 1:
                half = len(units) // 2
                pending[:0] = [[op for u in units[:half] for op in u], [op for u in units[half:] for op in u]]
                continue
            for op in batch:
                _park(root, op, local, snap, report, f"refused by the server ({e.status})")
            save_snapshot(root, snap)
            continue
        _handle_results(root, batch, results, local, snap, report, rejected_fields, pushed_status, replay)
        save_snapshot(root, snap)
    save_outbox(root, [])


def _park(root, op, local, snap, report, why: str) -> None:
    if op.get("_fp"):
        snap.setdefault("stuck", {})[op["uid"]] = op["_fp"]
    with _hold(root, op["item_uid"]):
        _follow(root, local, op["item_uid"])
        item_id = _item_id(local, op["item_uid"])
        text = f'{op["op"]} {op["entity"]} not applied ({why})'
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            _sync_log(root, item_id, text)


def _still_local(local: Local, op: dict) -> bool:
    """For a replayed op: are the fields it carried still the local values? If
    not, a newer local edit supersedes it and the diff pushes that instead."""
    try:
        cur = _fresh(local, op["entity"], op["uid"])
    except Exception:  # noqa: BLE001
        return False
    if cur is None:
        return False
    data = op.get("data") or {}
    flat = _flatten(op["entity"], {k: v for k, v in data.items() if k != "history"})
    return all(_same(cur.get(k), v) for k, v in flat.items() if k in cur)


def _handle_results(root, ops, results, local, snap, report, rejected_fields, pushed_status,
                    replay: bool = False):
    by_id = {r.get("op_id"): r for r in results if isinstance(r, dict)}
    renames = []
    for op in ops:
        r = by_id.get(op["op_id"])
        if r is None:
            continue
        with _hold(root, op["item_uid"]):
            _follow(root, local, op["item_uid"])
            _handle_result(root, op, r, local, snap, report, rejected_fields, pushed_status, replay,
                           renames)
    for op, new in renames:
        with _hold(root, op["item_uid"]):
            _follow(root, local, op["item_uid"])
            _rename(root, op, new, local, report)


def _handle_result(root, op, r, local, snap, report, rejected_fields, pushed_status, replay, renames):
    ents = snap["entities"]
    uid, entity = op["uid"], op["entity"]
    report.pushed += 1
    current = not replay or _still_local(local, op)
    # A replay that a newer local edit superseded must leave that edit's
    # provisional history alone; its own push clears it.
    if entity == "item" and op["op"] == "set" and current and "status" in (r.get("versions") or {}):
        pushed_status.add(uid)
    if entity == "item" and op["op"] == "set" and current and any(
            x["field"] == "status" and "server_value" in x for x in r.get("rejected") or []):
        pushed_status.add(uid)          # the server's status was adopted; the local trail never happened
    if entity == "item" and op["op"] == "create" and r.get("status") == "applied" \
            and (op.get("data") or {}).get("history"):
        pushed_status.add(uid)
    if r.get("status") == "rejected" and not r.get("rejected"):
        report.rejected += 1
        if op["op"] == "set" and r.get("reason") == "group-rolled-back":
            for k in op["data"]:
                rejected_fields.add(("held", uid, k))
        if current:
            _whole_op_rejected(root, op, r, local, snap, report)
        return
    versions = r.get("versions") or {}
    bad = {x["field"] for x in r.get("rejected") or []}
    if op["op"] == "set":
        for k in op["data"]:
            if k not in versions and k not in bad:
                rejected_fields.add(("held", uid, k))   # not applied: keep it local through the pull
    for x in r.get("rejected") or []:
        report.rejected += 1
        if not current:
            continue                    # a newer local edit replaced this one
        rejected_fields.add((uid, x["field"]))
        _log_rejection(root, op, x, local, report)
        if op["op"] == "set" and "server_value" in x:
            _adopt_server_value(root, op, x, local, ents)
    if op["op"] == "create":
        data = _flatten(entity, {k: v for k, v in op["data"].items() if k != "history"})
        ents[uid] = {"entity": entity, "item_uid": op["item_uid"], "data": data, "versions": versions}
        if r.get("assigned_n") is not None:
            renames.append((op, r["assigned_n"]))
            ents[uid]["data"]["n"] = r["assigned_n"]
        if r.get("assigned_id"):
            renames.append((op, r["assigned_id"]))
            ents[uid]["data"]["id"] = r["assigned_id"]
    elif op["op"] == "set":
        s = ents.get(uid)
        if s is not None:
            for k, v in op["data"].items():
                if k in bad or k not in versions:
                    continue
                s["data"][k] = v
                s["versions"][k] = versions[k]
    elif op["op"] == "remove":
        ents.pop(uid, None)
        removed = snap.setdefault("removed", [])
        if uid not in removed:
            removed.append(uid)


def _adopt_server_value(root, op, x, local: Local, ents) -> None:
    """A rejected field takes the server's value locally and in the snapshot
    right away; the pull may already be past the change that set it."""
    uid, entity, f = op["uid"], op["entity"], x["field"]
    s = ents.get(uid)
    if s is not None:
        s["data"][f] = x["server_value"]
        if x.get("version") is not None:
            s["versions"][f] = x["version"]
    try:
        cur = _fresh(local, entity, uid)
    except Exception:  # noqa: BLE001 — unreadable item file: the next pull retries
        return
    if cur is None:
        return
    flat = dict(cur)
    flat[f] = x["server_value"]
    row = _local_row(local, entity, uid, flat)
    _write_entity(root, local, entity, uid, op["item_uid"], flat, row)
    if entity != "item":
        local.entities[uid]["data"] = flat


def _local_row(local: Local, entity: str, uid: str, flat: dict) -> dict:
    """The non-synced parts a write needs, read from the local files."""
    if entity == "item":
        d = local.item_dirs[uid]
        meta = yamlio.read(d / store.ITEM_FILE) or {}
        completed = meta.get("completed")
        from .status import COMPLETE
        if flat.get("status") in COMPLETE:
            completed = completed or _now()
        else:
            completed = None
        return {"completed": completed, "calc_status": meta.get("calc-status")}
    if entity in ("note", "log"):
        f = local.files.get(uid)
        meta = frontmatter.split(f.read_text())[0] if f and f.exists() else {}
        return {"author": meta.get("author"), "via": meta.get("via")}
    return {}


def _drop_provisional_history(root, local: Local, pushed_status: set) -> None:
    """Server history replaces the provisional entries of every item whose
    status change was pushed (applied or rejected)."""
    for item_uid in pushed_status:
        with _hold(root, item_uid):
            _follow(root, local, item_uid)
            for e in local.history.get(item_uid, []):
                with contextlib.suppress(FileNotFoundError):
                    e["file"].unlink()


def _item_id(local: Local, item_uid: str) -> str | None:
    d = local.item_dirs.get(item_uid)
    return d.name if d else None


def _log_rejection(root, op, x, local, report) -> None:
    item_id = _item_id(local, op["item_uid"])
    label = "" if op["entity"] == "item" else f'{op["entity"]} '
    value = (op.get("data") or {}).get(x["field"])
    if x.get("reason") == "stale":
        who = x.get("by") or "someone"
        at = f' at {x["at"][:16].replace("T", " ")}' if x.get("at") else ""
        text = (f'offline {label}{x["field"]} → {value} not applied; '
                f'{who} set {x.get("server_value")}{at}')
    elif x.get("reason") == "waits-on" and x.get("edges"):
        at = f' (facts from {x["facts_at"][:16].replace("T", " ")})' if x.get("facts_at") else ""
        text = (f'{label}{x["field"]} → {value} not applied; the server still sees {", ".join(x["edges"])}{at}; '
                "it's rechecking — retry in a minute, or use --force")
    else:
        text = f'{label}{x["field"]} → {value} not applied ({x.get("reason")})'
    report.messages.append(f"{item_id}: {text}")
    if item_id:
        _sync_log(root, item_id, text)


# Refusals that will not change on a retry; the entity waits for a local edit.
FINAL = {"error", "bad-entity", "bad-op", "not-removable", "unknown", "agent-handoff", "request-frozen",
         "bad-relation", "already-related", "jira-read-only"}


def _sync_log(root: Path, item_id: str, text: str) -> None:
    store.add_log(root, item_id, "sync: " + text, _now())
    mark_changed(root, item_id)


def _reissue(root: Path, local: Local, entity: str, old: str, item_uid: str) -> None:
    """Give one local entity a fresh uid, so it is created next round."""
    d = local.item_dirs.get(item_uid)
    if d is None:
        return
    try:
        _rewrite_uids(d, {old: ulid.new()}, entities={entity})
    except Exception:  # noqa: BLE001 — a malformed file: it keeps its uid until fixed
        return
    mark_changed(root, d.name)


def _rewrite_uids(d: Path, mapping: dict, entities=("task", "note", "log", "check")) -> None:
    """Swap uids in an item's child files, `mapping` old → new."""
    def new(u):
        return mapping.get(u, u)
    if "task" in entities:
        before = store._read_tasks(d)
        after = [dict(t, uid=new(t["uid"]) if t.get("uid") else t.get("uid")) for t in before]
        if after != before:
            store._write_tasks(d, before, after)
    for sub, entity in ((store.NOTES_DIR, "note"), (store.LOG_DIR, "log")):
        if entity not in entities:
            continue
        for e in store.read_entries(d / sub):
            if e["meta"].get("uid") and new(e["meta"]["uid"]) != e["meta"]["uid"]:
                meta = dict(e["meta"], uid=new(e["meta"]["uid"]))
                yamlio.write_atomic(e["file"], frontmatter.join(meta, e["text"] + "\n"))
    if "check" in entities:
        checks = store._read_checks(d)
        changed = [dict(c, uid=new(c["uid"]) if c.get("uid") else c.get("uid")) for c in checks]
        if changed != checks:
            _write_checks(d, changed)


def _plugin_owned(entity: str, data: dict) -> str | None:
    """The plugin instance that made a note or log entry, from its create op."""
    if entity not in ("note", "log"):
        return None
    meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    return meta.get("plugin") or data.get("meta.plugin")


def _whole_op_rejected(root, op, r, local, snap, report) -> None:
    item_id = _item_id(local, op["item_uid"])
    reason = r.get("reason") or "rejected"
    data = op.get("data") or {}
    uid, entity = op["uid"], op["entity"]
    what = f'{op["op"]} {entity}' + (f' [{data["n"]}]' if data.get("n") else "")
    if reason == "group-rolled-back" and op["op"] == "set":
        return                      # its fields stay local (held) and push again next round
    if reason == "no-item":
        return                      # its item's own refusal is what gets reported; this retries
    if reason == "uid-exists" and r.get("data"):
        row = r["data"]
        snap["entities"][uid] = {"entity": entity, "item_uid": op["item_uid"],
                                 "data": server_flat(entity, row), "versions": dict(row.get("versions") or {})}
        _write_entity(root, local, entity, uid, op["item_uid"], server_flat(entity, row), row)
        report.messages.append(f"{item_id}: {what}: the server already had it; took the server's copy")
        return
    if reason == "removed" and op["op"] == "remove":
        snap["entities"].pop(uid, None)     # someone else removed it first: same outcome
        return
    if reason == "removed" and op["op"] == "create" and _plugin_owned(entity, data):
        # A plugin entity someone removed stays removed: no new uid, no retry.
        snap["entities"].pop(uid, None)
        _delete_local(local, entity, uid, op["item_uid"])
        from . import plugins
        plugins.forget(root, op["item_uid"], uid)
        report.messages.append(f"{item_id}: {what} from plugin {_plugin_owned(entity, data)} not applied; "
                               f"{r.get('by') or 'someone'} removed it")
        return
    if reason == "removed" and op["op"] == "create" and uid in snap.get("removed", []):
        # This store already saw that uid removed (it pushed or pulled the
        # removal), so the local entity is a re-added one with a backfilled uid
        # derived from the same content: a new entity, so it gets a new uid.
        _reissue(root, local, entity, uid, op["item_uid"])
        return
    if reason == "removed" and op["op"] == "create":
        snap["entities"].pop(uid, None)
        _delete_local(local, entity, uid, op["item_uid"])
        text = f"{what} not applied; {r.get('by') or 'someone'} removed it"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            _sync_log(root, item_id, text)
        return
    if reason == "removed" and op["op"] == "set":
        snap["entities"].pop(uid, None)
        _delete_local(local, entity, uid, op["item_uid"])
        text = f"{what} not applied; {r.get('by') or 'someone'} removed it"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            _sync_log(root, item_id, text)
        return
    if reason in FINAL or reason.startswith("invalid"):
        if op.get("_fp"):
            snap.setdefault("stuck", {})[uid] = op["_fp"]
        text = f"{what} not applied ({reason}{': ' + r['message'] if r.get('message') else ''})"
        if reason == "request-frozen":
            text += f"; post a new version with `todo request {item_id} --text \"…\"`"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            _sync_log(root, item_id, text)
        return
    if reason == "group-rolled-back" and entity == "note":
        text = (f"{data.get('kind')} note not applied with its status change; "
                f"its text: {data.get('text')}")
        f = local.files.get(op["uid"])
        if f:
            with contextlib.suppress(FileNotFoundError):
                f.unlink()
    elif reason == "removed":
        who = r.get("by") or "someone"
        text = f"{what} not applied; {who} removed it"
    else:
        text = f"{what} not applied ({reason})"
    report.messages.append(f"{item_id}: {text}")
    if item_id:
        _sync_log(root, item_id, text)


def _now() -> str:
    from .util import now
    return now()


def _rename(root: Path, op: dict, new, local: Local, report: Report) -> None:
    entity, uid = op["entity"], op["uid"]
    item_dir = local.item_dirs.get(op["item_uid"])
    if entity == "item":
        if item_dir is None or item_dir.name == new:
            return
        dest = item_dir.parent / new
        if dest.exists():
            report.messages.append(f"{item_dir.name}: server renamed it {new}, but that exists locally")
            return
        os.rename(item_dir, dest)
        y, meta = store._load_meta(dest)
        meta["id"] = new
        yamlio.save(y, dest / store.ITEM_FILE, meta)
        local.item_dirs[uid] = dest
        report.messages.append(f"{item_dir.name} → {new}: the id was taken on the server")
        return
    if item_dir is None:
        return
    old = op["data"].get("n")
    if entity in ("note", "log"):
        f = local.files.get(uid)
        if f and f.exists():
            m = store._ENTRY_FILE.match(f.name)
            nf = f.with_name(f"{m.group('ts')}-{new}.{m.group('ext')}")
            os.rename(f, nf)
            local.files[uid] = nf
    elif entity == "task":
        before = store._read_tasks(item_dir)
        after = [dict(t, id=new) if t.get("uid") == uid else dict(t) for t in before]
        store._write_tasks(item_dir, before, after)
    elif entity == "check":
        checks = store._read_checks(item_dir)
        for c in checks:
            if c.get("uid") == uid:
                c["id"] = new
        _write_checks(item_dir, checks)
    report.messages.append(f"{item_dir.name}: {entity} [{old}] → [{new}] (number taken on the server)")


# ── pull ──────────────────────────────────────────────────────────────────────
# Project settings each changes page carries, kept in the store's sync config.
PROJECT_SETTINGS = ("deploy_step", "actions")

def _pull(root, remote, project, snap, report, before: Local, rejected_fields, adopt=False):
    """Fetch every change after the cursor and write it locally. A field whose
    local value moved since the diff read it (a drawer or hand edit) keeps its
    local value and its old snapshot entry, unless the server rejected it."""
    now = scan(root, ())
    while True:
        page = remote.changes(project, snap["cursor"])
        cfg = sync_config(root) or {}
        settings = {k: page[k] for k in PROJECT_SETTINGS if k in page and cfg.get(k) != page[k]}
        if settings:
            from .remote import save_sync_config
            save_sync_config(root, {**cfg, **settings})
        for ch in page.get("changes") or []:
            if not _apply_change(root, ch, snap, before, now, rejected_fields, adopt, report.messages):
                _defer(snap, ch)
            report.pulled += 1
        moved = bool(page.get("changes") or snap.get("deferred"))
        _retry_deferred(root, snap, now, rejected_fields)
        moved = moved or page.get("cursor", snap["cursor"]) != snap["cursor"]
        snap["cursor"] = page.get("cursor", snap["cursor"])
        if moved:
            save_snapshot(root, snap)
        if not page.get("more"):
            break


def server_flat(entity: str, row: dict) -> dict:
    if entity == "item":
        flat = {k: row.get(k) for k in ("id", "title", "type", "status", "priority", "super_phase",
                                        "creator", "developer", "qa_assignee", "created")}
        for k, v in (row.get("extra") or {}).items():
            flat[f"extra.{k}"] = v
        return flat
    if entity == "task":
        return {k: row.get(k) for k in ("n", "title", "status", "phase", "position")}
    if entity in ("note", "log"):
        flat = {k: row.get(k) for k in (("n", "ts", "kind", "text") if entity == "note" else ("n", "ts", "text"))}
        for k, v in (row.get("meta") or {}).items():
            flat[f"meta.{k}"] = v
        return flat
    if entity == "check":
        return {k: row.get(k) for k in ("n", "kind", "title", "payload", "timing", "status", "envs")}
    return {}


def _defer(snap: dict, ch: dict) -> None:
    """Keep a change that couldn't be written yet (its item isn't local, or its
    id is taken locally) to retry, instead of losing it behind the cursor."""
    snap["deferred"] = [c for c in snap.get("deferred", []) if c["uid"] != ch["uid"]] + [ch]


def _undefer(snap: dict, uid: str) -> None:
    """A newer change for `uid` landed, so any older deferred one is stale."""
    if any(c["uid"] == uid for c in snap.get("deferred", [])):
        snap["deferred"] = [c for c in snap["deferred"] if c["uid"] != uid]


def _retry_deferred(root, snap: dict, local: Local, rejected_fields) -> None:
    pending = snap.get("deferred", [])
    if not pending:
        return
    now = scan(root, ())
    snap["deferred"] = []
    left = []
    for ch in pending:
        if not _apply_change(root, ch, snap, local, now, rejected_fields, False):
            left.append(ch)
    snap["deferred"] = left + [c for c in snap["deferred"] if c["uid"] not in {x["uid"] for x in left}]


def _apply_change(root, ch, snap, before: Local, now: Local, rejected_fields, adopt, messages=None) -> bool:
    """Write one pulled change locally, holding its item and starting from the
    item as it is now. False when it can't be written yet. A doc change waits
    in the snapshot for `_pull_docs`, which fetches its bytes."""
    if ch["entity"] == "doc":
        snap.setdefault("docs", {})[ch["uid"]] = ch
        return True
    if ch["item_uid"] in before.busy:
        return False                # its local edits aren't diffed yet; the next round has both
    with _hold(root, ch["item_uid"], wait=False) as free:
        if not free:
            return False
        _reload(root, now, ch["item_uid"])
        return _write_change(root, ch, snap, before, now, rejected_fields, adopt, messages)


def _write_change(root, ch, snap, before: Local, now: Local, rejected_fields, adopt, messages) -> bool:
    entity, uid, item_uid = ch["entity"], ch["uid"], ch["item_uid"]
    ents = snap["entities"]
    if entity == "history":
        if not ch.get("deleted") and ch.get("data"):
            return _write_history(root, now, ch["data"])
        return True
    if ch.get("deleted") or not ch.get("data"):
        if entity != "item" and ((item_uid not in now.item_dirs and item_uid in ents)
                                  or item_uid in now.incomplete):
            return False            # its item is unreadable or only partly read: delete once it's fixed
        try:
            _delete_local(now, entity, uid, item_uid)
        except Exception:  # noqa: BLE001 — a malformed child file: delete once it's fixed
            return False
        ents.pop(uid, None)
        _undefer(snap, uid)
        removed = snap.setdefault("removed", [])
        if uid not in removed:
            removed.append(uid)
        return True
    row = ch["data"]
    flat = server_flat(entity, row)
    versions = dict(row.get("versions") or {})
    try:
        cur = _fresh(now, entity, uid)
    except Exception:  # noqa: BLE001 — an unreadable item file: retry once it's fixed
        return False
    old = ents.get(uid)
    if item_uid in before.scanned:
        read = before.entities.get(uid, {}).get("data")
    else:
        read = (old or {}).get("data")     # not diffed this round: anything unpushed differs from the snapshot
    keep = set()
    if read is not None and cur is not None:
        for k in set(SETTABLE[entity]) | {k for k in list(cur) + list(read) if "." in k}:
            if (uid, k) in rejected_fields:
                continue
            if ("held", uid, k) in rejected_fields or not _same(cur.get(k), read.get(k)):
                keep.add(k)
    write = dict(flat)
    for k in keep:
        if k in cur:
            write[k] = cur[k]
        else:
            write.pop(k, None)
    snap_data, snap_versions = dict(flat), dict(versions)
    for k in keep:
        if old is not None:
            if k in old["data"]:
                snap_data[k] = old["data"][k]
            else:
                snap_data.pop(k, None)
            if k in old.get("versions", {}):
                snap_versions[k] = old["versions"][k]
    try:
        written = _write_entity(root, now, entity, uid, item_uid, write, row)
    except Exception:  # noqa: BLE001 — a malformed local file: retry once it's fixed
        return False
    if not written:
        return False
    if adopt and cur is not None and messages is not None:
        replaced = [k for k in SETTABLE.get(entity, []) if k in cur and not _same(cur.get(k), flat.get(k))]
        if replaced:
            messages.append(f"{entity} {uid}: took the server's {', '.join(replaced)} over the local copy")
    ents[uid] = {"entity": entity, "item_uid": item_uid, "data": snap_data, "versions": snap_versions}
    _undefer(snap, uid)
    if entity == "item":
        now.entities[uid] = {"entity": "item", "item_uid": uid, "data": dict(write)}
    return True


def _fresh(now: Local, entity: str, uid: str):
    """The entity's local values right now. An item is re-read from its file,
    so an edit landing mid-pull is still seen."""
    if entity == "item":
        d = now.item_dirs.get(uid)
        if d is not None and (d / store.ITEM_FILE).is_file():
            meta = yamlio.read(d / store.ITEM_FILE)
            return _item_flat(d, meta if isinstance(meta, dict) else {})
        return None
    return now.entities.get(uid, {}).get("data")


def _write_entity(root, now: Local, entity, uid, item_uid, flat, row) -> bool:
    if entity == "item":
        return _write_item(root, now, uid, flat, row)
    item_dir = now.item_dirs.get(item_uid)
    if item_dir is None or not item_dir.exists():
        return False
    if entity == "task":
        before = store._read_tasks(item_dir)
        others = [dict(t) for t in before if t.get("uid") != uid]
        mine = {"id": flat["n"], "uid": uid, "title": flat["title"], "status": flat["status"],
                "phase": flat["phase"], "position": flat.get("position") or 0}
        positions: dict = {}
        for t in others:
            p = positions.get(t["phase"], 0)
            t["position"] = p
            positions[t["phase"]] = p + 1
        tasks = others + [mine]
        tasks.sort(key=lambda t: (t["phase"] is None, t["phase"] or 0, t["position"],
                                  t is not mine, t["id"]))
        store._write_tasks(item_dir, before, [{k: v for k, v in t.items() if k != "position"}
                                              for t in tasks])
        return True
    if entity in ("note", "log"):
        sub = store.NOTES_DIR if entity == "note" else store.LOG_DIR
        meta = {"uid": uid}
        if entity == "note":
            meta["kind"] = flat.get("kind") or "context"
        meta["author"] = row.get("author")
        meta["via"] = row.get("via")
        for k, v in flat.items():
            if k.startswith("meta.") and v is not None:
                meta[k[5:]] = v
        d = item_dir / sub
        d.mkdir(exist_ok=True)
        target = d / f"{store.ts_to_name(flat['ts'])}-{flat['n']}.md"
        old = now.files.get(uid)
        yamlio.write_atomic(target, frontmatter.join(meta, (flat.get("text") or "") + "\n"))
        if old and old != target and old.exists():
            old.unlink()
        now.files[uid] = target
        return True
    if entity == "check":
        checks = [c for c in store._read_checks(item_dir) if c.get("uid") != uid]
        checks.append({"id": flat["n"], "uid": uid, "kind": flat["kind"], "title": flat["title"],
                       "payload": flat.get("payload"), "timing": flat["timing"],
                       "status": flat["status"], "envs": store.env_list(flat.get("envs"))})
        checks.sort(key=lambda c: c["id"])
        _write_checks(item_dir, checks)
        return True
    return False


def _write_item(root, now: Local, uid, flat, row) -> bool:
    from ruamel.yaml.comments import CommentedMap

    d = now.item_dirs.get(uid)
    want_id = flat["id"]
    if d is None or not d.exists():
        folder = store.folder_for(flat["status"], archived=bool(flat.get("extra.archived")))
        d = root / folder / want_id
        if d.exists():
            return False
        d.mkdir(parents=True)
        y, meta = yamlio.yaml(), CommentedMap()
        for k in ("id", "uid", "title", "type", "status", "priority", "super-phase", "created",
                  "completed"):
            meta[k] = None
    else:
        if d.name != want_id:
            dest = d.parent / want_id
            if dest.exists():
                return False
            os.rename(d, dest)
            d = dest
        y, meta = store._load_meta(d)
    meta["id"] = want_id
    meta["uid"] = uid
    for k in ("title", "type", "status", "priority", "created"):
        meta[k] = flat.get(k)
    meta["super-phase"] = flat.get("super_phase")
    meta["completed"] = row.get("completed")
    if row.get("calc_status"):
        meta["calc-status"] = row["calc_status"]
    else:
        meta.pop("calc-status", None)
    for k in store.PEOPLE:
        meta[k] = flat.get(k)
    extras = {k[6:]: v for k, v in flat.items() if k.startswith("extra.")}
    for k in [k for k in meta if k not in ITEM_KEYS and k not in extras and meta[k] is not None]:
        del meta[k]
    for k, v in extras.items():
        if not _same(_plain(meta.get(k)), v):
            meta[k] = v
    yamlio.save(y, d / store.ITEM_FILE, meta)
    moved = store._place(d, flat["status"], bool(extras.get("archived")))
    if moved != d:
        for k, f in list(now.files.items()):
            if d in f.parents:
                now.files[k] = moved / f.relative_to(d)
    now.item_dirs[uid] = moved
    return True


def _write_history(root, now: Local, row) -> bool:
    d = now.item_dirs.get(row["item_uid"])
    if d is None or not d.exists():
        return False
    hd = d / store.HISTORY_DIR
    hd.mkdir(exist_ok=True)
    entry = {"uid": row["uid"], "from": row.get("from_status"), "to": row.get("to_status"),
             "by": row.get("by"), "via": row.get("via"), "server": True}
    if row.get("forced"):
        entry["forced"] = True
    target = hd / f"{store.ts_to_name(row['ts'])}-{row['n']}.yaml"
    yamlio.write_atomic(target, frontmatter.dump_map(entry))
    old = now.files.get(row["uid"])
    if old and old != target and old.exists():
        old.unlink()
    now.files[row["uid"]] = target
    return True


def _delete_local(now: Local, entity, uid, item_uid) -> None:
    item_dir = now.item_dirs.get(item_uid)
    if entity in ("note", "log"):
        f = now.files.pop(uid, None)
        if f and f.exists():
            f.unlink()
    elif entity == "task" and item_dir:
        before = store._read_tasks(item_dir)
        store._write_tasks(item_dir, before, [t for t in before if t.get("uid") != uid])
    elif entity == "check" and item_dir:
        _write_checks(item_dir, [c for c in store._read_checks(item_dir) if c.get("uid") != uid])
    now.entities.pop(uid, None)


# ── docs ──────────────────────────────────────────────────────────────────────
# A doc syncs as its own record beside the ops, after the pull: the round
# first writes the doc changes the feed brought (they wait in the snapshot's
# `docs` until their bytes are fetched), then uploads each changed doc and
# records it with `base`, the sha256 the server last confirmed; a base that
# isn't the server's current sha256 is a conflict. A doc failure is reported
# and never stops the round.
NO_DOCS = {404, 405}               # a server or project without docs
QUICK_DOC_BYTES = 256 * 1024       # the largest doc the round before a command moves
DOC_WAIT_SECONDS = 24 * 3600      # how long a doc change waits for its item, or for a write that keeps failing
LARGE_DOCS_FILE = "large-docs"     # present while docs over QUICK_DOC_BYTES wait for a round without a limit
_clock = time.time
DOCS_BACKFILLED = "docs_backfilled"


class _NoDocs(Exception):
    """The server has no docs: the round leaves them alone."""


class _DocsDown(Exception):
    """The server or the network failed a doc: no more doc transfers this round."""


def doc_notice(report: Report) -> str:
    return "sync: docs not synced — " + "; ".join(report.doc_failures)


def _trouble(e: RemoteError, name: str, report: Report) -> None:
    """Sort a doc's server error: none, a stop, or a failure of that doc alone."""
    if e.status in NO_DOCS:
        raise _NoDocs() from None
    if e.status is None or e.status >= 500:
        raise _DocsDown(f"{name} ({e})") from None
    report.doc_failures.append(f"{name} ({e})")


def _from_row(row: dict) -> dict:
    return {"uid": row["uid"], "sha256": row["sha256"], "size": row["size"], "by": row.get("by"),
            "via": row.get("via"), "at": row.get("at"), "base": row["sha256"]}


def _queue_doc(snap: dict, item_uid: str, row: dict, keep: bool = False) -> None:
    waiting = snap.setdefault("docs", {})
    if keep and row["uid"] in waiting:
        return
    waiting[row["uid"]] = {"entity": "doc", "uid": row["uid"], "item_uid": item_uid, "deleted": False, "data": row}


def _doc_rows(remote, project, item: str | None = None):
    after = None
    while True:
        page = remote.doc_list(project, item=item, after=after)
        yield from page.get("docs") or []
        after = page.get("next")
        if not after:
            return


def sync_docs(root: Path, remote, project, local: Local, snap: dict, report: Report, limit: int | None) -> None:
    """The round's doc transfers. Docs over `limit` bytes wait for a round without one."""
    if limit is None:
        (sync_dir(root) / LARGE_DOCS_FILE).unlink(missing_ok=True)
    try:
        try:
            if not snap.get(DOCS_BACKFILLED):
                # Doc changes a CLI passed before it asked for them never come again.
                for row in _doc_rows(remote, project):
                    _queue_doc(snap, row["item_uid"], row, keep=True)
                snap[DOCS_BACKFILLED] = True
            _rebuild_sidecars(root, remote, project, local, snap, report)
        except RemoteError as e:
            _trouble(e, "doc list", report)
            return
        _pull_docs(root, remote, project, snap, report, limit)
        _push_docs(root, remote, project, local, snap, report, limit)
        _pull_docs(root, remote, project, snap, report, limit)     # what push conflicts queued
    except _NoDocs:
        pass
    except _DocsDown as e:
        report.doc_failures.append(str(e))
        if limit is None:
            _large_waiting(root)


def _large_waiting(root: Path) -> None:
    """Have the next round without a size limit run, even if nothing was marked."""
    sync_dir(root).mkdir(exist_ok=True)
    (sync_dir(root) / LARGE_DOCS_FILE).touch()


def _doc_items(root: Path, local: Local):
    """(item uid, dir) for each item with a docs/ directory that no command holds."""
    for item_uid in list(local.item_dirs):
        if item_uid in local.busy or item_uid in local.incomplete:
            continue
        _follow(root, local, item_uid)
        d = local.item_dirs.get(item_uid)
        if d is not None and (d / docs.DOCS_DIR).is_dir():
            yield item_uid, d


def _rebuild_sidecars(root: Path, remote, project, local: Local, snap: dict, report: Report) -> None:
    """Rebuild the bases of an item whose sidecar couldn't be read, from the
    server's records: the same hash is unchanged, another hash an edit on top
    of the server's version, a doc the server doesn't know a new one. A doc
    the server deleted goes, unless it was edited here since: that edit is
    kept as its conflict copy."""
    for item_uid, d in _doc_items(root, local):
        with _hold(root, item_uid, wait=False) as free:
            if not free:
                continue
            meta = docs.read_meta(d)
            if not docs.needs_rebuild(d):
                continue
            rows = {docs.name_key(r["name"]): r for r in _doc_rows(remote, project, item_uid)} \
                if item_uid in snap["entities"] else {}
            deleted = {ch["uid"]: ch.get("last_sha256") for ch in (snap.get("docs") or {}).values()
                       if ch["item_uid"] == item_uid and (ch.get("deleted") or not ch.get("data"))}
            for name, path in list(docs.files(d).items()):
                sha, size = docs.sha256_file(path), path.stat().st_size
                uid = docs.doc_uid(item_uid, name)
                if uid in deleted and deleted[uid] != sha:
                    # Deleted there, edited here: the edit stays, as a doc of its own.
                    _keep_as_conflict(root, d, item_uid, name, meta, report)
                    continue
                e = meta.get(name) if (meta.get(name) or {}).get("sha256") == sha else None
                e = e or docs.entry(item_uid, name, sha, size, _now())
                row = rows.get(docs.name_key(name))
                if row and row["sha256"] == sha:
                    e = _from_row(row)
                elif row:
                    e["base"] = None            # never taken for an edit on theirs: both copies stay
                elif uid in deleted:
                    e["base"] = sha             # unchanged since: the server's delete applies
                else:
                    e["base"] = None
                meta[name] = e
            docs.write_meta(d, meta)
            docs.rebuilt(d)


def _keep_as_conflict(root: Path, d: Path, item_uid: str, name: str, meta: dict, report: Report,
                      why: str = "changed on the server too") -> str:
    """Move the local `name` aside as its conflict copy, a new doc of its own."""
    path = d / docs.DOCS_DIR / name
    copy = docs.conflict_name(d, name, identity.user())
    sha, size = docs.sha256_file(path), path.stat().st_size
    os.rename(path, d / docs.DOCS_DIR / copy)
    e = meta.pop(name, None) or {}
    mine = docs.entry(item_uid, copy, sha, size, _now())
    if e.get("by") and e.get("sha256") == sha:
        mine.update(by=e["by"], via=e.get("via"), at=e.get("at"))
    meta[copy] = mine
    text = f"doc {name} {why}; yours is kept as {copy}"
    report.messages.append(f"{d.name}: {text}")
    docs.write_meta(d, meta)
    _sync_log(root, d.name, text)
    return copy


def _push_docs(root: Path, remote, project, local: Local, snap: dict, report: Report, limit) -> None:
    """Upload and record every doc whose content isn't what the server last
    confirmed, and remove the ones deleted here, for items the server has."""
    for item_uid, d in _doc_items(root, local):
        if item_uid not in snap["entities"]:
            continue
        with _hold(root, item_uid, wait=False) as free:
            if free and (d / docs.DOCS_DIR).is_dir():
                _push_item_docs(root, remote, project, d, item_uid, snap, report, limit)


def _push_item_docs(root, remote, project, d: Path, item_uid: str, snap: dict, report: Report, limit) -> None:
    meta = docs.read_meta(d)
    read = _same_meta(meta)
    present, odd = docs.scan(d)
    for name, why in odd.items():
        report.doc_failures.append(f"{d.name}/{name} skipped: {why}")
    for name in [n for n in meta if n not in present and meta[n].get("base")]:
        moved = docs.find(present, name)
        if moved and moved not in meta:
            # Renamed here to another spelling of the same doc: the recorded spelling stays.
            os.rename(present.pop(moved), d / docs.DOCS_DIR / name)
            present[name] = d / docs.DOCS_DIR / name
    queue = sorted(set(meta) | set(present))
    recreated = set()
    try:
        while queue:
            name = queue.pop(0)
            try:
                again = _push_doc(root, remote, project, d, item_uid, name, meta, snap, report,
                                  name in recreated, limit)
            except RemoteError as e:
                _trouble(e, name, report)
                continue
            except OSError as e:
                report.doc_failures.append(f"{name} ({e.strerror or e})")
                continue
            if again:
                recreated.add(again)
                queue.insert(0, again)
    finally:
        if _same_meta(meta) != read:
            docs.write_meta(d, meta)


def _same_meta(meta) -> str:
    return json.dumps(meta, sort_keys=True, default=str)


def _push_doc(root, remote, project, d: Path, item_uid: str, name: str, meta: dict, snap: dict,
              report: Report, recreating: bool, limit):
    """Sync one doc; returns a name to push next (its conflict copy, or itself
    once more as a new doc), or None."""
    if docs.name_error(name):
        return None
    path = d / docs.DOCS_DIR / name
    e = meta.get(name) or {}
    uid = docs.doc_uid(item_uid, name)
    if not path.is_file() or path.is_symlink():
        if e.get("base"):
            r = remote.doc_remove(project, uid, e["base"])
            if r.get("status") == "conflict" and r.get("doc"):
                _queue_doc(snap, item_uid, r["doc"])        # changed there since: theirs comes back
        meta.pop(name, None)
        return None
    sha = docs.sha256_file(path)
    if sha == e.get("base"):
        return None
    size = path.stat().st_size
    if size > docs.MAX_BYTES:
        report.doc_failures.append(f"{name} is over {docs.human_size(docs.MAX_BYTES)}")
        return None
    if limit is not None and size > limit:
        _large_waiting(root)
        return None
    if e.get("sha256") != sha or not e.get("by"):
        e = meta[name] = docs.entry(item_uid, name, sha, size, _now(), e.get("base"))
    e["uid"] = uid
    data = path.read_bytes()
    if docs.sha256_bytes(data) != sha:
        return None                 # still being written; the next round has it
    try:
        key = remote.doc_upload(project, item_uid, name, data)
        r = remote.doc_record(project, {"item_uid": item_uid, "name": name, "sha256": sha, "size": size,
                                        "file_key": key, "base": e.get("base"), "via": e.get("via")})
    except RemoteError as err:
        if err.status != 409:
            raise
        # Another spelling of a doc the item has: this one syncs as its own copy.
        return _keep_as_conflict(root, d, item_uid, name, meta, report, "is another spelling of a doc already there")
    row = r.get("doc")
    if r.get("status") == "applied" and row:
        meta[name] = _from_row(row)
        return None
    if row is None:
        # Deleted there while edited here: the edit wins, as a new doc.
        e["base"] = None
        return None if recreating else name
    copy = _keep_as_conflict(root, d, item_uid, name, meta, report)
    _queue_doc(snap, item_uid, row)
    return copy


def _pull_docs(root: Path, remote, project, snap: dict, report: Report, limit) -> None:
    """Write the doc changes waiting in the snapshot, fetching their bytes. A
    change that keeps waiting (its item isn't here, or writing it fails) is
    dropped after DOC_WAIT_SECONDS, and the next round's backfill brings it back."""
    waiting = snap.get("docs") or {}
    if not waiting:
        return
    now = scan(root, ())
    for uid, ch in list(waiting.items()):
        row = None if ch.get("deleted") else ch.get("data")
        name = (row or {}).get("name") or uid
        if limit is not None and row and (row.get("size") or 0) > limit:
            _large_waiting(root)
            continue
        try:
            done = _apply_doc(root, remote, project, now, ch, report)
        except RemoteError as e:
            if e.status == 404:
                done = True         # gone since; its removal is in the feed
            else:
                _trouble(e, name, report)
                done = "failed"
        except OSError as e:
            report.doc_failures.append(f"{name} ({e.strerror or e})")
            done = "failed"
        if done is True:
            waiting.pop(uid, None)
        elif done in ("wait", "failed"):
            since = ch.setdefault("since", _clock())
            if _clock() - since > DOC_WAIT_SECONDS:
                waiting.pop(uid, None)
                snap.pop(DOCS_BACKFILLED, None)      # the next round lists the docs again, recovering it
                why = "its item isn't in this store" if done == "wait" else "it couldn't be written here"
                report.messages.append(f"doc {name} dropped after a day waiting: {why}")


def _apply_doc(root: Path, remote, project, now: Local, ch: dict, report: Report, held: bool = False):
    """True when written (or nothing to do), "wait" while its item isn't
    here, False to retry next round."""
    item_uid = ch["item_uid"]
    row = None if ch.get("deleted") else ch.get("data")
    if item_uid not in now.item_dirs:
        return True if row is None else "wait"
    with contextlib.nullcontext(True) if held else _hold(root, item_uid, wait=False) as free:
        if not free:
            return False
        _follow(root, now, item_uid)
        d = now.item_dirs[item_uid]
        meta = docs.read_meta(d)
        if docs.needs_rebuild(d):
            return False            # its bases come back first
        read = _same_meta(meta)
        try:
            return _write_doc(root, remote, project, d, item_uid, ch["uid"], row, meta, report)
        finally:
            if _same_meta(meta) != read:
                docs.write_meta(d, meta)


def _write_doc(root, remote, project, d: Path, item_uid: str, uid: str, row, meta: dict, report: Report) -> bool:
    present = docs.files(d)
    if row is None:
        name = next((n for n in sorted(set(meta) | set(present)) if docs.doc_uid(item_uid, n) == uid), None)
        if name is None:
            return True
        path = d / docs.DOCS_DIR / name
        e = meta.get(name) or {}
        if name in present and docs.sha256_file(path) != e.get("base"):
            if e:
                e["base"] = None    # edited here since: kept, and pushed again as new
            return True
        if name in present:
            path.unlink()
        meta.pop(name, None)
        return True
    name = row["name"]
    bad = docs.name_error(name)
    if bad:
        report.doc_failures.append(f"{name} skipped: {bad}")
        return True
    here = docs.find(present, name)
    e = meta.get(docs.find(meta, here or name) or "") or {}
    local = docs.sha256_file(present[here]) if here else None
    if row["sha256"] == e.get("base"):
        if local == row["sha256"] and here == name:
            meta[name] = _from_row(row)
        return True                 # what this store last confirmed: any edit or delete here gets pushed
    if local == row["sha256"]:
        if here != name:
            os.rename(present[here], d / docs.DOCS_DIR / name)
            meta.pop(here, None)
        meta[name] = _from_row(row)
        return True
    if local is not None and local != e.get("base"):
        _keep_as_conflict(root, d, item_uid, here, meta, report)
    elif here and here != name:
        os.unlink(present[here])
        meta.pop(here, None)
    data = remote.doc_bytes(project, uid)
    if docs.sha256_bytes(data) != row["sha256"]:
        return False                # replaced again since; a later change brings it
    docs.write_bytes(d, name, data)
    meta[name] = _from_row(row)
    return True


def fetch_item_docs(root: Path, item_uid: str | None) -> None:
    """Write one item's waiting doc changes now, whatever their size, for a
    command about to show its docs. Skipped while a round is running."""
    from .remote import remote_for

    if not item_uid or offline() or not enabled(root):
        return
    snap = load_snapshot(root)
    if not any(ch["item_uid"] == item_uid for ch in (snap.get("docs") or {}).values()):
        return
    rem = remote_for(root, timeout=30)
    if rem is None:
        return
    with _lock_file(root, ROUND_LOCK_FILE) as runner:
        if fcntl is not None:
            try:
                fcntl.flock(runner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
        snap = load_snapshot(root)
        project = (sync_config(root) or {}).get("project")
        report, now = Report(), scan(root, ())
        for uid, ch in [(u, c) for u, c in snap["docs"].items() if c["item_uid"] == item_uid]:
            row = None if ch.get("deleted") else ch.get("data")
            try:
                done = _apply_doc(root, rem, project, now, ch, report, held=True)
            except (RemoteError, OSError) as e:
                report.doc_failures.append(f"{(row or {}).get('name') or uid} ({e})")
                continue
            if done is True:
                snap["docs"].pop(uid, None)
        save_snapshot(root, snap)
    _print_report(report)


# ── CLI glue ──────────────────────────────────────────────────────────────────
def offline() -> bool:
    return os.environ.get("TODO_OFFLINE", "").strip() not in ("", "0")


def quiet_round(root: Path, *, push_only: bool = False) -> Report | None:
    """The automatic round around a command: short timeout, one dim line on
    failure, renames and rejections reported on stderr."""
    from .remote import remote_for

    if offline():
        return None
    remote = remote_for(root)
    if remote is None:
        return None
    try:
        # Before a command, only small docs move, so the command isn't kept waiting.
        report = run_round(root, remote, push_only=push_only, doc_limit=None if push_only else QUICK_DOC_BYTES)
    except Exception as e:  # noqa: BLE001 — a sync bug must not block the command
        print(f"sync: error, changes stay local ({type(e).__name__}: {e})", file=sys.stderr)
        return None
    _print_report(report)
    return report


def _print_report(report: Report) -> None:
    dim = sys.stderr.isatty()
    for m in report.messages:
        print(f"sync: {m}", file=sys.stderr)
    if report.doc_failures:
        print(doc_notice(report), file=sys.stderr)
    if report.error:
        if " 401 " in report.error:
            msg = f"sync: not logged in — run `todo login <url> <token>` ({report.error})"
        else:
            msg = f"sync: offline — changes stay local ({report.error})"
        print(f"\033[2m{msg}\033[0m" if dim else msg, file=sys.stderr)


def pending(root: Path) -> list:
    """The ops the next round would push."""
    return diff(scan(root), load_snapshot(root))
