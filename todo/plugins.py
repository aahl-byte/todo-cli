"""Repo plugins, run on this host: the bundled plugin host (`plugin_host.mjs`,
under Node) runs a repo's `.todo-plugins/` for an item and an event, and what
it attaches is written into the store, so the next sync round carries it.

- Definitions come from the repo's default branch in its local checkout; a
  repo without a plugins file still gets the shipped defaults.
- Instances and grants come from the server on a synced store (cached in
  `.sync/plugins.json`) and from `.TODO/.plugins.yaml` on a local-only one.
- A run replaces the instance's previous attachments by key; each written note
  or log entry carries `plugin` and `plugin_key` and a uid derived from both.
- Failures never stop a command: they go to the run record and one line on
  stderr.

See docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §4.
"""

from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

from . import checkout, connections, docs, gitfacts, store, sync, yamlio
from .remote import RemoteError, remote_for, sync_config
from .uids import hash_uid
from .util import now, to_str

HOST_ENV = "TODO_PLUGIN_HOST"       # a command that stands in for `node plugin_host.mjs`
OFF_ENV = "TODO_PLUGINS"            # "0" or "off" turns plugins off on this host
BUNDLE = Path(__file__).with_name("plugin_host.mjs")
HOST_TIMEOUT = 360
PLUGINS_DIR = ".todo-plugins"
LOCAL_FILE = ".plugins.yaml"
CACHE_FILE = "plugins.json"
RUNS_FILE = "plugin-runs.json"
TIPS_FILE = "plugin-tips.json"
DEFS_FILE = "plugin-defs.json"
CACHE_EVERY = 60                    # seconds a synced store trusts its cached instances
FLOOR_EVERY = 60                    # seconds between checks for due `every:` floors
DEFS_KEPT = 32
LOG_KEPT = 50
GIT_TRIGGERS = ("push", "pr", "deployment")
NO_NODE = "plugins skipped: node isn't installed"
_DURATION = re.compile(r"^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$")
_UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400}
_CODE_NAME = re.compile(r"^(?!\.)[\w.-]+(/[\w.-]+)*$")


class HostError(Exception):
    """The plugin host couldn't be run, or gave no readable answer."""


# ── switches and notices ──────────────────────────────────────────────────────
_queue: list = []
_said: set = set()


def off() -> bool:
    return os.environ.get(OFF_ENV, "").strip().lower() in ("0", "off", "no", "false")


def notice(msg: str) -> None:
    """One line on stderr, once per command."""
    if msg not in _said:
        _said.add(msg)
        print(msg, file=sys.stderr)


def queue(item_id: str, event: dict) -> None:
    """Run `event` for the item once the command is done."""
    _queue.append((item_id, event))


def _take_queue() -> list:
    jobs = list(_queue)
    _queue.clear()
    return jobs


# ── the host ──────────────────────────────────────────────────────────────────
def host_command() -> list | None:
    fake = os.environ.get(HOST_ENV, "").strip()
    if fake:
        return shlex.split(fake)
    node = shutil.which("node")
    return [node, str(BUNDLE)] if node else None


def _host_stamp() -> str:
    fake = os.environ.get(HOST_ENV, "").strip()
    if fake:
        return "fake:" + fake
    try:
        st = BUNDLE.stat()
    except OSError:
        return "none"
    return f"{st.st_mtime_ns}:{st.st_size}"


def call_host(payload: dict) -> dict:
    cmd = host_command()
    if cmd is None:
        raise HostError("node isn't installed")
    try:
        r = subprocess.run(cmd, input=json.dumps(payload), capture_output=True, text=True, timeout=HOST_TIMEOUT)
    except subprocess.TimeoutExpired:
        raise HostError(f"the plugin host ran past {HOST_TIMEOUT // 60} minutes") from None
    except OSError as e:
        raise HostError(f"the plugin host didn't start ({e})") from None
    if r.returncode != 0:
        raise HostError(f"the plugin host exited {r.returncode}: {(r.stderr or '').strip()[:500]}")
    lines = [line for line in (r.stdout or "").splitlines() if line.strip()]
    try:
        out = json.loads(lines[-1]) if lines else None
    except ValueError:
        out = None
    if not isinstance(out, dict):
        raise HostError("the plugin host's answer isn't JSON")
    return out


