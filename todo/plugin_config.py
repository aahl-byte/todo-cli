"""A repo's plugin config as this host reads it: its deploy branches, the
connections its custom plugins call, and its plugins, each shipped one switched
on as `{use: shipped}` and each custom one in full.

- A synced store gets it from the server with the instances and grants the
  server keeps, cached in `.sync/plugins.json`.
- A local-only store keeps it in `.TODO/.plugins.yaml`, one map per repo
  (`track`, `connections`, `plugins`, and `instances` and `grants` beside
  them), with a code plugin's file under `.TODO/.plugins/<owner>/<name>/`.
"""

from __future__ import annotations

import contextlib
import time
from pathlib import Path

from . import gitfacts, remote, statelock, sync, yamlio
from .remote import RemoteError, sync_config

LOCAL_FILE = ".plugins.yaml"
CODE_DIR = ".plugins"
CACHE_FILE = "plugins.json"
CACHE_EVERY = 60                    # seconds a synced store trusts its cached config
RETRY_EVERY = 60                    # seconds before a failed fetch of it is tried again
STALE_AFTER = 3600                  # a cached config this old, while the server fails, can't be trusted
CONFIG_KEYS = ("track", "connections", "plugins")


class ConfigError(Exception):
    """The config can't be changed as asked."""


def _plain(v):
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def _strs(v) -> list:
    return [str(s) for s in v if isinstance(s, str)] if isinstance(v, list) else []


def norm(raw) -> dict:
    """The server's answer for a repo, or a cached one, with every key present."""
    raw = raw if isinstance(raw, dict) else {}
    inst = raw.get("instances") if isinstance(raw.get("instances"), dict) else {}
    grants = raw.get("grants") if isinstance(raw.get("grants"), dict) else {}
    config = raw.get("config")
    if not (isinstance(config, dict) and isinstance(config.get("text"), str)):
        config = None
    else:
        code = config.get("code") if isinstance(config.get("code"), dict) else {}
        config = {"text": config["text"], "code": {str(k): v for k, v in code.items() if isinstance(v, str)}}
    return {"instances": {str(k): [i for i in v if isinstance(i, dict)] for k, v in inst.items() if isinstance(v, list)},
            "grants": {str(k): [str(g) for g in v] for k, v in grants.items() if isinstance(v, list)},
            "plugins": [p for p in raw.get("plugins") or [] if isinstance(p, dict)],
            "secrets": _strs(raw.get("secrets")), "host_secrets": _strs(raw.get("host_secrets")),
            "runs": raw.get("runs") if isinstance(raw.get("runs"), dict) else {},
            "config": config, "track": _strs(raw.get("track"))}


# ── a local-only store ────────────────────────────────────────────────────────
def local_file(root: Path) -> Path:
    return root / LOCAL_FILE


def code_dir(root: Path, key: str) -> Path:
    return root / CODE_DIR / key


def read_local(root: Path, notice=None) -> dict:
    f = local_file(root)
    if not f.is_file():
        return {}
    try:
        data = _plain(yamlio.read(f) or {})
    except Exception as e:  # noqa: BLE001 — an unreadable file holds nothing
        if notice:
            notice(f"plugins: {f} isn't readable YAML ({e})")
        return {}
    return data if isinstance(data, dict) else {}


def local_entry(root: Path, key: str, notice=None) -> dict:
    entry = read_local(root, notice).get(key)
    return entry if isinstance(entry, dict) else {}


def local_config(root: Path, key: str, notice=None) -> dict:
    """`{text, code}` for the host: the repo's map less its instances and grants, and each code plugin's file by plugin name."""
    entry = local_entry(root, key, notice)
    doc = {k: entry[k] for k in CONFIG_KEYS if k in entry}
    code = {}
    plugins = entry.get("plugins") if isinstance(entry.get("plugins"), dict) else {}
    for name, p in plugins.items():
        f = p.get("code") if isinstance(p, dict) else None
        if not isinstance(f, str) or ".." in Path(f).parts or Path(f).is_absolute():
            continue
        path = code_dir(root, key) / f
        if path.is_file():
            code[str(name)] = path.read_text()
    return {"text": yamlio.dump(yamlio.yaml(), doc) if doc else "{}\n", "code": code}


