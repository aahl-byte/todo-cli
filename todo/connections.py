"""Connections plugins call, and this host's credentials for them.

Host-wide connections live in ~/.todo/connections.yaml as
`{connections: {<name>: {http: {url, auth}} | {mcp: {url} | {command, args}}}}`;
`github` is built in. A repo's plugin config declares its own (on the server's
Settings → Automation, or in `.TODO/.plugins.yaml` on a local-only store), and
one of the same name overrides the host's.

Secrets live in ~/.todo/credentials.json (mode 0600), keyed
`<owner/name>/<connection>` for a repo's connections and `*/<connection>` for
the host's. A repo connection only ever gets its repo's secret.
"""

from __future__ import annotations

import base64
import contextlib
import json
import os
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from . import identity, yamlio

CONNECTIONS_FILE = "connections.yaml"
CREDENTIALS_FILE = "credentials.json"
CREDENTIALS_LOCK = ".credentials.lock"
HOST = "*"
GITHUB = "github"
BUILT_IN = {GITHUB: {"http": {"url": "https://api.github.com", "auth": "bearer"}}}
AUTHS = ("bearer", "basic")
TEST_TIMEOUT = 10


def _home() -> Path:
    return identity.config_path().parent


def _file_connections() -> dict:
    f = _home() / CONNECTIONS_FILE
    if not f.is_file():
        return {}
    try:
        data = yamlio.read(f) or {}
    except Exception:  # noqa: BLE001 — an unreadable file declares nothing
        return {}
    conns = data.get("connections") if isinstance(data, dict) else None
    return {str(k): _plain(v) for k, v in conns.items() if isinstance(v, dict)} if isinstance(conns, dict) else {}


def _plain(v):
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_plain(x) for x in v]
    return v


def host_connections() -> dict:
    """The host's connections: the built-in ones, then ~/.todo/connections.yaml over them."""
    return {**BUILT_IN, **_file_connections()}


def host_source(name: str) -> str | None:
    if name in _file_connections():
        return f"~/.todo/{CONNECTIONS_FILE}"
    return "built in" if name in BUILT_IN else None


def auth_error(auth: str | None) -> str | None:
    if auth is None or auth in AUTHS or (auth.startswith("header:") and len(auth) > len("header:")):
        return None
    return f"--auth is bearer, basic or header:<name>, not {auth}"


def save_connection(name: str, definition: dict) -> None:
    f = _home() / CONNECTIONS_FILE
    data = {}
    if f.is_file():
        try:
            data = _plain(yamlio.read(f) or {})
        except Exception:  # noqa: BLE001
            data = {}
    conns = data.get("connections") if isinstance(data.get("connections"), dict) else {}
    conns[name] = definition
    data["connections"] = conns
    f.parent.mkdir(parents=True, exist_ok=True)
    yamlio.write_atomic(f, yamlio.dump(yamlio.yaml(), data))


# ── credentials ───────────────────────────────────────────────────────────────
def cred_key(name: str, repo: str | None = None) -> str:
    return f"{repo or HOST}/{name}"


class CredentialsError(Exception):
    """The credentials file can't be read, so it isn't written either."""


def cred_file() -> Path:
    return _home() / CREDENTIALS_FILE


def load_credentials(strict: bool = False) -> dict:
    """The stored secrets; a damaged file reads as none, or raises with `strict`."""
    f = cred_file()
    try:
        data = json.loads(f.read_text())
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        if strict:
            raise CredentialsError(f"{f} can't be read ({e}); fix or remove it first") from None
        return {}
    if not isinstance(data, dict):
        if strict:
            raise CredentialsError(f"{f} isn't a JSON object; fix or remove it first")
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str)}


@contextlib.contextmanager
def _cred_lock():
    try:
        import fcntl
    except ImportError:              # Windows: no flock
        yield
        return
    lock = _home() / CREDENTIALS_LOCK
    lock.parent.mkdir(parents=True, exist_ok=True)
    with open(lock, "a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        yield


def save_credential(key: str, secret: str) -> None:
    f = cred_file()
    f.parent.mkdir(parents=True, exist_ok=True)
    with _cred_lock():
        creds = {**load_credentials(strict=True), key: secret}
        fd, tmp = tempfile.mkstemp(dir=f.parent, prefix=f".{f.name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as out:
                json.dump(creds, out, indent=2, sort_keys=True)
            os.chmod(tmp, 0o600)
            os.replace(tmp, f)
        except BaseException:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
            raise


def _github_fallback() -> str | None:
    from .gitfacts import github_token
    return github_token()


def secrets_for(repo: str) -> dict:
    """`{repo, host}`: this host's secrets for `repo`'s connections and for its own, by connection name."""
    creds = load_credentials()
    prefix = f"{repo}/"
    out = {"repo": {k[len(prefix):]: v for k, v in creds.items() if repo and k.startswith(prefix)},
           "host": {k[len(HOST) + 1:]: v for k, v in creds.items() if k.startswith(HOST + "/")}}
    if GITHUB not in out["host"]:
        tok = _github_fallback()
        if tok:
            out["host"][GITHUB] = tok
    return out


def secret_source(name: str, repo: str | None) -> str | None:
    """Where this host's secret for the connection comes from, or None when it has none."""
    creds = load_credentials()
    if cred_key(name, repo) in creds:
        return f"~/.todo/{CREDENTIALS_FILE}"
    if repo is None and name == GITHUB:
        if os.environ.get("GITHUB_TOKEN", "").strip():
            return "GITHUB_TOKEN"
        if _github_fallback():
            return "gh auth token"
    return None


# ── testing a connection ──────────────────────────────────────────────────────
def auth_headers(auth: str | None, secret: str | None) -> dict:
    if not auth or not secret:
        return {}
    if auth == "bearer":
        return {"authorization": f"Bearer {secret}"}
    if auth == "basic":
        return {"authorization": "Basic " + base64.b64encode(secret.encode()).decode()}
    return {auth[len("header:"):]: secret}


def test(definition: dict, secret: str | None) -> tuple:
    """(ok, what happened) from one read-only call: GET on an http base URL, MCP initialize on an MCP URL."""
    if "http" in definition:
        http = definition["http"] or {}
        if http.get("auth") and not secret:
            return False, "no secret on this host (todo connection auth)"
        req = urllib.request.Request(str(http.get("url", "")).rstrip("/") + "/", method="GET",
                                     headers={"accept": "application/json", "user-agent": "todo-plugin-host",
                                              **auth_headers(http.get("auth"), secret)})
    elif "mcp" in definition and (definition["mcp"] or {}).get("url"):
        body = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                           "clientInfo": {"name": "todo", "version": "1"}}}
        headers = {"content-type": "application/json", "accept": "application/json, text/event-stream"}
        if secret:
            headers["authorization"] = f"Bearer {secret}"
        req = urllib.request.Request(definition["mcp"]["url"], data=json.dumps(body).encode(), method="POST",
                                     headers=headers)
    else:
        return False, "a command connection is checked when a plugin runs it"
    try:
        with urllib.request.urlopen(req, timeout=TEST_TIMEOUT) as resp:
            return True, f"{resp.status} from {req.full_url}"
    except urllib.error.HTTPError as e:
        why = "not authorized" if e.code in (401, 403) else "answered"
        return e.code not in (401, 403) and e.code < 500, f"{why}: {e.code} from {req.full_url}"
    except (urllib.error.URLError, OSError, ValueError) as e:
        return False, f"unreachable: {getattr(e, 'reason', e)}"