# ── state files ───────────────────────────────────────────────────────────────
def _state(root: Path, name: str) -> Path:
    return gitfacts._state_file(root, name)


def _read(f: Path) -> dict:
    return gitfacts._read_json(f)


def _write(f: Path, data: dict) -> None:
    f.parent.mkdir(parents=True, exist_ok=True)
    yamlio.write_atomic(f, json.dumps(data, sort_keys=True, indent=1))


def _plain(v):
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


# ── where an item's plugins come from ─────────────────────────────────────────
def repo_key(root: Path, it: dict) -> str:
    """owner/name of the item's repo: its repo field, else the store's own repo."""
    return checkout.repo_key(it.get("repo")) or gitfacts._store_repo(root)[0]


def is_open(root: Path, it: dict) -> bool:
    return it["folder"] in (store.OPEN, store.DEFERRED) and not gitfacts._archived(root, it)


def _git(d: Path, *args: str, timeout: float = 30):
    return gitfacts._git(d, *args, timeout=timeout)


def _default_ref(d: Path, info: dict | None) -> str | None:
    """The default branch's tip as a ref this checkout can read: the tip
    ls-remote saw (fetched when missing), else origin/<default>."""
    default = (info or {}).get("default")
    tip = ((info or {}).get("tips") or {}).get(default) if default else None
    if tip:
        if _git(d, "cat-file", "-e", f"{tip}^{{commit}}").returncode != 0:
            _git(d, "fetch", "--quiet", "origin", default, timeout=120)
        if _git(d, "cat-file", "-e", f"{tip}^{{commit}}").returncode == 0:
            return tip
    if not default:
        r = _git(d, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
        head = r.stdout.strip() if r is not None and r.returncode == 0 else ""
        default = head.split("/", 1)[1] if head.startswith("origin/") else None
    for name in [default] if default else ["main", "master"]:
        r = _git(d, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{name}")
        if r is not None and r.returncode == 0:
            return f"origin/{name}"
    return None


def _code_names(text: str) -> list:
    try:
        from ruamel.yaml import YAML
        doc = YAML(typ="safe").load(text)
    except Exception:  # noqa: BLE001 — the host reports a malformed file
        return []
    plugins = doc.get("plugins") if isinstance(doc, dict) else None
    if not isinstance(plugins, dict):
        return []
    names = {p.get("code") for p in plugins.values() if isinstance(p, dict) and isinstance(p.get("code"), str)}
    return sorted(n for n in names if _CODE_NAME.match(n) and ".." not in n.split("/"))


def read_repo(d: Path, ref: str | None = None) -> dict | None:
    """`{text, files}` from `.todo-plugins/` at `ref`, or from the working tree when `ref` is None;
    None when the repo has no plugins file."""
    def show(name: str) -> str | None:
        if ref is None:
            f = d / PLUGINS_DIR / name
            return f.read_text() if f.is_file() else None
        r = _git(d, "show", f"{ref}:{PLUGINS_DIR}/{name}")
        return r.stdout if r is not None and r.returncode == 0 else None

    text = show("plugins.yaml")
    if text is None:
        return None
    files = {}
    for name in _code_names(text):
        body = show(name)
        if body is not None:
            files[name] = body
    return {"text": text, "files": files}


def describe(root: Path, payload: dict | None) -> dict | None:
    """What the repo file declares, as the host reads it; None without a host. Cached by content."""
    key = hashlib.sha1((_host_stamp() + "\x1f" + json.dumps(payload, sort_keys=True)).encode()).hexdigest()
    f = _state(root, DEFS_FILE)
    cache = _read(f)
    if key in cache:
        return cache[key]
    if host_command() is None:
        return None
    out = call_host({"mode": "describe", **({"repo": payload} if payload else {})})
    if not isinstance(out.get("plugins"), list):
        raise HostError("the plugin host's describe answer has no plugins")
    cache.pop(key, None)
    cache[key] = out
    while len(cache) > DEFS_KEPT:
        cache.pop(next(iter(cache)))
    _write(f, cache)
    return out


# ── instances ─────────────────────────────────────────────────────────────────
def _local_file(root: Path) -> Path:
    return root / LOCAL_FILE


def _read_local(root: Path) -> dict:
    f = _local_file(root)
    if not f.is_file():
        return {}
    try:
        data = _plain(yamlio.read(f) or {})
    except Exception as e:  # noqa: BLE001
        notice(f"plugins: {f} isn't readable YAML ({e})")
        return {}
    return data if isinstance(data, dict) else {}


def _write_local(root: Path, data: dict) -> None:
    yamlio.write_atomic(_local_file(root), yamlio.dump(yamlio.yaml(), data))


def _norm_stored(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    inst = raw.get("instances") if isinstance(raw.get("instances"), dict) else {}
    grants = raw.get("grants") if isinstance(raw.get("grants"), dict) else {}
    return {"instances": {str(k): [i for i in v if isinstance(i, dict)] for k, v in inst.items() if isinstance(v, list)},
            "grants": {str(k): [str(g) for g in v] for k, v in grants.items() if isinstance(v, list)},
            "plugins": raw.get("plugins") if isinstance(raw.get("plugins"), list) else [],
            "secrets": [str(s) for s in raw.get("secrets") or [] if isinstance(s, str)],
            "runs": raw.get("runs") if isinstance(raw.get("runs"), dict) else {}}


class Context:
    """One command's view of plugins: repo files, definitions and instances, each read once."""

    def __init__(self, root: Path, remote=None, project: str | None = None, seen: dict | None = None,
                 local: bool = False, fresh: bool = False):
        self.root, self.seen, self.local, self.fresh = root, seen or {}, local, fresh
        self.cfg = sync_config(root)
        self.project = project or (self.cfg or {}).get("project")
        self._remote = remote
        self._repos: dict = {}
        self._stored: dict = {}

    def remote(self):
        if self._remote is None and self.cfg and not sync.offline():
            self._remote = remote_for(self.root)
        return self._remote

    def checkout(self, key: str) -> Path | None:
        d = (self.seen.get(key) or {}).get("dir")
        return Path(d) if d else gitfacts.repo_dir(self.root, key)

    def repo(self, key: str) -> dict:
        """`{dir, payload, described}` for the repo; `described` is None without a host."""
        if key not in self._repos:
            d = self.checkout(key)
            payload = None
            if d is not None:
                payload = read_repo(d) if self.local else read_repo(d, _default_ref(d, self.seen.get(key)))
            try:
                described = describe(self.root, payload)
            except HostError as e:
                notice(f"plugins: {key}: {e}")
                described = None
            self._repos[key] = {"dir": d, "payload": payload, "described": described}
        return self._repos[key]

    def stored(self, key: str) -> dict:
        if key not in self._stored:
            self._stored[key] = self._load_stored(key)
        return self._stored[key]

    def _load_stored(self, key: str) -> dict:
        if not self.cfg:
            return _norm_stored(_read_local(self.root).get(key))
        f = _state(self.root, CACHE_FILE)
        cache = _read(f)
        got = cache.get(key) or {}
        if not self.fresh and time.time() - got.get("at", 0) < CACHE_EVERY:
            return _norm_stored(got)
        r = self.remote()
        if r is None:
            return _norm_stored(got)
        try:
            answer = r.plugins(self.project, key)
        except RemoteError as e:
            if e.status != 404:
                return _norm_stored(got)
            answer = {}
        except AttributeError:
            answer = {}
        cache[key] = {**_norm_stored(answer), "at": time.time()}
        _write(f, cache)
        return _norm_stored(answer)

    def save_stored(self, key: str, plugin: str, instances: list) -> None:
        if self.cfg:
            r = self.remote()
            if r is None:
                raise RemoteError("this store's server can't be reached (offline)")
            r.put_plugins(self.project, key, plugin, instances=instances)
            cache = _read(_state(self.root, CACHE_FILE))
            got = _norm_stored(cache.get(key))
            got["instances"][plugin] = instances
            cache[key] = {**got, "at": time.time()}
            _write(_state(self.root, CACHE_FILE), cache)
        else:
            data = _read_local(self.root)
            entry = data.setdefault(key, {})
            entry.setdefault("instances", {})[plugin] = instances
            if not instances:
                del entry["instances"][plugin]
            _write_local(self.root, data)
        self._stored.pop(key, None)


def _needs_no_settings(plugin: dict) -> bool:
    return all(s.get("optional") or "default" in s or s.get("type") in ("list", "toggle")
               for s in (plugin.get("settings") or {}).values() if isinstance(s, dict))


def merged_instances(plugin: dict, repo: list, stored: list, dropped: bool) -> list:
    """The repo's instances with stored ones over them by id, then the rest of the stored;
    an implicit default when there are none. Disabled ones included."""
    out = []
    for r in repo:
        s = next((x for x in stored if x.get("id") == r.get("id")), None)
        out.append({**r, **s, "settings": {**(r.get("settings") or {}), **(s.get("settings") or {})}} if s else dict(r))
    out += [dict(s) for s in stored if not any(r.get("id") == s.get("id") for r in repo)]
    if not out and not dropped and _needs_no_settings(plugin):
        out.append({"id": "default", "name": "default", "implicit": True})
    return out


def triggers(plugin: dict, inst: dict) -> list:
    return inst["on"] if inst.get("on") is not None else plugin.get("on") or []


def _matches(want, got) -> bool:
    return want is None or want == "*" or want == got


def fires(plugin: dict, inst: dict, event: dict) -> bool:
    if inst.get("enabled") is False:
        return False
    if event.get("type") == "refresh":
        return bool(plugin.get("every")) or any(t in GIT_TRIGGERS for t in triggers(plugin, inst))
    for t in triggers(plugin, inst):
        if isinstance(t, dict):
            st = t.get("status") or {}
            if event.get("type") == "status" and _matches(st.get("from"), event.get("from")) \
                    and _matches(st.get("to"), event.get("to")):
                return True
        elif t == "manual":
            if event.get("type") == "manual" and event.get("instance") == inst.get("id"):
                return True
        elif t == event.get("type"):
            return True
    return False


def duration(d) -> float | None:
    """Seconds in "15m", "1h"; None when it isn't a duration."""
    if isinstance(d, (int, float)) and not isinstance(d, bool):
        return d / 1000
    m = _DURATION.match(str(d or "").strip())
    return float(m.group(1)) * _UNITS[m.group(2)] if m else None


def plugin_view(ctx: Context, key: str) -> list:
    """`(plugin, [instances])` for every plugin the repo runs, instances merged and disabled ones kept."""
    described = ctx.repo(key)["described"]
    if described is None:
        return []
    stored = ctx.stored(key)["instances"]
    return [(p, merged_instances(p, (described.get("instances") or {}).get(p["name"]) or [],
                                 stored.get(p["name"]) or [], p["name"] in (described.get("dropped") or [])))
            for p in described["plugins"]]


# ── the item a plugin sees ────────────────────────────────────────────────────
def item_json(it: dict, key: str, d: Path | None) -> dict:
    owner, _, name = key.partition("/")
    links = [{"type": to_str((n.get("meta") or {}).get("type")) or "link", "url": to_str((n.get("meta") or {}).get("url"))}
             for n in it.get("notes") or [] if n.get("kind") == "link" and (n.get("meta") or {}).get("url")]
    return {"id": it["id"], "uid": it.get("uid") or it["id"], "title": it["title"], "type": it.get("type"),
            "status": it["status"], "priority": it.get("priority"), "repo": key or None,
            "repo_owner": owner or None, "repo_name": name or None, "branches": list(it.get("branches") or []),
            "jira": list(it.get("jira") or []), "app": it.get("app"), "section": it.get("section"),
            "developer": it.get("developer"), "qa_assignee": it.get("qa_assignee"),
            "dir": str(d) if d else None, "links": links}


# ── running ───────────────────────────────────────────────────────────────────
def instance_id(plugin: str, inst: dict) -> str:
    return f'{plugin}/{inst.get("id")}'


def run(ctx: Context, it: dict, event: dict, *, dry_run: bool = False, only: str | None = None,
        lock: bool = True) -> list | None:
    """Run what `event` fires for the item and, unless dry-run, apply it.
    `[{plugin, instance, result, changes}]`; None when there's no host to run it."""
    root = ctx.root
    key = repo_key(root, it)
    if not key:
        return []
    if host_command() is None:
        notice(NO_NODE)
        return None
    repo = ctx.repo(key)
    view = plugin_view(ctx, key)
    plugin, _, inst_id = (only or "").partition("/")
    wanted = [(p, i) for p, insts in view for i in insts
              if (not plugin or p["name"] == plugin) and (not inst_id or i.get("id") == inst_id) and fires(p, i, event)]
    if not wanted:
        return []
    stored = copy.deepcopy(ctx.stored(key)["instances"])
    if only:
        for p, insts in view:
            for i in insts:
                if p["name"] != plugin or (inst_id and i.get("id") != inst_id):
                    rows = stored.setdefault(p["name"], [])
                    rows[:] = [r for r in rows if r.get("id") != i.get("id")]
                    rows.append({"id": i.get("id"), "name": i.get("name") or i.get("id"), "enabled": False})
    payload = {"mode": "event", "hostConnections": connections.host_connections(),
               "secrets": connections.secrets_for(key), "storedInstances": stored,
               "grants": ctx.stored(key)["grants"], "item": item_json(it, key, repo["dir"]), "event": event,
               "repoKey": key, "dryRun": dry_run, "allowRepoCommands": True}
    if repo["payload"]:
        payload["repo"] = repo["payload"]
    try:
        out = call_host(payload)
    except HostError as e:
        if not dry_run:
            _record_failure(root, it, [instance_id(p["name"], i) for p, i in wanted], event, str(e), lock)
        notice(f"plugins: {it['id']}: {e}")
        return [{"plugin": p["name"], "instance": i, "result": {"attached": [], "wouldSend": [], "log": [],
                                                                "error": str(e)}, "changes": {}} for p, i in wanted]
    for err in out.get("errors") or []:
        notice(f"plugins: {key}: {err}")
    runs = [r for r in out.get("results") or [] if isinstance(r, dict) and isinstance(r.get("result"), dict)]
    if not dry_run:
        with _locked(root, it, lock):
            fresh = store.get_item(root, it["id"])
            if fresh is not None:
                for r in runs:
                    r["changes"] = apply(root, fresh, instance_id(r["plugin"], r.get("instance") or {}), r["result"], event)
                    fresh = store.get_item(root, it["id"]) or fresh
    for r in runs:
        res = r["result"]
        if res.get("error"):
            notice(f'plugins: {instance_id(r["plugin"], r.get("instance") or {})} on {it["id"]}: {res["error"]}')
    return runs


@contextlib.contextmanager
def _locked(root: Path, it: dict, lock: bool):
    if lock and sync.enabled(root):
        with sync.locked(root, [it.get("uid") or it["id"]]):
            yield
    else:
        yield


def _record_failure(root: Path, it: dict, iids: list, event: dict, error: str, lock: bool) -> None:
    with _locked(root, it, lock):
        runs = _read(_state(root, RUNS_FILE))
        mine = runs.setdefault(_item_key(it), {})
        for iid in iids:
            mine[iid] = {**_carried(mine.get(iid)), "at": now(), "event": _event_label(event), "error": error[:2000]}
        _write(_state(root, RUNS_FILE), runs)


def _item_key(it: dict) -> str:
    return it.get("uid") or it["id"]


def _event_label(event: dict) -> str:
    t = event.get("type")
    if t == "status":
        return f'status {event.get("from")} → {event.get("to")}'
    if t in GIT_TRIGGERS:
        return f'{t} {event.get("branch")}'
    if t == "manual":
        return f'manual {event.get("instance")}'
    return str(t)


def _carried(prev: dict | None) -> dict:
    """What a run that changes nothing keeps from the previous record: the docs the instance owns."""
    return {"docs": prev["docs"]} if prev and prev.get("docs") else {}


# ── applying a result ─────────────────────────────────────────────────────────
def _norm_url(u: str) -> str:
    return to_str(u).strip().rstrip("/").lower()


def _note_fields(a: dict) -> tuple:
    """(note kind, text, meta fields) for a link or edge attachment."""
    if a["kind"] == "link":
        meta = {"url": a["url"], "type": a.get("type") or "link"}
        if a.get("label"):
            meta["label"] = a["label"]
        return "link", a.get("label") or a["url"], meta
    meta = {"needs": a["needs"], "because": a["because"]}
    if a.get("in"):
        meta["in"] = a["in"]
    return "dependency", a["because"], meta


def _summary(a: dict) -> dict:
    keep = ("kind", "key", "type", "url", "label", "needs", "in", "because", "name", "text")
    return {k: (a[k][:300] if isinstance(a[k], str) else a[k]) for k in keep if k in a}


def apply(root: Path, it: dict, iid: str, result: dict, event: dict) -> dict:
    """Write one instance's result into the store, replacing what it attached
    before. Returns counts of what changed; an error or skip changes nothing."""
    runs_file = _state(root, RUNS_FILE)
    runs = _read(runs_file)
    mine = runs.setdefault(_item_key(it), {})
    prev = mine.get(iid)
    rec = {"at": now(), "event": _event_label(event)}
    log = [to_str(x) for x in result.get("log") or []]
    if result.get("wouldSend"):
        rec["would_send"] = len(result["wouldSend"])
    if result.get("error") or result.get("skipped"):
        rec.update({k: to_str(result[k])[:2000] for k in ("error", "skipped") if result.get(k)}, **_carried(prev))
        if log:
            rec["log"] = log[-LOG_KEPT:]
        mine[iid] = rec
        _write(runs_file, runs)
        return {}
    changes = {"added": 0, "updated": 0, "removed": 0}
    item_uid = it.get("uid") or it["id"]
    item_dir = root / it["folder"] / it["id"]
    notes = store._read_entries(item_dir / store.NOTES_DIR)
    logs = store._read_entries(item_dir / store.LOG_DIR)
    by_uid = {e["meta"].get("uid"): e for e in notes if e["meta"].get("uid")}
    logs_by_uid = {e["meta"].get("uid"): e for e in logs if e["meta"].get("uid")}
    kept: set = set()
    linked: set = set()
    owned_docs: list = []
    attached = []
    for a in result.get("attached") or []:
        if not isinstance(a, dict) or a.get("kind") not in ("link", "edge", "log", "request", "doc") or not a.get("key"):
            continue
        uid = hash_uid("plugin", iid, item_uid, a["key"])
        tag = {"plugin": iid, "plugin_key": a["key"]}
        kind = a["kind"]
        if kind == "link":
            url = _norm_url(a.get("url"))
            elsewhere = any(e["meta"].get("kind") == "link" and _norm_url(e["meta"].get("url")) == url
                            and e["meta"].get("uid") != uid and e["meta"].get("plugin") != iid for e in notes)
            if elsewhere or url in linked:
                log.append(f'skipped link {a.get("url")}: already linked on the item')
                continue
            linked.add(url)
        if kind in ("link", "edge"):
            note_kind, text, fields = _note_fields(a)
            fields = {**fields, **tag}
            e = by_uid.get(uid)
            if e is None:
                store.add_note(root, it["id"], text, now(), kind=note_kind, extra=fields, uid=uid)
                changes["added"] += 1
            elif e["text"] != text or e["meta"].get("kind") != note_kind or \
                    any(e["meta"].get(k) != v for k, v in fields.items()) or \
                    any(k in e["meta"] for k in ("label", "in") if k not in fields):
                meta = {k: v for k, v in e["meta"].items() if k not in ("label", "in")}
                store.rewrite_entry(root, it["id"], store.NOTES_DIR, e["id"], text, {**meta, "kind": note_kind, **fields})
                changes["updated"] += 1
        elif kind == "log":
            e = logs_by_uid.get(uid)
            if e is None:
                store.add_log(root, it["id"], to_str(a.get("text")), now(), extra=tag, uid=uid)
                changes["added"] += 1
            elif e["text"] != to_str(a.get("text")):
                store.rewrite_entry(root, it["id"], store.LOG_DIR, e["id"], to_str(a.get("text")), {**e["meta"], **tag})
                changes["updated"] += 1
        elif kind == "request":
            if uid not in by_uid and _post_request(root, it, to_str(a.get("text")), {**tag}, uid):
                changes["added"] += 1
        elif kind == "doc":
            name = to_str(a.get("name"))
            why = docs.name_error(name)
            if why or a.get("content") is None:
                log.append(f"skipped doc {name}: " + (why or "the host returned no content for it"))
                continue
            name, how = _write_doc(root, it, item_dir, name, a["content"])
            owned_docs.append(name)
            if how in changes:
                changes[how] += 1
        kept.add(uid)
        attached.append(_summary(a))
    for e in notes:
        m = e["meta"]
        if m.get("plugin") == iid and m.get("kind") in ("link", "dependency") and m.get("uid") not in kept:
            store.remove_note(root, it["id"], e["id"])
            changes["removed"] += 1
    for e in logs:
        if e["meta"].get("plugin") == iid and e["meta"].get("uid") not in kept:
            store.remove_log(root, it["id"], e["id"])
            changes["removed"] += 1
    for name in (prev or {}).get("docs") or []:
        if docs.find(owned_docs, name) is None and docs.remove(item_dir, it.get("uid"), name, now()):
            changes["removed"] += 1
    rec["attached"] = attached
    if owned_docs:
        rec["docs"] = owned_docs
    if log:
        rec["log"] = log[-LOG_KEPT:]
    mine[iid] = rec
    _write(runs_file, runs)
    if any(changes.values()) and sync.enabled(root):
        sync.mark_changed(root, it["id"])
        sync.flag_changes(root)
    return changes


def _write_doc(root: Path, it: dict, item_dir: Path, name: str, content: str) -> tuple:
    """(the name it went under, added|updated|same)."""
    data = content.encode()
    present = docs.files(item_dir)
    found = docs.find(present, name)
    if found is not None and docs.sha256_file(present[found]) == docs.sha256_bytes(data):
        return found, "same"
    return docs.add(item_dir, it.get("uid"), name, data, now()), "updated" if found else "added"


def _post_request(root: Path, it: dict, text: str, extra: dict, uid: str) -> bool:
    """A new request version, as `todo request --text` posts it."""
    if not text.strip():
        return False
    store.add_note(root, it["id"], text.strip(), now(), kind="ticket-request", extra=extra, uid=uid)
    if it["status"] != "requested" and not sync.enabled(root):
        store.update_todo(root, it["id"], {"status": "requested"}, now())
    return True


# ── when plugins run ──────────────────────────────────────────────────────────
def _open_items(root: Path) -> list:
    return [it for it in store.list_todos(root, [store.OPEN, store.DEFERRED]) if is_open(root, it)]


def push_jobs(root: Path, seen: dict | None) -> list:
    """`(item id, push event)` for each open item branch whose tip moved since plugins last saw it."""
    if not seen:
        return []
    f = _state(root, TIPS_FILE)
    state = _read(f)
    jobs = []
    items = _open_items(root)
    for key, info in seen.items():
        tips = info.get("tips") or {}
        before = state.get(key) or {}
        after = {}
        for it in items:
            if repo_key(root, it) != key:
                continue
            for b in it["branches"]:
                sha = tips.get(b)
                if sha:
                    after[b] = sha
                if sha != before.get(b) and (sha or before.get(b)):
                    jobs.append((it["id"], {"type": "push", "branch": b}))
        state[key] = after
    _write(f, state)
    return jobs


def floor_jobs(ctx: Context) -> list:
    """`(item id, refresh)` for each open item with an instance whose `every:` has passed since it last ran there."""
    root = ctx.root
    f = _state(root, TIPS_FILE)
    state = _read(f)
    if time.time() - state.get("floors_at", 0) < FLOOR_EVERY:
        return []
    state["floors_at"] = time.time()
    _write(f, state)
    runs = _read(_state(root, RUNS_FILE))
    jobs = []
    for it in _open_items(root):
        key = repo_key(root, it)
        if not key:
            continue
        mine = runs.get(_item_key(it)) or {}
        if any(duration(p.get("every")) is not None and i.get("enabled") is not False
               and _since(mine.get(instance_id(p["name"], i))) >= duration(p["every"])
               for p, insts in plugin_view(ctx, key) for i in insts):
            jobs.append((it["id"], {"type": "refresh"}))
    return jobs


def _since(rec: dict | None) -> float:
    if not rec or not rec.get("at"):
        return float("inf")
    try:
        from datetime import datetime
        at = datetime.fromisoformat(str(rec["at"]).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("inf")
    return time.time() - at


def run_jobs(ctx: Context, jobs: list, *, lock: bool = True, report: bool = False) -> list:
    """Run each `(item id, event)` once, never raising. `(item, runs)` per job that ran."""
    done, out = set(), []
    for item_id, event in jobs:
        sig = (item_id, json.dumps(event, sort_keys=True))
        if sig in done:
            continue
        done.add(sig)
        it = store.get_item(ctx.root, item_id)
        if it is None or not is_open(ctx.root, it):
            continue
        try:
            runs = run(ctx, it, event, lock=lock)
        except Exception as e:  # noqa: BLE001 — plugins must never break a command
            notice(f"plugins: {item_id}: skipped ({type(e).__name__}: {e})")
            continue
        if runs is None:
            break
        if runs:
            out.append((it, runs))
    if report:
        for it, runs in out:
            for line in run_lines(it, runs):
                print(line)
    return out


def run_lines(it: dict, runs: list) -> list:
    out = []
    for r in runs:
        res, iid = r["result"], instance_id(r["plugin"], r.get("instance") or {})
        if res.get("error"):
            what = f'error: {res["error"]}'
        elif res.get("skipped"):
            what = f'skipped: {res["skipped"]}'
        else:
            c = r.get("changes") or {}
            what = ", ".join(f"{n} {k}" for k, n in c.items() if n) or "no change"
        out.append(f'{it["id"]}: {iid}: {what}')
    return out


def after_command(root: Path, seen: dict | None = None) -> None:
    """The plugins a command set off: its status moves and new branches, and on
    a local-only store the pushes and floors since the last check."""
    if root is None or not root.is_dir() or off():
        _take_queue()
        return
    try:
        jobs = _take_queue()
        ctx = Context(root, seen=seen)
        if not sync.enabled(root):
            jobs += push_jobs(root, seen) + floor_jobs(ctx)
        run_jobs(ctx, jobs)
    except Exception as e:  # noqa: BLE001
        notice(f"plugins: skipped ({type(e).__name__}: {e})")


def after_round(root: Path, remote, project: str | None, seen: dict | None) -> None:
    """A synced store's plugins after a round: pushes the round's ls-remote saw, and due floors."""
    if off():
        return
    try:
        ctx = Context(root, remote=remote, project=project, seen=seen)
        run_jobs(ctx, push_jobs(root, seen) + floor_jobs(ctx))
    except Exception as e:  # noqa: BLE001
        notice(f"plugins: skipped ({type(e).__name__}: {e})")


# ── reading results ───────────────────────────────────────────────────────────
def records(root: Path, it: dict) -> dict:
    """The item's last run per instance id."""
    return _read(_state(root, RUNS_FILE)).get(_item_key(it)) or {}


def notices(root: Path, it: dict) -> list:
    """`(instance id, skipped|error, why)` for each instance whose last run on the item didn't attach."""
    out = []
    for iid, rec in sorted(records(root, it).items()):
        for k in ("error", "skipped"):
            if rec.get(k):
                why = rec[k]
                prefix = iid.partition("/")[0] + ": "
                out.append((iid, k, why[len(prefix):] if why.startswith(prefix) else why))
                break
    return out


def server_runs(root: Path, it: dict) -> dict:
    """The server's last runs that were on this item, from the cached instances."""
    out = {}
    for repo in _read(_state(root, CACHE_FILE)).values():
        for iid, r in ((repo or {}).get("runs") or {}).items():
            if isinstance(r, dict) and r.get("item") in (it.get("uid"), it["id"]):
                out[iid] = r
    return out