@contextlib.contextmanager
def editing_local(root: Path, key: str):
    """The repo's map in `.TODO/.plugins.yaml`, written back on the way out; a repo left empty is dropped."""
    with statelock.locked(root):
        data = read_local(root)
        entry = data.get(key) if isinstance(data.get(key), dict) else {}
        yield entry
        if entry:
            data[key] = entry
        else:
            data.pop(key, None)
        yamlio.write_atomic(local_file(root), yamlio.dump(yamlio.yaml(), data))


# ── a synced store ────────────────────────────────────────────────────────────
def _cache(root: Path) -> Path:
    return gitfacts.state_file(root, CACHE_FILE)


@contextlib.contextmanager
def updating_cache(root: Path):
    with statelock.locked(root):
        data = gitfacts.read_json(_cache(root))
        yield data
        statelock.write_json(_cache(root), data)


def synced(root: Path, key: str, client=None, project: str | None = None, fresh: bool = False, strict: bool = False) -> dict:
    """The server's answer for the repo: cached for CACHE_EVERY seconds (unless `fresh`), its last good one while the
    server fails, marked `stale` once that's older than STALE_AFTER. `strict` asks the server now and raises RemoteError
    when it doesn't answer, for a change made on top of the answer."""
    got = gitfacts.read_json(_cache(root)).get(key) or {}
    failing = {**norm(got), "stale": time.time() - got.get("at", 0) > STALE_AFTER}
    if not strict and time.time() - got.get("failed_at", 0) < RETRY_EVERY:
        return failing
    if not (fresh or strict) and time.time() - got.get("at", 0) < CACHE_EVERY:
        return norm(got)
    if client is None and not sync.offline():
        client = remote.remote_for(root)
    fetch = getattr(client, "plugins", None)
    if fetch is None:
        if strict:
            raise RemoteError("this store's server can't be reached (offline)")
        return norm(got)
    try:
        answer = norm(fetch(project or (sync_config(root) or {}).get("project"), key))
    except RemoteError as e:
        if e.status != 404:
            with updating_cache(root) as cache:
                cache[key] = {**(cache.get(key) or {}), "failed_at": time.time()}
            if strict:
                raise
            return failing
        answer = norm({})
    with updating_cache(root) as cache:
        cache[key] = {**answer, "at": time.time()}
    return answer


# ── deploy branches and shipped plugins, either way ───────────────────────────
def deploy_branches(root: Path, key: str, client=None) -> list:
    """The repo's deploy branches: the server's on a synced store, `.TODO/.plugins.yaml`'s on a local-only one."""
    if not key or root is None or not root.is_dir():
        return []
    if sync_config(root) is None:
        return _strs(local_entry(root, key).get("track"))
    return synced(root, key, client)["track"]


def _remote(root: Path):
    if sync.offline():
        raise RemoteError("this store's server can't be reached (offline)")
    r = remote.remote_for(root)
    if r is None:
        raise RemoteError("this store has no server")
    return r


def _forget_cached(root: Path, key: str) -> None:
    with updating_cache(root) as cache:
        cache.pop(key, None)


def set_deploy_branches(root: Path, key: str, branches: list) -> list:
    """Replace the repo's deploy branches; the list as stored."""
    cfg = sync_config(root)
    if cfg:
        out = _remote(root).put_plugin_config(cfg["project"], key, track=branches)
        _forget_cached(root, key)
        return _strs((out.get("config") or {}).get("track"))
    with editing_local(root, key) as entry:
        if branches:
            entry["track"] = list(branches)
        else:
            entry.pop("track", None)
    return list(branches)


def set_shipped(root: Path, key: str, name: str, on: bool) -> None:
    """Switch a shipped plugin on or off for the repo; its instances stay either way."""
    cfg = sync_config(root)
    if cfg:
        _remote(root).put_plugin_config(cfg["project"], key, **({"enable": name} if on else {"disable": name}))
        _forget_cached(root, key)
        return
    with editing_local(root, key) as entry:
        plugins = entry.get("plugins") if isinstance(entry.get("plugins"), dict) else {}
        if on:
            if isinstance(plugins.get(name), dict) and plugins[name].get("use") is None:
                raise ConfigError(f"{key} has a custom plugin named {name}; rename it first")
            plugins[name] = {"use": "shipped"}
        else:
            plugins.pop(name, None)
        if plugins:
            entry["plugins"] = plugins
        else:
            entry.pop("plugins", None)
