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
                  "qa-approved", "ready-to-deploy", "deployed", "blocked", "deferred", "cancelled", "done")


class FakeServer:
    def __init__(self, project="p", deploy_step=True):
        self.project = project
        self.deploy_step = deploy_step
        self.actions = []
        self.rows = {}           # uid → row (with "_entity")
        self.tombs = {}          # uid → (seq, author)
        self.changes_log = []    # (seq, entity, uid, item_uid, deleted)
        self.seq = 0
        self.ts = itertools.count(1)
        self.applied = {}
        self.offline = False
        self.pushes = []
        self.checkouts = []
        self.blobs = {}          # file key → bytes
        self.uploads = []        # file keys, in upload order
        self.doc_lists = []      # (item, after) per doc list request
        self.doc_tombs = {}      # deleted doc uid → its last sha256
        self.git_facts = []
        self.git_facts_offline = False
        self.jira_tickets = {}          # key → the block a backfill appends to the request
        self.jira_backfilled = set()    # (item uid, key)
        self.plugin_config = {}  # repo → {config, track, shipped, instances, grants}; None answers 404, like an older server
        self.plugin_creds = []   # (repo, connection, secret) per credential posted
        self.cred_endpoints = []  # the endpoint each was posted for
        self.creds_moved = False  # True: the server's config points the connection elsewhere
        self.plugin_gets = 0
        self.plugin_tombs = set()
        self.host_secrets = []
        self.feed_by_plugin = True   # False: an older server, whose feed doesn't say who removed a note
        self.plugins_down = False
        self.creds_unkeyed = False   # no TODO_SECRET_KEY: credentials answer 503

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
        plugin_made = e in ("note", "log") and bool((data.get("meta") or {}).get("plugin"))
        if uid in self.tombs and not (plugin_made and uid in self.plugin_tombs):
            seq, by = self.tombs[uid]
            return {"op_id": op["op_id"], "status": "rejected", "reason": "removed", "by": by}
        self.tombs.pop(uid, None)
        self.plugin_tombs.discard(uid)
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
                                   "via": h.get("via"), "forced": bool(h.get("forced")), "ts": h["ts"],
                                   "field": h.get("field")}
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
            if f == "status" and row["_entity"] == "item" and v in ("ready-to-deploy", "deployed") \
                    and cur != v and not op.get("force") and self._waits(row["uid"]):
                seen = self._waits(row["uid"])
                rejected.append({"field": f, "reason": "waits-on", "server_value": cur, "version": ver,
                                 "edges": [f'{e.get("id")} ({e.get("branch")}) {e["state"]}' for e in seen.get("needs") or []
                                           if e["state"] in ("waiting", "stale", "unknown")],
                                 "facts_at": seen.get("at")})
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
                if f == "extra.class" and row["_entity"] == "item" and cur != v:
                    self._history(row, cur, v, author, op, field="class")
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

    def _waits(self, item_uid):
        """Like the server's guard: the item's latest posted git facts wait on something."""
        posted = [f["data"] for f in self.git_facts if f["item_uid"] == item_uid]
        return posted[-1] if posted and posted[-1].get("waits_on") else None

    def _history(self, item, frm, to, author, op, field=None):
        import uuid
        uid = "H" + uuid.uuid4().hex[:25].upper()
        n = 1 + sum(1 for r in self.rows.values() if r["_entity"] == "history" and r["item_uid"] == item["uid"])
        self.rows[uid] = {"_entity": "history", "uid": uid, "item_uid": item["uid"], "n": n,
                          "from_status": frm, "to_status": to, "by": author, "via": op.get("via"),
                          "forced": bool(op.get("force")) and not field, "ts": f"2026-10-02T11:{n:02d}:00.000Z",
                          "field": field}
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
        if op.get("plugin"):
            self.plugin_tombs.add(op["uid"])         # the runner's removal: the plugin may make it again
        return {"op_id": op["op_id"], "status": "applied", "versions": {}}

    # ── docs (server/lib/docs.ts) ────────────────────────────────────────────
    def _doc(self, item_uid, name):
        from todo import docs
        return next((r for r in self.rows.values() if r["_entity"] == "doc" and r["item_uid"] == item_uid
                     and docs.name_key(r["name"]) == docs.name_key(name)), None)

    def list_docs(self, item=None, after=None, limit=2):
        """A page of doc rows by uid; a small page, so tests page through."""
        self.doc_lists.append((item, after))
        rows = sorted((r for r in self.rows.values() if r["_entity"] == "doc"
                       and (item is None or r["item_uid"] == item) and (after is None or r["uid"] > after)),
                      key=lambda r: r["uid"])
        page = rows[:limit]
        return {"docs": [self._public(r) for r in page],
                "next": page[-1]["uid"] if len(rows) > limit else None}

    def _upload(self, data):
        key = f"{self.project}/docs/{len(self.blobs) + 1:026d}.bin"
        self.blobs[key] = data
        self.uploads.append(key)
        return key

    def _public(self, row):
        return None if row is None else {k: copy.deepcopy(v) for k, v in row.items() if k != "_entity"}

    def record_doc(self, rec, author):
        """A doc record: applied when `base` is the server's current sha256, else a conflict."""
        import hashlib
        from todo import docs
        if rec["item_uid"] not in self.rows:
            from todo.remote import RemoteError
            raise RemoteError("no such item", 422)
        data = self.blobs[rec["file_key"]]
        sha = hashlib.sha256(data).hexdigest()
        row = self._doc(rec["item_uid"], rec["name"])
        if row and row["name"] != rec["name"]:
            from todo.remote import RemoteError
            raise RemoteError(f'409 a doc named {row["name"]} already exists', 409)
        current = row["sha256"] if row else None
        if sha == current:
            return {"status": "applied", "doc": self._public(row)}
        if rec.get("base") != current:
            return {"status": "conflict", "doc": self._public(row)}
        uid = docs.doc_uid(rec["item_uid"], rec["name"])
        seq = self._bump("doc", uid, rec["item_uid"], author=author)
        self.doc_tombs.pop(uid, None)
        self.rows[uid] = {"_entity": "doc", "uid": uid, "item_uid": rec["item_uid"], "name": rec["name"],
                          "size": len(data), "sha256": sha, "file_key": rec["file_key"],
                          "content_type": "application/octet-stream", "by": author,
                          "via": rec.get("via") or "human", "at": f"2026-10-02T12:{seq % 60:02d}:00.000Z",
                          "plugin": rec.get("plugin"), "versions": {"sha256": seq}}
        return {"status": "applied", "doc": self._public(self.rows[uid])}

    def remove_doc(self, uid, base, author):
        row = self.rows.get(uid)
        if row is None or row["_entity"] != "doc":
            return {"status": "applied", "doc": None}
        if row["sha256"] != base:
            return {"status": "conflict", "doc": self._public(row)}
        self._bump("doc", uid, row["item_uid"], deleted=True, author=author)
        del self.rows[uid]
        self.doc_tombs[uid] = row["sha256"]
        return {"status": "applied", "doc": None}

    def dashboard_put(self, item_uid, name, data, author):
        """An upload or replace from the dashboard, which always knows the current version."""
        row = self._doc(item_uid, name)
        return self.record_doc({"item_uid": item_uid, "name": name, "file_key": self._upload(data),
                                "base": row["sha256"] if row else None}, author)

    def dashboard_delete(self, item_uid, name):
        row = self._doc(item_uid, name)
        return self.remove_doc(row["uid"], row["sha256"], "carol")

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

            def doc_upload(self, project, item_uid, name, data):
                if server.offline:
                    from todo.remote import RemoteError
                    raise RemoteError("fake offline")
                return server._upload(bytes(data))

            def doc_record(self, project, rec):
                return server.record_doc(copy.deepcopy(rec), author)

            def doc_list(self, project, item=None, after=None):
                if server.offline:
                    from todo.remote import RemoteError
                    raise RemoteError("fake offline")
                return server.list_docs(item, after)

            def doc_remove(self, project, uid, base):
                return server.remove_doc(uid, base, author)

            def doc_bytes(self, project, uid):
                row = server.rows.get(uid)
                if row is None:
                    from todo.remote import RemoteError
                    raise RemoteError("no such doc", 404)
                return server.blobs[row["file_key"]]

            def checkout(self, project, dir_, repo):
                server.checkouts.append((author, project, dir_, repo))
                return {"ok": True}

            def jira_backfill(self, project, item_uid):
                """Like the server: each linked ticket not yet backfilled appends its block to the open request."""
                it = server.rows.get(item_uid) or {}
                keys = [k for k in (it.get("extra") or {}).get("jira") or []
                        if k in server.jira_tickets and (item_uid, k) not in server.jira_backfilled]
                req = next(r for r in server.rows.values() if r["_entity"] == "note" and r["item_uid"] == item_uid
                           and r["kind"] == "ticket-request")
                for k in keys:
                    server.jira_backfilled.add((item_uid, k))
                    server._set({"op_id": f"jira:{item_uid}:{k}", "op": "set", "entity": "note", "uid": req["uid"],
                                 "item_uid": item_uid, "data": {"text": req["text"] + "\n\n" + server.jira_tickets[k]},
                                 "base": {"text": req["versions"].get("text")}}, "jira-bridge")
                return {"backfilled": keys}

            def git_facts(self, project, facts):
                if server.git_facts_offline:
                    from todo.remote import RemoteError
                    raise RemoteError("fake offline")
                known = [f for f in facts if f["item_uid"] in server.rows]
                server.git_facts.extend(copy.deepcopy(known))
                return {"ok": True, "stored": len(known),
                        "skipped": [f["item_uid"] for f in facts if f["item_uid"] not in server.rows]}

            def plugins(self, project, repo):
                from todo.remote import RemoteError
                server.plugin_gets += 1
                if server.offline or server.plugins_down:
                    raise RemoteError("fake offline")
                if server.plugin_config is None:
                    raise RemoteError("no such route", 404)
                got = server.plugin_config.get(repo) or {}
                return {"instances": copy.deepcopy(got.get("instances") or {}),
                        "grants": copy.deepcopy(got.get("grants") or {}),
                        "plugins": copy.deepcopy(got.get("plugins") or []),
                        "secrets": [c for r, c, _ in server.plugin_creds if r == repo],
                        "host_secrets": list(server.host_secrets), "runs": {},
                        "config": copy.deepcopy(got.get("config") or {"text": "{}\n", "code": {}}),
                        "track": list(got.get("track") or [])}

            def put_plugin_config(self, project, repo, track=None, enable=None, disable=None, base=None):
                from todo.remote import RemoteError
                if server.offline or server.plugins_down:
                    raise RemoteError("fake offline")
                got = server.plugin_config.setdefault(repo, {"instances": {}, "grants": {}})
                if base is not None and list(got.get("track") or []) != list(base):
                    raise RemoteError("the deploy branches changed since this page loaded", 409)
                if track is not None:
                    got["track"] = list(track)
                shipped = got.setdefault("shipped", [])
                if enable is not None and enable not in shipped:
                    shipped.append(enable)
                if disable is not None and disable in shipped:
                    shipped.remove(disable)
                return {"ok": True, "config": {"track": list(got.get("track") or []), "shipped": list(shipped)}}

            def put_plugins(self, project, repo, plugin, instances=None, grants=None):
                got = server.plugin_config.setdefault(repo, {"instances": {}, "grants": {}})
                if instances is not None:
                    got["instances"][plugin] = copy.deepcopy(instances)
                if grants is not None:
                    got["grants"][plugin] = list(grants)
                return {"ok": True}

            def plugin_credential(self, project, repo, connection, secret, endpoint=None):
                from todo.remote import RemoteError
                if server.creds_unkeyed:
                    raise RemoteError("no TODO_SECRET_KEY", 503)
                if server.creds_moved:
                    raise RemoteError(f"{connection} points at https://elsewhere now, not {endpoint}", 409)
                server.plugin_creds.append((repo, connection, secret))
                server.cred_endpoints.append(endpoint)
                return {"ok": True}

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
                    if e == "doc" and row is None and uid in server.doc_tombs:
                        out[-1]["last_sha256"] = server.doc_tombs[uid]
                    if e in ("note", "log") and row is None and server.feed_by_plugin:
                        out[-1]["by_plugin"] = uid in server.plugin_tombs
                return {"changes": out, "cursor": rows[-1][0] if rows else since,
                        "more": len(rows) == limit, "deploy_step": server.deploy_step,
                        "actions": server.actions}

        return Client()
