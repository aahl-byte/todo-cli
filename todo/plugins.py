"""Plugins, run on this host: the bundled plugin host (`plugin_host.mjs`,
under Node) runs a repo's plugin config for an item and an event, and what it
attaches is written into the store, so the next sync round carries it.

- The config, instances and grants come from the server on a synced store
  (cached in `.sync/plugins.json`) and from `.TODO/.plugins.yaml` on a
  local-only one (see plugin_config). A repo with no config still gets the
  shipped plugins that are always on. `todo plugin test --draft` runs a draft
  plugin from a file in place of the config's plugin of that name.
- On a synced store the CLI runs only the instances the server leaves to it,
  and never starts a command a connection from the server's config names.
- Links and edges replace what the instance attached before; logs and
  requests only add. Each written note or log entry carries `plugin` and
  `plugin_key` and a uid derived from both. One a person removed is never
  made again.
- Every job of a command or round runs in one host process. Failures never
  stop a command: they go to the run record and one line on stderr.

See docs/plans/2026-10-27-server-owned-plugins-design.md.
"""

from __future__ import annotations

import base64
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
from datetime import datetime
from pathlib import Path

from . import checkout, connections, docs, gitfacts, identity, plugin_config, render, statelock, store, sync, yamlio
from .remote import RemoteError, remote_for, sync_config
from .uids import hash_uid
from .util import now, to_str

HOST_ENV = "TODO_PLUGIN_HOST"       # a command that stands in for `node plugin_host.mjs`
OFF_ENV = "TODO_PLUGINS"            # "0" or "off" turns plugins off on this host
JIRA_READ_ONLY_ENV = "JIRA_READ_ONLY"  # "1": the host jira connection is never written through
BUNDLE = Path(__file__).with_name("plugin_host.mjs")
HOST_TIMEOUT = 360
CACHE_FILE = plugin_config.CACHE_FILE
RUNS_FILE = "plugin-runs.json"
TIPS_FILE = "plugin-tips.json"
DEFS_FILE = "plugin-defs.json"
DEFERRED_FILE = "plugin-deferred.json"
PLUGIN_BUDGET = 20.0                # seconds of automatic plugin runs a command allows itself
BATCH_JOBS = 8                      # jobs per host process, so the budget is checked between them
MIN_RUN = 1.0                       # the least time a run is given, even when the budget is spent
FLOOR_EVERY = 60                    # seconds between checks for due `every:` floors
DEFS_KEPT = 32
LOG_KEPT = 50
SEEN = "~seen"                      # in the tips file: each repo's ls-remote answer, as last handled
REMOVED = "~removed"                # in the runs file: item → plugin uids a person removed
RUNNER = "~runner"                  # in the runs file: uids the runner removed, until the server has the remove
REMOVED_KEPT = 500
REPLACED = ("link", "dependency", "comment")   # note kinds a run replaces; logs and requests only add
GIT_TRIGGERS = ("push", "pr", "deployment")
HOST_FAILED = "the plugin host failed"
NO_NODE = "plugins skipped: node isn't installed"
_DURATION = re.compile(r"^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$")
_UNITS = {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400}


class HostError(Exception):
    """The plugin host couldn't be run, or gave no readable answer."""


# ── switches and notices ──────────────────────────────────────────────────────
_queue: list = []
_said: set = set()


def off() -> bool:
    return os.environ.get(OFF_ENV, "").strip().lower() in ("0", "off", "no", "false")


def reset() -> None:
    """Forget this process's queued events and the notices already given."""
    _queue.clear()
    _said.clear()


def notice(msg: str) -> None:
    """One line on stderr, once per command."""
    if msg not in _said:
        _said.add(msg)
        print(msg, file=sys.stderr)


def queue(item_id: str, event: dict) -> None:
    """Run `event` for the item once the command is done."""
    _queue.append((item_id, event))


def _take_queue() -> list:
    jobs = [Job(item_id, event) for item_id, event in _queue]
    _queue.clear()
    return jobs


class Job:
    """An event to run for an item. `only` narrows it to those instance ids;
    `anywhere` runs instances the server would otherwise run (a person asked)."""

    def __init__(self, item_id: str, event: dict, only=None, anywhere: bool = False):
        self.item_id, self.event, self.only, self.anywhere = item_id, event, only, anywhere

    def sig(self) -> tuple:
        return self.item_id, json.dumps(self.event, sort_keys=True), tuple(sorted(self.only or ())), self.anywhere


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
    return gitfacts.state_file(root, name)


state_lock = statelock.locked


def _read(f: Path) -> dict:
    return gitfacts.read_json(f)


def _write(f: Path, data: dict) -> None:
    statelock.write_json(f, data)


@contextlib.contextmanager
def _updating(root: Path, name: str):
    """The state file's data, written back atomically on the way out, under the state lock."""
    f = _state(root, name)
    with state_lock(root):
        data = _read(f)
        yield data
        _write(f, data)


def _plain(v):
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def is_open(root: Path, it: dict) -> bool:
    return it["folder"] in (store.OPEN, store.DEFERRED) and not gitfacts.is_archived(root, it)


