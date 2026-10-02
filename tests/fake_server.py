"""An in-memory stand-in for the team server's op semantics (server/lib/apply.ts),
enough to test the CLI's sync client: versions, stale rejections, number and id
reassignment, removes, groups and the changes feed. The real server is covered
by server/tests and the e2e test."""

import copy
import itertools

SETTABLE = {
    "item": ["title", "type", "status", "priority", "super_phase", "creator", "developer", "qa_assignee"],
    "task": ["title", "status", "phase", "position"],
    "note": ["kind", "text"],
    "log": ["text"],
    "check": ["kind", "title", "payload", "timing", "status"],
}
JSON = {"item": "extra", "note": "meta"}
COMPLETE = ("done", "deployed")
VALID_STATUSES = ("requested", "todo", "in-triage", "in-progress", "review", "ready-for-qa", "in-qa",
                  "ready-to-deploy", "deployed", "blocked", "deferred", "cancelled", "done")


class FakeServer:
    def __init__(self, project="p", deploy_step=True):
        self.project = project
        self.deploy_step = deploy_step
        self.rows = {}           # uid → row (with "_entity")
        self.tombs = {}          # uid → (seq, author)
        self.changes_log = []    # (seq, entity, uid, item_uid, deleted)
        self.seq = 0
        self.ts = itertools.count(1)
        self.applied = {}
        self.offline = False
        self.pushes = []

    # ── server side ──────────────────────────────────────────────────────────
    def _bump(self, entity, uid, item_uid, deleted=False, author=None):
        self.seq += 1
        self.changes_log.append((self.seq, entity, uid, item_uid, deleted, author,
                                 f"2026-10-02T10:{next(self.ts):02d}:00.000Z"))
        return self.seq

    def _who(self, seq):
        for s, *_rest, author, ts in self.changes_log:
            if s == seq:
                return author, ts
        return None, None

    def _get(self, row, field):
        col = JSON.get(row["_entity"])
        if col and field.startswith(col + "."):
            return (row.get(col) or {}).get(field[len(col) + 1:])
        return row.get(field)

    def _put(self, row, field, value):
        col = JSON.get(row["_entity"])
        if col and field.startswith(col + "."):
            key = field[len(col) + 1:]
            if value is None:
                row[col].pop(key, None)
            else:
                row[col][key] = value
        else:
            row[field] = value

    def apply(self, ops, author):
        results = {}
        units, groups = [], {}
        for op in ops:
            g = op.get("group")
            if not g:
                units.append([op])
            elif g in groups:
                groups[g].append(op)
            else:
                groups[g] = [op]
                units.append(groups[g])
        for unit in units:
            saved = copy.deepcopy((self.rows, self.tombs, self.changes_log, self.seq))
            out = []
            for op in unit:
                if op["op_id"] in self.applied:
                    out.append(dict(self.applied[op["op_id"]], duplicate=True))
                    continue
                out.append(getattr(self, "_" + op["op"])(op, author))
            if unit[0].get("group") and any(r["status"] == "rejected" or r.get("rejected") for r in out):
                self.rows, self.tombs, self.changes_log, self.seq = saved
                out = [{"op_id": r["op_id"], "status": "rejected", "reason": "group-rolled-back",
                        **({"rejected": r["rejected"]} if r.get("rejected") else {})} for r in out]
            else:
                for r in out:
                    self.applied[r["op_id"]] = r
            for r in out:
                results[r["op_id"]] = r
        return [results[op["op_id"]] for op in ops]

    def _create(self, op, author):
        e, uid, data = op["entity"], op["uid"], dict(op.get("data") or {})
        res = {"op_id": op["op_id"], "status": "applied"}
        if uid in self.rows:
            existing = self.rows[uid]
            same = all(existing.get(k) == v for k, v in data.items()
                       if k not in ("n", "id", "history", "meta", "extra"))
            if same:
                return dict(res, versions=existing["versions"])
            return {"op_id": op["op_id"], "status": "rejected", "reason": "uid-exists",
                    "data": {k: copy.deepcopy(v) for k, v in existing.items() if k != "_entity"}}
        history = data.pop("history", None)
        row = {"_entity": e, "uid": uid, **data}
        if e == "item":
            row["item_uid"] = uid
            want = data.get("id")
            new, n = want, 2
            while any(r["_entity"] == "item" and r["id"] == new for r in self.rows.values()):
                new, n = f"{want}-{n}", n + 1
            if new != want:
                res["assigned_id"] = new
            row["id"] = new
            row.setdefault("creator", author)
            row.setdefault("extra", {})
            row["completed"] = "2026-10-02T00:00:00.000Z" if data.get("status") in COMPLETE else None
            row["calc_status"] = None
        else:
            if op["item_uid"] not in self.rows:
                return {"op_id": op["op_id"], "status": "rejected", "reason": "no-item"}
            row["item_uid"] = op["item_uid"]
            peers = [r for r in self.rows.values() if r["_entity"] == e and r["item_uid"] == op["item_uid"]]
            if any(r["n"] == data.get("n") for r in peers):
                row["n"] = max(r["n"] for r in peers) + 1
                res["assigned_n"] = row["n"]
            if e in ("note", "log"):
                row["author"], row["via"] = author, op.get("via", "human")
            if e == "note":
                row.setdefault("meta", {})
        seq = self._bump(e, uid, row["item_uid"], author=author)
        versions = {f: seq for f in SETTABLE[e]}
        col = JSON.get(e)
        if col:
            versions.update({f"{col}.{k}": seq for k in row.get(col) or {}})
        row["versions"] = versions
        self.rows[uid] = row
        for h in history or []:
            hn = 1 + sum(1 for r in self.rows.values() if r["_entity"] == "history" and r["item_uid"] == uid)
            self.rows[h["uid"]] = {"_entity": "history", "uid": h["uid"], "item_uid": uid, "n": hn,
                                   "from_status": h.get("from"), "to_status": h["to"], "by": h.get("by"),
                                   "via": h.get("via"), "forced": bool(h.get("forced")), "ts": h["ts"]}
            self._bump("history", h["uid"], uid, author=author)
        if e == "task":
            self._recalc(row["item_uid"], author)
        return dict(res, versions=dict(versions))

    def _recalc(self, item_uid, author):
        """Like the real server: a task change bumps its item (calc_status)."""
        from todo.status import derive_calc_status
        item = self.rows.get(item_uid)
        if item is None:
            return
        calc = derive_calc_status([r["status"] for r in self.rows.values()
                                   if r["_entity"] == "task" and r["item_uid"] == item_uid])
        if calc != item.get("calc_status"):
            item["calc_status"] = calc
            self._bump("item", item_uid, item_uid, author=author)

    def _set(self, op, author):
        row = self.rows.get(op["uid"])
        if row is None:
            seq, by = self.tombs.get(op["uid"], (None, None))
            return {"op_id": op["op_id"], "status": "rejected", "reason": "removed" if seq else "unknown", "by": by}
        out, rejected, accepted = {}, [], []
        for f, v in op["data"].items():
            cur, ver = self._get(row, f), row["versions"].get(f)
            if f == "status" and row["_entity"] == "task" and v not in VALID_STATUSES:
                rejected.append({"field": f, "reason": "invalid", "server_value": cur, "version": ver})
                continue
            if cur == v:
                out[f] = ver or 0
            elif f != "position" and ver is not None and (op.get("base") or {}).get(f) != ver:
                by, at = self._who(ver)
                rejected.append({"field": f, "reason": "stale", "server_value": cur, "version": ver,
                                 "by": by, "at": at})
            else:
                accepted.append((f, v))
        if accepted:
            seq = self._bump(row["_entity"], row["uid"], row["item_uid"], author=author)
            for f, v in accepted:
                if f == "status" and row["_entity"] == "item":
                    self._history(row, row["status"], v, author, op)
                    row["completed"] = "2026-10-02T00:00:00.000Z" if v in COMPLETE else None
                self._put(row, f, v)
                row["versions"][f] = seq
                out[f] = seq
            if row["_entity"] == "task":
                self._recalc(row["item_uid"], author)
        status = "rejected" if rejected and not accepted and not out else "applied"
        res = {"op_id": op["op_id"], "status": status, "versions": out}
        if rejected:
            res["rejected"] = rejected
        return res

    def _history(self, item, frm, to, author, op):
        import uuid
        uid = "H" + uuid.uuid4().hex[:25].upper()
        n = 1 + sum(1 for r in self.rows.values() if r["_entity"] == "history" and r["item_uid"] == item["uid"])
        self.rows[uid] = {"_entity": "history", "uid": uid, "item_uid": item["uid"], "n": n,
                          "from_status": frm, "to_status": to, "by": author, "via": op.get("via"),
                          "forced": bool(op.get("force")), "ts": f"2026-10-02T11:{n:02d}:00.000Z"}
        self._bump("history", uid, item["uid"], author=author)

    def _remove(self, op, author):
        row = self.rows.get(op["uid"])
        if row is None:
            return {"op_id": op["op_id"], "status": "rejected", "reason": "removed"}
        stale = [f for f, v in row["versions"].items() if f != "position" and (op.get("base") or {}).get(f) != v]
        if stale:
            return {"op_id": op["op_id"], "status": "rejected", "reason": "stale",
                    "rejected": [{"field": f, "reason": "stale"} for f in stale]}
        seq = self._bump(row["_entity"], row["uid"], row["item_uid"], deleted=True, author=author)
        del self.rows[op["uid"]]
        self.tombs[op["uid"]] = (seq, author)
        return {"op_id": op["op_id"], "status": "applied", "versions": {}}

    # ── the Remote interface ─────────────────────────────────────────────────
    def client(self, author):
        server = self

        class Client:
            def push(self, project, ops):
                if server.offline:
                    from todo.remote import RemoteError
                    raise RemoteError("fake offline")
                server.pushes.append(copy.deepcopy(ops))
                return server.apply(copy.deepcopy(ops), author)

            def changes(self, project, since, limit=500):
                if server.offline:
                    from todo.remote import RemoteError
                    raise RemoteError("fake offline")
                rows = [c for c in server.changes_log if c[0] > since][:limit]
                latest = {}
                for seq, e, uid, item_uid, deleted, *_ in rows:
                    latest[uid] = (seq, e, uid, item_uid)       # first position, latest data
                out = []
                for seq, e, uid, item_uid in latest.values():
                    row = server.rows.get(uid)
                    data = None if row is None else {k: copy.deepcopy(v) for k, v in row.items() if k != "_entity"}
                    out.append({"seq": seq, "entity": e, "uid": uid, "item_uid": item_uid,
                                "deleted": row is None, "data": data})
                return {"changes": out, "cursor": rows[-1][0] if rows else since,
                        "more": len(rows) == limit, "deploy_step": server.deploy_step}

        return Client()
