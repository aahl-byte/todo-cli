"""Sync a `.TODO/` store with a team server.

A round diffs the local files against `.sync/snapshot.json` (what the server
last said, with a version per field), pushes the differences as ops, then pulls
every change after the saved cursor and writes it back into the files. Because
the diff compares files rather than commands, edits from the web drawer or by
hand sync too. See docs/plans/2026-10-02-team-store-implementation.md §2.5.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import frontmatter, store, ulid, yamlio
from .remote import Remote, RemoteError, sync_config, sync_dir
from .util import to_str

SNAPSHOT_FILE = "snapshot.json"
OUTBOX_FILE = "outbox.json"
LOCK_FILE = "lock"
BATCH = 200

ITEM_KEYS = {"id", "uid", "title", "type", "status", "priority", "super-phase", "created",
             "completed", "calc-status", "creator", "developer", "qa_assignee"}
SETTABLE = {
    "item": ["title", "type", "status", "priority", "super_phase", "creator", "developer",
             "qa_assignee"],
    "task": ["title", "status", "phase", "position"],
    "note": ["kind", "text"],
    "log": ["text"],
    "check": ["kind", "title", "payload", "timing", "status"],
}
JSON_FIELD = {"item": "extra", "note": "meta"}
CREATE_ONLY = {"item": ["id", "created"], "task": ["n"], "note": ["n", "ts"],
               "log": ["n", "ts"], "check": ["n"]}
CHILDREN = ["task", "note", "log", "check"]


def enabled(root: Path) -> bool:
    return sync_config(root) is not None


@contextlib.contextmanager
def locked(root: Path):
    """Hold the store's sync lock for the duration — every command in a synced
    store runs under it, so commands and rounds never interleave."""
    try:
        import fcntl
    except ImportError:          # Windows: no flock; commands may interleave
        yield
        return
    d = sync_dir(root)
    d.mkdir(exist_ok=True)
    with open(d / LOCK_FILE, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


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
                return data
        except ValueError:
            pass
    return {"cursor": 0, "entities": {}, "deferred": [], "stuck": {}}


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
def _hash_uid(*parts) -> str:
    """A deterministic 26-char uid, so two clones of one committed store backfill
    the same uid for the same entity."""
    digest = hashlib.sha1("\x1f".join(str(p) for p in parts).encode()).digest()
    return "Z" + base64.b32encode(digest).decode()[:25]


def _plain(value):
    """A JSON-safe copy of a YAML value."""
    return json.loads(json.dumps(value, default=str))


def ensure_uids(root: Path, project: str) -> None:
    """Give every entity a uid and write it into its file. Never recomputes one
    that exists."""
    for d in store._item_dirs(root):
        try:
            y, meta = store._load_meta(d)
        except Exception:  # noqa: BLE001 — unreadable item file: scan skips it too
            continue
        if not isinstance(meta, dict):
            continue
        uid = to_str(meta.get("uid"))
        if not uid:
            uid = _hash_uid(project, d.name, to_str(meta.get("created")))
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
        for e in store._read_entries(d / sub):
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
    return flat


def scan(root: Path) -> Local:
    local = Local()
    for d in store._item_dirs(root):
        try:
            meta = yamlio.read(d / store.ITEM_FILE)
            meta = meta if isinstance(meta, dict) else {}
            uid = to_str(meta.get("uid"))
        except Exception:  # noqa: BLE001 — unreadable item: leave it out
            continue
        if not uid:
            continue
        local.item_dirs[uid] = d
        try:
            local.entities[uid] = {"entity": "item", "item_uid": uid, "data": _item_flat(d, meta)}
        except Exception:  # noqa: BLE001 — e.g. a non-numeric super-phase: sync nothing of it
            local.incomplete.add(uid)
            continue
        try:
            positions: dict = {}
            for t in store._read_tasks(d):
                pos = positions.get(t["phase"], 0)
                positions[t["phase"]] = pos + 1
                if t.get("uid"):
                    local.entities[t["uid"]] = {"entity": "task", "item_uid": uid, "data": {
                        "n": t["id"], "title": t["title"], "status": t["status"],
                        "phase": t["phase"], "position": pos}}
            for e in store._read_entries(d / store.NOTES_DIR):
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
            for e in store._read_entries(d / store.LOG_DIR):
                if e["meta"].get("uid"):
                    local.entities[e["meta"]["uid"]] = {"entity": "log", "item_uid": uid, "data": {
                        "n": e["id"], "ts": e["ts"], "text": e["text"]}}
                    local.files[e["meta"]["uid"]] = e["file"]
                    if e["meta"].get("via"):
                        local.via[e["meta"]["uid"]] = e["meta"]["via"]
            for c in store._read_checks(d):
                if c.get("uid"):
                    local.entities[c["uid"]] = {"entity": "check", "item_uid": uid, "data": {
                        "n": c["id"], "kind": c["kind"], "title": c["title"],
                        "payload": c["payload"], "timing": c["timing"], "status": c["status"]}}
            for e in store._read_entries(d / store.HISTORY_DIR):
                if e["meta"].get("uid"):
                    local.files[e["meta"]["uid"]] = e["file"]
                if not e["meta"].get("server"):
                    local.history.setdefault(uid, []).append(e)
        except Exception:  # noqa: BLE001 — partly read: never infer removes from it
            local.incomplete.add(uid)
    return local


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
        if e["item_uid"] in local.incomplete:
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
        if s["item_uid"] in local.incomplete or s["item_uid"] not in local.item_dirs:
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


def run_round(root: Path, remote: Remote, *, push_only: bool = False, adopt: bool = False) -> Report:
    """One push + pull. Caller holds the lock. A network failure stops the
    round where it is; nothing local is lost, the diff just runs again."""
    cfg = sync_config(root) or {}
    project = cfg.get("project")
    report = Report()
    ensure_uids(root, project)
    snap = load_snapshot(root)
    rejected_fields: set = set()
    pushed_status: set = set()
    try:
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
            _drop_provisional_history(local, pushed_status)
        local = scan(root)
        ops = diff(local, snap)
        save_snapshot(root, snap)
        _push(root, remote, project, ops, local, snap, report, rejected_fields, pushed_status)
        _drop_provisional_history(local, pushed_status)
        if not push_only:
            _pull(root, remote, project, snap, report, local, rejected_fields)
        _retry_deferred(root, snap, local, rejected_fields)
        save_snapshot(root, snap)
    except RemoteError as e:
        report.error = str(e)
    return report


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
    item_id = _item_id(local, op["item_uid"])
    text = f'{op["op"]} {op["entity"]} not applied ({why})'
    report.messages.append(f"{item_id}: {text}")
    if item_id:
        store.add_log(root, item_id, "sync: " + text, _now())


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
    ents = snap["entities"]
    by_id = {r.get("op_id"): r for r in results if isinstance(r, dict)}
    renames = []
    for op in ops:
        r = by_id.get(op["op_id"])
        if r is None:
            continue
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
            continue
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
    for op, new in renames:
        _rename(root, op, new, local, report)


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


def _drop_provisional_history(local: Local, pushed_status: set) -> None:
    """Server history replaces the provisional entries of every item whose
    status change was pushed (applied or rejected)."""
    for item_uid in pushed_status:
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
    else:
        text = f'{label}{x["field"]} → {value} not applied ({x.get("reason")})'
    report.messages.append(f"{item_id}: {text}")
    if item_id:
        store.add_log(root, item_id, "sync: " + text, _now())


# Refusals that will not change on a retry; the entity waits for a local edit.
FINAL = {"error", "bad-entity", "bad-op", "not-removable", "unknown", "agent-handoff", "request-frozen"}


def _reissue(local: Local, entity: str, old: str, item_uid: str) -> None:
    """Give one local entity a fresh uid, so it is created next round."""
    d = local.item_dirs.get(item_uid)
    if d is None:
        return
    try:
        _rewrite_uids(d, {old: ulid.new()}, entities={entity})
    except Exception:  # noqa: BLE001 — a malformed file: it keeps its uid until fixed
        pass


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
        for e in store._read_entries(d / sub):
            if e["meta"].get("uid") and new(e["meta"]["uid"]) != e["meta"]["uid"]:
                meta = dict(e["meta"], uid=new(e["meta"]["uid"]))
                yamlio.write_atomic(e["file"], frontmatter.join(meta, e["text"] + "\n"))
    if "check" in entities:
        checks = store._read_checks(d)
        changed = [dict(c, uid=new(c["uid"]) if c.get("uid") else c.get("uid")) for c in checks]
        if changed != checks:
            _write_checks(d, changed)


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
    if reason == "removed" and op["op"] == "create" and uid in snap.get("removed", []):
        # This store already saw that uid removed (it pushed or pulled the
        # removal), so the local entity is a re-added one with a backfilled uid
        # derived from the same content: a new entity, so it gets a new uid.
        _reissue(local, entity, uid, op["item_uid"])
        return
    if reason == "removed" and op["op"] == "create":
        snap["entities"].pop(uid, None)
        _delete_local(local, entity, uid, op["item_uid"])
        text = f"{what} not applied; {r.get('by') or 'someone'} removed it"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            store.add_log(root, item_id, "sync: " + text, _now())
        return
    if reason == "removed" and op["op"] == "set":
        snap["entities"].pop(uid, None)
        _delete_local(local, entity, uid, op["item_uid"])
        text = f"{what} not applied; {r.get('by') or 'someone'} removed it"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            store.add_log(root, item_id, "sync: " + text, _now())
        return
    if reason in FINAL or reason.startswith("invalid"):
        if op.get("_fp"):
            snap.setdefault("stuck", {})[uid] = op["_fp"]
        text = f"{what} not applied ({reason}{': ' + r['message'] if r.get('message') else ''})"
        if reason == "request-frozen":
            text += f"; post a new version with `todo request {item_id} \"…\"`"
        report.messages.append(f"{item_id}: {text}")
        if item_id:
            store.add_log(root, item_id, "sync: " + text, _now())
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
        store.add_log(root, item_id, "sync: " + text, _now())


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
def _pull(root, remote, project, snap, report, before: Local, rejected_fields, adopt=False):
    """Fetch every change after the cursor and write it locally. A field whose
    local value moved since the diff read it (a drawer or hand edit) keeps its
    local value and its old snapshot entry, unless the server rejected it."""
    now = scan(root)
    while True:
        page = remote.changes(project, snap["cursor"])
        if "deploy_step" in page:
            cfg = sync_config(root) or {}
            if cfg.get("deploy_step") != page["deploy_step"]:
                cfg["deploy_step"] = page["deploy_step"]
                from .remote import save_sync_config
                save_sync_config(root, cfg)
        for ch in page.get("changes") or []:
            if not _apply_change(root, ch, snap, before, now, rejected_fields, adopt, report.messages):
                _defer(snap, ch)
            report.pulled += 1
        _retry_deferred(root, snap, now, rejected_fields)
        snap["cursor"] = page.get("cursor", snap["cursor"])
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
    if entity == "note":
        flat = {k: row.get(k) for k in ("n", "ts", "kind", "text")}
        for k, v in (row.get("meta") or {}).items():
            flat[f"meta.{k}"] = v
        return flat
    if entity == "log":
        return {k: row.get(k) for k in ("n", "ts", "text")}
    if entity == "check":
        return {k: row.get(k) for k in ("n", "kind", "title", "payload", "timing", "status")}
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
    now = scan(root)
    snap["deferred"] = []
    left = []
    for ch in pending:
        if not _apply_change(root, ch, snap, local, now, rejected_fields, False):
            left.append(ch)
    snap["deferred"] = left + [c for c in snap["deferred"] if c["uid"] not in {x["uid"] for x in left}]


def _apply_change(root, ch, snap, before: Local, now: Local, rejected_fields, adopt, messages=None) -> bool:
    """Write one pulled change locally. False when it can't be written yet."""
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
    read = before.entities.get(uid, {}).get("data")
    old = ents.get(uid)
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
        if entity == "note":
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
                       "status": flat["status"]})
        checks.sort(key=lambda c: c["id"])
        _write_checks(item_dir, checks)
        return True
    return False


def _write_item(root, now: Local, uid, flat, row) -> bool:
    from ruamel.yaml.comments import CommentedMap

    d = now.item_dirs.get(uid)
    want_id = flat["id"]
    if d is None or not d.exists():
        folder = store.folder_for(flat["status"])
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
    moved = store._place(d, flat["status"])
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
        report = run_round(root, remote, push_only=push_only)
    except Exception as e:  # noqa: BLE001 — a sync bug must not block the command
        print(f"sync: error, changes stay local ({type(e).__name__}: {e})", file=sys.stderr)
        return None
    _print_report(report)
    return report


def _print_report(report: Report) -> None:
    dim = sys.stderr.isatty()
    for m in report.messages:
        print(f"sync: {m}", file=sys.stderr)
    if report.error:
        if " 401 " in report.error:
            msg = f"sync: not logged in — run `todo login <url> <token>` ({report.error})"
        else:
            msg = f"sync: offline — changes stay local ({report.error})"
        print(f"\033[2m{msg}\033[0m" if dim else msg, file=sys.stderr)


def pending(root: Path) -> list:
    """The ops the next round would push."""
    return diff(scan(root), load_snapshot(root))