def _git(d: Path, *args: str, timeout: float = 30):
    try:
        return subprocess.run(["git", "-C", str(d), *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return None


def _ok(r) -> bool:
    return r is not None and r.returncode == 0


# ── a draft plugin ────────────────────────────────────────────────────────────
def read_draft(path: Path) -> dict:
    """`{manifest, code}` from a draft plugin's YAML file and the code file its `code:` names beside it."""
    try:
        manifest = path.read_text()
    except OSError as e:
        raise HostError(f"can't read {path} ({e.strerror or e})") from None
    code = None
    try:
        from ruamel.yaml import YAML
        doc = YAML(typ="safe").load(manifest)
    except Exception:  # noqa: BLE001 — the host reports YAML that doesn't parse
        doc = None
    name = doc.get("code") if isinstance(doc, dict) else None
    if isinstance(name, str):
        f = path.parent / name
        if not f.is_file():
            raise HostError(f"{path.name} names code {name}, which isn't beside it")
        code = f.read_text()
    return {"manifest": manifest, "code": code}


def with_draft(config: dict | None, name: str, draft: dict) -> dict:
    """The config with the draft standing in for its plugin `name`."""
    from ruamel.yaml import YAML
    safe = YAML(typ="safe")
    try:
        doc = safe.load((config or {}).get("text") or "") or {}
    except Exception:  # noqa: BLE001 — the host reports the config's own errors
        doc = {}
    doc = doc if isinstance(doc, dict) else {}
    try:
        manifest = safe.load(draft["manifest"])
    except Exception as e:  # noqa: BLE001
        raise HostError(f"the draft isn't YAML: {e}") from None
    plugins = doc.get("plugins") if isinstance(doc.get("plugins"), dict) else {}
    doc["plugins"] = {**plugins, name: manifest if manifest is not None else {}}
    code = {k: v for k, v in ((config or {}).get("code") or {}).items() if k != name}
    if draft.get("code") is not None:
        code[name] = draft["code"]
    return {"text": yamlio.dump(yamlio.yaml(), _plain(doc)), "code": code}


def describe(root: Path, payload: dict | None) -> dict | None:
    """What the repo's config declares, as the host reads it; None without a host.
    Cached by content, unless the host itself failed."""
    key = hashlib.sha1((_host_stamp() + "\x1f" + json.dumps(payload, sort_keys=True)).encode()).hexdigest()
    cached = _read(_state(root, DEFS_FILE)).get(key)
    if cached is not None:
        return cached
    if host_command() is None:
        return None
    out = call_host({"mode": "describe", **({"config": payload} if payload else {})})
    if not isinstance(out.get("plugins"), list):
        raise HostError("the plugin host's describe answer has no plugins")
    failed = next((e for e in out.get("errors") or [] if str(e).startswith(HOST_FAILED)), None)
    if failed:
        raise HostError(failed)
    with _updating(root, DEFS_FILE) as cache:
        cache.pop(key, None)
        cache[key] = out
        while len(cache) > DEFS_KEPT:
            cache.pop(next(iter(cache)))
    return out


# ── instances ─────────────────────────────────────────────────────────────────
class Context:
    """One command's view of plugins: configs, definitions, instances and repo keys, each read once. `draft` is
    `{name, manifest, code}`, a plugin that stands in for the config's own of that name; `instances` replaces a
    plugin's stored instances, by plugin, for this command alone."""

    def __init__(self, root: Path, remote=None, project: str | None = None, seen: dict | None = None,
                 draft: dict | None = None, instances: dict | None = None, fresh: bool = False):
        self.root, self.seen, self.draft, self.fresh = root, seen or {}, draft, fresh
        self.overrides = instances or {}
        self.cfg = sync_config(root)
        self.project = project or (self.cfg or {}).get("project")
        self._remote = remote
        self._repos: dict = {}
        self._stored: dict = {}
        self._own: str | None = None
        self.user = identity.user()

    @property
    def synced(self) -> bool:
        return self.cfg is not None

    def remote(self):
        if self._remote is None and self.cfg and not sync.offline():
            self._remote = remote_for(self.root)
        return self._remote

    def repo_key(self, it: dict) -> str:
        """owner/name of the item's repo: its repo field, else the store's own repo."""
        key = checkout.repo_key(it.get("repo"))
        if key:
            return key
        if self._own is None:
            self._own = gitfacts.store_repo(self.root)[0]
        return self._own

    def checkout(self, key: str) -> Path | None:
        d = (self.seen.get(key) or {}).get("dir")
        return Path(d) if d else gitfacts.repo_dir(self.root, key)

    def repo(self, key: str) -> dict:
        """`{dir, payload, described}` for the repo; `described` is None when its plugins can't run here."""
        if key not in self._repos:
            self._repos[key] = self._load_repo(key)
        return self._repos[key]

    def config(self, key: str) -> dict | None:
        """The repo's config as the host reads it, `{text, code}`; None when a synced store's server gave none."""
        if self.synced:
            config = self.stored(key)["config"]
        else:
            config = plugin_config.local_config(self.root, key, notice)
        if self.draft:
            config = with_draft(config, self.draft["name"], self.draft)
        return config

    def _load_repo(self, key: str) -> dict:
        d = self.checkout(key)
        try:
            payload = self.config(key)
            described = describe(self.root, payload)
        except HostError as e:
            notice(f"plugins: {key}: {e}")
            payload, described = None, None
        return {"dir": d, "payload": payload, "described": described}

    def stored(self, key: str) -> dict:
        if key not in self._stored:
            got = self._load_stored(key)
            if self.overrides:
                got = {**got, "instances": {**got["instances"], **self.overrides}}
            self._stored[key] = got
        return self._stored[key]

    def _load_stored(self, key: str) -> dict:
        if not self.cfg:
            return plugin_config.norm(plugin_config.local_entry(self.root, key, notice))
        return plugin_config.synced(self.root, key, self.remote(), self.project, self.fresh)

    def save_stored(self, key: str, plugin: str, instances: list) -> None:
        if self.cfg:
            r = self.remote()
            if r is None:
                raise RemoteError("this store's server can't be reached (offline)")
            r.put_plugins(self.project, key, plugin, instances=instances)
            with plugin_config.updating_cache(self.root) as cache:
                got = {**(cache.get(key) or {}), **plugin_config.norm(cache.get(key))}
                got["instances"][plugin] = instances
                cache[key] = {**got, "at": time.time()}
        else:
            with plugin_config.editing_local(self.root, key) as entry:
                rows = entry.setdefault("instances", {})
                rows[plugin] = instances
                if not instances:
                    del rows[plugin]
                if not rows:
                    del entry["instances"]
        self._stored.pop(key, None)

    def listed(self, key: str, plugin: str, inst: dict) -> dict | None:
        """The server's entry for the instance, from its plugin list."""
        for p in self.stored(key)["plugins"]:
            if p.get("name") == plugin:
                return next((i for i in p.get("instances") or [] if isinstance(i, dict) and i.get("id") == inst.get("id")),
                            None)
        return None

    def owns(self, it: dict) -> bool:
        """Whether this clone's user runs the item's CLI instances: its developer, else its creator."""
        return (it.get("developer") or it.get("creator")) == self.user

    def any_here(self, key: str, it: dict) -> bool:
        """Whether this host could run any instance for the item on its own, without describing the repo."""
        if not self.cfg:
            return True
        stored = self.stored(key)
        return not stored.get("stale") and self.owns(it) and any(
            isinstance(i, dict) and i.get("server_runs") is False for p in stored["plugins"] for i in p.get("instances") or [])

    def runs_here(self, key: str, plugin: str, inst: dict, it: dict) -> bool:
        """Whether this host runs the instance on its own: always on a local-only
        store; on a synced one only when the server leaves it to the CLI, the
        server's list is current enough to trust, and this clone owns the item."""
        if not self.cfg:
            return True
        entry = self.listed(key, plugin, inst)
        return bool(entry) and entry.get("server_runs") is False and not self.stored(key).get("stale") \
            and self.owns(it)


def _needs_no_settings(plugin: dict) -> bool:
    return all(s.get("optional") or "default" in s or s.get("type") in ("list", "toggle")
               for s in (plugin.get("settings") or {}).values() if isinstance(s, dict))


def merged_instances(plugin: dict, stored: list) -> list:
    """The stored instances, or an implicit default when there are none and nothing must be set. Disabled ones included."""
    out = [dict(s) for s in stored]
    if not out and _needs_no_settings(plugin):
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
    return [(p, merged_instances(p, stored.get(p["name"]) or [])) for p in described["plugins"]]


# ── the item a plugin sees ────────────────────────────────────────────────────
def item_json(it: dict, key: str, d: Path | None, item_dir: Path | None = None) -> dict:
    owner, _, name = key.partition("/")
    links = [{"type": to_str((n.get("meta") or {}).get("type")) or "link", "url": to_str((n.get("meta") or {}).get("url"))}
             for n in it.get("notes") or [] if n.get("kind") == "link" and (n.get("meta") or {}).get("url")]
    return {"id": it["id"], "uid": it["uid"], "title": it["title"], "type": it.get("type"),
            "status": it["status"], "priority": it.get("priority"), "repo": key or None,
            "repo_owner": owner or None, "repo_name": name or None, "branches": list(it.get("branches") or []),
            "jira": list(it.get("jira") or []), "app": it.get("app"), "section": it.get("section"),
            "developer": it.get("developer"), "qa_assignee": it.get("qa_assignee"),
            "dir": str(d) if d else None, "links": links, "requests": _requests(it),
            "docs": _plugin_docs(item_dir) if item_dir else []}


def _plugin_docs(item_dir: Path) -> list:
    """Docs a plugin instance wrote that no one has edited since, with the version it gave each."""
    present = docs.files(item_dir)
    return [{"name": name, "plugin": e["plugin"], "version": e.get("plugin_version")}
            for name, e in sorted(docs.read_meta(item_dir).items())
            if e.get("plugin") and name in present and docs.sha256_file(present[name]) == e.get("sha256")]


def _requests(it: dict) -> list:
    """Every request version's text, newest first, as render.current_request orders them."""
    notes = [n for n in it.get("notes") or [] if n.get("kind") == "ticket-request"]
    notes.sort(key=lambda n: (render._version(n), n["id"]), reverse=True)
    return [to_str(n.get("text")) for n in notes]


# ── running ───────────────────────────────────────────────────────────────────
def instance_id(plugin: str, inst: dict) -> str:
    return f'{plugin}/{inst.get("id")}'


def _plan(ctx: Context, job: Job, dry_run: bool) -> dict | None:
    """The host input for a job, with the instances it may run; None when nothing fires."""
    root = ctx.root
    it = store.get_item(root, job.item_id)
    if it is None:
        return None
    key = ctx.repo_key(it)
    if not key or (not job.anywhere and not ctx.any_here(key, it)):
        return None
    repo = ctx.repo(key)
    if repo["described"] is None:
        return None
    view = plugin_view(ctx, key)

    def allowed(p, i) -> bool:
        iid = instance_id(p["name"], i)
        return (job.only is None or iid in job.only) and (job.anywhere or ctx.runs_here(key, p["name"], i, it))

    wanted = [(p, i) for p, insts in view for i in insts if allowed(p, i) and fires(p, i, job.event)]
    if not wanted:
        return None
    blocked = [(p, i, why) for p, i in wanted for why in [_held_secret(ctx, key, p, i)] if why]
    wanted = [(p, i) for p, i in wanted if not any(b[1] is i for b in blocked)]
    if not it.get("uid"):
        store.ensure_uid(root, it["id"], ctx.project if ctx.synced else None)
        it = store.get_item(root, it["id"])
    plan = {"job": job, "item": it, "wanted": wanted, "payload": None,
            "blocked": [(instance_id(p["name"], i), why) for p, i, why in blocked]}
    if not wanted:
        return plan
    stored = {name: [_without_secrets(i) for i in rows] for name, rows in ctx.stored(key)["instances"].items()}
    for p, insts in view:
        for i in insts:
            if not allowed(p, i) or any(b[1] is i for b in blocked):
                rows = stored.setdefault(p["name"], [])
                rows[:] = [r for r in rows if r.get("id") != i.get("id")]
                rows.append({"id": i.get("id"), "name": i.get("name") or i.get("id"), "enabled": False})
    secrets = connections.secrets_for(key, repo["described"].get("connections") or {})
    for name in secrets.pop("moved"):
        notice(f"plugins: {key}'s {name} connection points elsewhere than where its secret here was given, so it gets none; "
               f"todo connection auth {name} --repo {key} gives it one")
    payload = {"hostConnections": connections.host_connections(), "secrets": secrets,
               "storedInstances": stored, "grants": ctx.stored(key)["grants"],
               "item": item_json(it, key, repo["dir"], root / it["folder"] / it["id"]), "event": job.event, "repoKey": key,
               "dryRun": dry_run, "allowRepoCommands": not ctx.synced}
    if os.environ.get(JIRA_READ_ONLY_ENV) == "1":
        payload["dryRunConnections"] = ["jira"]
    if repo["payload"]:
        payload["config"] = repo["payload"]
    plan["payload"] = payload
    return plan


def _held_secret(ctx: Context, key: str, plugin: dict, inst: dict) -> str | None:
    """Why the instance can't run here when a setting it needs is a secret only the server holds."""
    for k, v in (inst.get("settings") or {}).items():
        spec = (plugin.get("settings") or {}).get(k) or {}
        if is_secret_value(v) and not spec.get("optional") and "default" not in spec:
            reason = (ctx.listed(key, plugin["name"], inst) or {}).get("server_runs_reason")
            return (f"setting {k} is a secret the server holds, and the server can't run this instance"
                    + (f": {reason}" if reason else ""))
    return None


def is_secret_value(v) -> bool:
    """A secret setting the server holds: it answers `{set: true}`, never the value."""
    return isinstance(v, dict) and v.get("set") is True


def _without_secrets(inst: dict) -> dict:
    out = copy.deepcopy(inst)
    if isinstance(out.get("settings"), dict):
        out["settings"] = {k: v for k, v in out["settings"].items() if not is_secret_value(v)}
    return out


def _execute(ctx: Context, plans: list, *, dry_run: bool, lock: bool) -> list:
    """Run every plan in one host process and apply what comes back. `(item, runs)` per plan."""
    for p in plans:
        for iid, why in p.get("blocked") or []:
            if not dry_run:
                with _locked(ctx.root, p["item"], lock):
                    apply(ctx.root, p["item"], iid, {"skipped": why}, p["job"].event)
            notice(f"plugins: {iid} on {p['item']['id']}: {why}")
    plans = [p for p in plans if p["payload"] is not None]
    if not plans:
        return []
    try:
        out = call_host({"mode": "events", "runs": [p["payload"] for p in plans]})
        answers = out.get("runs")
        if not isinstance(answers, list) or len(answers) != len(plans):
            raise HostError(next(iter(out.get("errors") or []), "the plugin host's answer has the wrong runs"))
    except HostError as e:
        done = []
        for p in plans:
            if not dry_run:
                _record_failure(ctx.root, p["item"], [instance_id(x["name"], i) for x, i in p["wanted"]],
                                p["job"].event, str(e), lock)
            done.append((p["item"], [{"plugin": x["name"], "instance": i, "changes": {},
                                      "result": {"attached": [], "wouldSend": [], "log": [], "error": str(e)}}
                                     for x, i in p["wanted"]]))
        notice(f"plugins: {e}")
        return done
    done = []
    for p, answer in zip(plans, answers):
        it, key = p["item"], ctx.repo_key(p["item"])
        for err in (answer or {}).get("errors") or []:
            notice(f"plugins: {key}: {err}")
        runs = [r for r in (answer or {}).get("results") or [] if isinstance(r, dict) and isinstance(r.get("result"), dict)]
        if not dry_run:
            with _locked(ctx.root, it, lock):
                fresh = store.get_item(ctx.root, it["id"])
                for r in runs if fresh is not None else []:
                    inst = r.get("instance") or {}
                    r["changes"] = apply(ctx.root, fresh, instance_id(r["plugin"], inst), r["result"], p["job"].event,
                                         dry_run=bool(inst.get("dry_run")))
                    fresh = store.get_item(ctx.root, it["id"]) or fresh
        for r in runs:
            if r["result"].get("error"):
                notice(f'plugins: {instance_id(r["plugin"], r.get("instance") or {})} on {it["id"]}: {r["result"]["error"]}')
        done.append((it, runs))
    return done


def run(ctx: Context, it: dict, event: dict, *, dry_run: bool = False, only: str | None = None,
        anywhere: bool = False, lock: bool = True) -> list | None:
    """Run what `event` fires for the item and, unless dry-run, apply it. `only`
    is a plugin or `<plugin>/<id>`. `[{plugin, instance, result, changes}]`;
    None when there's no host to run it."""
    if host_command() is None:
        notice(NO_NODE)
        return None
    sel = None
    if only:
        key = ctx.repo_key(it)
        sel = {instance_id(p["name"], i) for p, insts in plugin_view(ctx, key) for i in insts
               if only in (p["name"], instance_id(p["name"], i))} if key else set()
    plan = _plan(ctx, Job(it["id"], event, sel, anywhere), dry_run)
    if plan is None:
        return []
    done = _execute(ctx, [plan], dry_run=dry_run, lock=lock)
    return done[0][1] if done else []


@contextlib.contextmanager
def _locked(root: Path, it: dict, lock: bool):
    if lock and sync.enabled(root):
        with sync.locked(root, [it.get("uid") or it["id"]]):
            yield
    else:
        yield


def _record_failure(root: Path, it: dict, iids: list, event: dict, error: str, lock: bool) -> None:
    with _locked(root, it, lock), _updating(root, RUNS_FILE) as runs:
        mine = runs.setdefault(item_key(it), {})
        for iid in iids:
            mine[iid] = {"at": now(), "event": event_label(event), "error": error[:2000]}


def item_key(it: dict) -> str | None:
    """What the run state files key an item by: its uid, which every item gets before its first run."""
    return it.get("uid")


def event_label(event: dict) -> str:
    t = event.get("type")
    if t == "status":
        return f'status {event.get("from")} → {event.get("to")}'
    if t in GIT_TRIGGERS:
        return f'{t} {event.get("branch")}'
    if t == "manual":
        return f'manual {event.get("instance")}'
    return str(t)


# ── applying a result ─────────────────────────────────────────────────────────
def _note_fields(a: dict) -> tuple:
    """(note kind, text, meta fields) for a link, edge or comment attachment."""
    if a["kind"] == "comment":
        return "comment", to_str(a.get("text")), {"jira_account": a.get("author"), "jira_name": a.get("author_name")}
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


def apply(root: Path, it: dict, iid: str, result: dict, event: dict, *, dry_run: bool = False) -> dict:
    """Write one instance's result into the store: links and edges replace what
    it attached before, logs and requests only add, docs never touch one a
    person wrote or edited, and what a person removed is never made again. An
    error, a skip or a dry-run instance changes nothing but the run record.
    Returns counts of what changed."""
    with state_lock(root):
        runs = _read(_state(root, RUNS_FILE))
        changes = _apply(root, it, iid, result, event, dry_run, runs)
        _write(_state(root, RUNS_FILE), runs)
    if any(changes.values()) and sync.enabled(root):
        sync.mark_changed(root, it["id"])
        sync.flag_changes(root)
    return changes


def _apply(root: Path, it: dict, iid: str, result: dict, event: dict, dry_run: bool, runs: dict) -> dict:
    ikey = item_key(it)
    mine = runs.setdefault(ikey, {})
    rec = {"at": now(), "event": event_label(event)}
    log = [to_str(x) for x in result.get("log") or []]
    if result.get("wouldSend"):
        rec["would_send"] = len(result["wouldSend"])
    changes = {"added": 0, "updated": 0, "removed": 0}
    if result.get("error") or result.get("skipped") or dry_run:
        rec.update({k: to_str(result[k])[:2000] for k in ("error", "skipped") if result.get(k)})
        if dry_run and not (result.get("error") or result.get("skipped")):
            rec["dry_run"] = True
            rec["attached"] = [_summary(a) for a in result.get("attached") or [] if isinstance(a, dict)]
    else:
        rec["attached"] = _attach(root, it, iid, result, set((runs.get(REMOVED) or {}).get(ikey) or []),
                                  log, changes, runs)
    if log:
        rec["log"] = log[-LOG_KEPT:]
    mine[iid] = rec
    return changes


def _attach(root: Path, it: dict, iid: str, result: dict, gone: set, log: list, changes: dict, runs: dict) -> list:
    item_uid = it["uid"]
    item_dir = root / it["folder"] / it["id"]
    notes = store.read_entries(item_dir / store.NOTES_DIR)
    present = {e["meta"].get("uid") for e in notes + store.read_entries(item_dir / store.LOG_DIR) if e["meta"].get("uid")}
    by_uid = {e["meta"].get("uid"): e for e in notes if e["meta"].get("uid")}
    kept: set = set()
    linked: set = set()
    wrote_docs: set = set()
    attached = []
    for a in result.get("attached") or []:
        if not isinstance(a, dict) or a.get("kind") not in ("link", "edge", "log", "request", "doc", "comment") or not a.get("key"):
            continue
        kind = a["kind"]
        key = a["key"]
        if kind == "request":
            key = _request_key(it, a, log)
            if key is None:
                continue
        uid = hash_uid("plugin", iid, item_uid, key)
        tag = {"plugin": iid, "plugin_key": a["key"]}
        if kind != "doc" and uid in gone:
            if uid in present:
                kept.add(uid)                # back since a person removed it: left as it is
            else:
                log.append(f'skipped {kind} {a["key"]}: someone removed it from the item')
            continue
        if kind == "link":
            url = to_str(a.get("url"))
            if url in linked or any(e["meta"].get("kind") == "link" and to_str(e["meta"].get("url")) == url
                                    and e["meta"].get("uid") != uid for e in notes):
                log.append(f"skipped link {url}: already linked on the item")
                continue
            linked.add(url)
        if kind in ("link", "edge", "comment"):
            _put_note(root, it, uid, a, tag, by_uid.get(uid), changes)
        elif kind == "log":
            if uid not in present:
                store.add_log(root, it["id"], to_str(a.get("text")), now(), extra=tag, uid=uid)
                changes["added"] += 1
        elif kind == "request":
            if uid not in present:
                _post_request(root, it, to_str(a.get("text")).strip(), tag, uid)
                changes["added"] += 1
        elif kind == "doc":
            name = _put_doc(it, iid, item_dir, a, log, changes)
            if name is None:
                continue
            wrote_docs.add(name)
        if kind != "doc":
            kept.add(uid)
        attached.append(_summary(a))
    stale = [e for e in notes if e["meta"].get("plugin") == iid and e["meta"].get("kind") in REPLACED
             and e["meta"].get("uid") not in kept]
    if stale and sync.enabled(root):
        # Recorded first, so a crash mid-removal still tells the server these were the runner's.
        runs.setdefault(RUNNER, {}).update({e["meta"].get("uid"): item_key(it) for e in stale})
        _write(_state(root, RUNS_FILE), runs)
        sync.mark_changed(root, it["id"])
    for e in stale:
        store.remove_note(root, it["id"], e["id"])
        changes["removed"] += 1
    _drop_docs(it, iid, item_dir, wrote_docs, log, changes)
    return attached


def _put_note(root: Path, it: dict, uid: str, a: dict, tag: dict, e: dict | None, changes: dict) -> None:
    note_kind, text, fields = _note_fields(a)
    fields = {**fields, **tag}
    if e is None:
        if note_kind == "comment":
            # The server maps a known Jira account to its user when the note syncs.
            who = f'jira:{a["author_name"]}' if a.get("author_name") else None
            store.add_note(root, it["id"], text, to_str(a.get("at")) or now(), kind=note_kind, extra=fields, uid=uid, author=who)
        else:
            store.add_note(root, it["id"], text, now(), kind=note_kind, extra=fields, uid=uid)
        changes["added"] += 1
    elif e["text"] != text or e["meta"].get("kind") != note_kind or \
            any(e["meta"].get(k) != v for k, v in fields.items()) or \
            any(k in e["meta"] for k in ("label", "in") if k not in fields):
        meta = {k: v for k, v in e["meta"].items() if k not in ("label", "in")}
        store.rewrite_entry(root, it["id"], store.NOTES_DIR, e["id"], text, {**meta, "kind": note_kind, **fields})
        changes["updated"] += 1


def _request_key(it: dict, a: dict, log: list) -> str | None:
    """`<key>#v<n>`, n the version the request would make; None when it repeats the current request."""
    text = to_str(a.get("text")).strip()
    requests = [n for n in it.get("notes") or [] if n.get("kind") == "ticket-request"]
    current = render.current_request(requests) if requests else None
    if not text or (current is not None and str(current["text"]).strip() == text):
        if text:
            log.append(f'skipped request {a["key"]}: it repeats the current request')
        return None
    version = int((current.get("meta") or {}).get("version") or 1) + 1 if current is not None else 1
    return f'{a["key"]}#v{version}'


def _post_request(root: Path, it: dict, text: str, extra: dict, uid: str) -> None:
    """A new request version, as `todo request --text` posts it."""
    store.add_note(root, it["id"], text, now(), kind="ticket-request", extra=extra, uid=uid)
    if it["status"] != "requested" and not sync.enabled(root):
        store.update_todo(root, it["id"], {"status": "requested"}, now())
        queue(it["id"], {"type": "status", "from": it["status"], "to": "requested"})


def _doc_state(item_dir: Path, iid: str, name: str) -> tuple:
    """(the doc's name if it exists, whether this instance wrote it, whether it's unchanged since)."""
    meta = docs.read_meta(item_dir)
    present = docs.files(item_dir)
    found = docs.find(set(present) | set(meta), name)
    if found is None or found not in present:
        return None, False, False
    e = meta.get(found) or {}
    ours = e.get("plugin") == iid
    return found, ours, ours and docs.sha256_file(present[found]) == e.get("sha256")


def _doc_bytes(a: dict) -> bytes | None:
    """A doc's content as bytes: base64 when the host fetched bytes that aren't text."""
    if a.get("encoding") != "base64":
        return to_str(a["content"]).encode()
    try:
        return base64.b64decode(to_str(a["content"]), validate=True)
    except ValueError:
        return None


def _put_doc(it: dict, iid: str, item_dir: Path, a: dict, log: list, changes: dict) -> str | None:
    name = to_str(a.get("name"))
    why = docs.name_error(name)
    if not why and a.get("unchanged"):
        found, ours, unchanged = _doc_state(item_dir, iid, name)
        if found is not None and ours and unchanged:
            return found
        log.append(f"skipped doc {name}: " + ("edited since the plugin wrote it" if ours else "a doc by that name isn't this plugin's"))
        return found if ours else None
    if why or a.get("content") is None:
        log.append(f"skipped doc {name}: " + (why or "the host returned no content for it"))
        return None
    data = _doc_bytes(a)
    if data is None:
        log.append(f"skipped doc {name}: its content isn't valid base64")
        return None
    found, ours, unchanged = _doc_state(item_dir, iid, name)
    if found is not None and not ours:
        log.append(f"skipped doc {name}: a doc by that name isn't this plugin's")
        return None
    if found is not None and not unchanged:
        log.append(f"skipped doc {name}: edited since the plugin wrote it")
        return found
    version = to_str(a.get("version")) or None
    if found is not None and docs.sha256_file(item_dir / docs.DOCS_DIR / found) == docs.sha256_bytes(data):
        docs.set_plugin_version(item_dir, found, version)
        return found
    written = docs.add(item_dir, it["uid"], name, data, now(), plugin=iid, plugin_version=version)
    changes["updated" if found else "added"] += 1
    return written


def _drop_docs(it: dict, iid: str, item_dir: Path, wrote: set, log: list, changes: dict) -> None:
    for name, e in docs.read_meta(item_dir).items():
        if e.get("plugin") != iid or docs.find(wrote, name) is not None:
            continue
        found, ours, unchanged = _doc_state(item_dir, iid, name)
        if found is None:
            continue
        if not unchanged:
            log.append(f"kept doc {name}: edited since the plugin wrote it")
        elif docs.remove(item_dir, it["uid"], found, now()):
            changes["removed"] += 1


def forget(root: Path, item_uid: str, uid: str) -> None:
    """Never make this plugin entity again on the item: a person removed it."""
    with _updating(root, RUNS_FILE) as runs:
        gone = runs.setdefault(REMOVED, {}).setdefault(item_uid, [])
        if uid not in gone:
            gone.append(uid)
        runs[REMOVED][item_uid] = gone[-REMOVED_KEPT:]


def mark_runner_removes(root: Path, ops: list, synced_uids, local_uids) -> None:
    """Tag the remove ops for notes the runner removed with `plugin: true`, so the
    server lets the plugin make them again; forget the ones the server has."""
    f = _state(root, RUNS_FILE)
    if not _read(f).get(RUNNER):
        return
    with _updating(root, RUNS_FILE) as runs:
        mine = runs.get(RUNNER) or {}
        for op in ops:
            if op.get("op") == "remove" and op.get("uid") in mine:
                op["plugin"] = True
        runs[RUNNER] = {u: k for u, k in mine.items() if u in synced_uids and u not in local_uids}
        if not runs[RUNNER]:
            del runs[RUNNER]


def removed(root: Path, it: dict) -> list:
    return (_read(_state(root, RUNS_FILE)).get(REMOVED) or {}).get(item_key(it)) or []


# ── when plugins run ──────────────────────────────────────────────────────────
def _open_items(root: Path) -> list:
    return [it for it in store.list_todos(root, [store.OPEN, store.DEFERRED]) if is_open(root, it)]


def push_jobs(ctx: Context, seen: dict | None, queued: list) -> tuple:
    """(jobs, tips to save once they ran): a push for each open item branch whose
    tip moved since plugins last saw it, from the ls-remote answers git facts
    saved (and this command's). A repo seen for the first time only records
    its tips; a branch a queued push already covers fires once."""
    root = ctx.root
    state = _read(_state(root, TIPS_FILE))
    views = {k: v for k, v in _read(gitfacts.state_file(root, gitfacts.TIPS_FILE)).items()
             if isinstance(v, dict) and isinstance(v.get("tips"), dict)}
    views.update(seen or {})
    marks = state.get(SEEN) or {}
    fresh = {k: hashlib.sha1(json.dumps(v["tips"], sort_keys=True).encode()).hexdigest() for k, v in views.items()}
    moved = [k for k in views if fresh[k] != marks.get(k)]
    covered = {(j.item_id, j.event.get("branch")) for j in queued if j.event.get("type") == "push"}
    if not moved and not covered:
        return [], {}
    items = _open_items(root)
    tips_now: dict = {}
    jobs = []
    for key in moved:
        tips = views[key]["tips"]
        before = state.get(key)
        after = {}
        for it in items:
            if ctx.repo_key(it) != key:
                continue
            for b in it["branches"]:
                sha = tips.get(b)
                if sha:
                    after[b] = sha
                if before is not None and sha != before.get(b) and (sha or before.get(b)) \
                        and (it["id"], b) not in covered:
                    jobs.append(Job(it["id"], {"type": "push", "branch": b}))
        tips_now[key] = after
    for item_id, b in covered:
        it = next((x for x in items if x["id"] == item_id), None)
        key = ctx.repo_key(it) if it else ""
        sha = ((views.get(key) or {}).get("tips") or {}).get(b) if key else None
        if sha and (key in state or key in tips_now):
            tips_now.setdefault(key, dict(state.get(key) or {}))[b] = sha
    tips_now[SEEN] = {**marks, **{k: fresh[k] for k in moved}}
    return jobs, tips_now


def _save_tips(root: Path, tips_now: dict) -> None:
    if tips_now:
        with _updating(root, TIPS_FILE) as state:
            state.update(tips_now)


def floor_jobs(ctx: Context) -> list:
    """A refresh, narrowed to the due instances, for each open item with an
    instance whose `every:` has passed since it last ran there."""
    root = ctx.root
    with _updating(root, TIPS_FILE) as state:
        if time.time() - state.get("floors_at", 0) < FLOOR_EVERY:
            return []
        state["floors_at"] = time.time()
    runs = _read(_state(root, RUNS_FILE))
    jobs = []
    for it in _open_items(root):
        key = ctx.repo_key(it)
        if not key:
            continue
        if not ctx.any_here(key, it):
            continue
        mine = runs.get(item_key(it)) or {}
        due = {instance_id(p["name"], i) for p, insts in plugin_view(ctx, key) for i in insts
               if duration(p.get("every")) is not None and i.get("enabled") is not False
               and ctx.runs_here(key, p["name"], i, it)
               and _since(mine.get(instance_id(p["name"], i))) >= duration(p["every"])}
        if due:
            jobs.append(Job(it["id"], {"type": "refresh"}, due))
    return jobs


def _since(rec: dict | None) -> float:
    if not rec or not rec.get("at"):
        return float("inf")
    try:
        at = datetime.fromisoformat(str(rec["at"]).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return float("inf")
    return time.time() - at


def run_jobs(ctx: Context, jobs: list, *, lock: bool = True, report: bool = False) -> list:
    """Run the jobs in batches of one host process each, never raising, then
    once more for the events those runs set off. Once PLUGIN_BUDGET seconds
    have gone, the jobs left wait for the next command. `(item, runs)` per job that ran."""
    sys.stdout.flush()
    started = time.monotonic()
    out, done, left = [], set(), []
    for _ in range(2):
        plans = []
        for job in _merged([j if isinstance(j, Job) else Job(*j) for j in jobs]):
            if job.sig() in done:
                continue
            done.add(job.sig())
            it = store.get_item(ctx.root, job.item_id)
            if it is None or not is_open(ctx.root, it):
                continue
            try:
                plan = _plan(ctx, job, False)
            except Exception as e:  # noqa: BLE001 — plugins must never break a command
                notice(f"plugins: {job.item_id}: skipped ({type(e).__name__}: {e})")
                continue
            if plan is not None:
                plans.append(plan)
        if plans and host_command() is None and any(p["payload"] for p in plans):
            notice(NO_NODE)
            return out
        for n in range(0, len(plans), BATCH_JOBS):
            batch = plans[n:n + BATCH_JOBS]
            remaining = PLUGIN_BUDGET - (time.monotonic() - started)
            if n and remaining <= 0:
                left += [p["job"] for p in plans[n:]]
                break
            share = int(max(remaining, MIN_RUN) * 1000 / max(1, sum(1 for p in batch if p["payload"])))
            for p in batch:
                if p["payload"]:
                    p["payload"]["limits"] = {"deadlineMs": share}
            try:
                out += [(it, runs) for it, runs in _execute(ctx, batch, dry_run=False, lock=lock) if runs]
            except Exception as e:  # noqa: BLE001
                notice(f"plugins: skipped ({type(e).__name__}: {e})")
        jobs = _take_queue()
        if not jobs or left:
            left += [j for j in jobs]
            break
    if left:
        _defer(ctx.root, left)
        notice(f"plugins: {len(left)} job(s) wait for the next command")
    if report:
        for it, runs in out:
            for line in run_lines(it, runs):
                print(line)
    return out


def _defer(root: Path, jobs: list) -> None:
    with _updating(root, DEFERRED_FILE) as state:
        state["jobs"] = (state.get("jobs") or []) + [
            {"item": j.item_id, "event": j.event, "only": sorted(j.only) if j.only is not None else None,
             "anywhere": j.anywhere} for j in jobs]


def _deferred(root: Path) -> list:
    """The jobs an earlier command's budget left, taken off the list."""
    f = _state(root, DEFERRED_FILE)
    if not f.exists():
        return []
    with _updating(root, DEFERRED_FILE) as state:
        rows, state["jobs"] = state.get("jobs") or [], []
    return [Job(r["item"], r["event"], None if r.get("only") is None else set(r["only"]), bool(r.get("anywhere")))
            for r in rows if isinstance(r, dict) and r.get("item") and isinstance(r.get("event"), dict)]


def _merged(jobs: list) -> list:
    """One job per item, event and host rule; narrowed ones join, and an un-narrowed one covers them all."""
    out: dict = {}
    for j in jobs:
        k = (j.item_id, json.dumps(j.event, sort_keys=True), j.anywhere)
        if k not in out:
            out[k] = Job(j.item_id, j.event, None if j.only is None else set(j.only), j.anywhere)
        elif out[k].only is not None:
            out[k].only = None if j.only is None else out[k].only | set(j.only)
    return list(out.values())


def run_lines(it: dict, runs: list, where: str = "") -> list:
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
        out.append(f'{it["id"]}: {iid}{where}: {what}')
    return out


def _round_jobs(ctx: Context, seen: dict | None, queued: list) -> list:
    jobs, tips_now = push_jobs(ctx, seen, queued)
    jobs = queued + jobs
    if not off():
        jobs += floor_jobs(ctx)
        run_jobs(ctx, jobs)
    _save_tips(ctx.root, tips_now)
    return jobs


def after_command(root: Path, seen: dict | None = None) -> None:
    """The plugins a command set off, once its own output is out: its status
    moves and new branches, the pushes git facts saw, due floors, and whatever
    an earlier command's budget left. Tips advance even with plugins off, so
    turning them on later doesn't replay old pushes."""
    if root is None or not root.is_dir():
        _take_queue()
        return
    try:
        queued = _take_queue()
        if off():
            queued = []
        else:
            queued = _deferred(root) + queued
        _round_jobs(Context(root, seen=seen), seen, queued)
    except Exception as e:  # noqa: BLE001
        notice(f"plugins: skipped ({type(e).__name__}: {e})")


# ── reading results ───────────────────────────────────────────────────────────
def records(root: Path, it: dict) -> dict:
    """The item's last run per instance id."""
    return _read(_state(root, RUNS_FILE)).get(item_key(it)) or {}


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
