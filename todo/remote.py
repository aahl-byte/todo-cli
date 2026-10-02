"""HTTP client for a team server, and the per-store sync config.

`.TODO/.sync/config.json` holds `{url, project, deploy_step}`; the token for a
url lives in ~/.todo/config.yaml under `tokens:`.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import identity

SYNC_DIR = ".sync"
CONFIG_FILE = "config.json"
DEFAULT_TIMEOUT = 1.5


class RemoteError(Exception):
    """The server couldn't be reached, or refused the request."""

    def __init__(self, msg: str, status: int | None = None):
        super().__init__(msg)
        self.status = status


def sync_dir(root: Path) -> Path:
    return root / SYNC_DIR


def sync_config(root: Path) -> dict | None:
    f = sync_dir(root) / CONFIG_FILE
    if not f.is_file():
        return None
    try:
        data = json.loads(f.read_text())
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("url") and data.get("project") else None


def save_sync_config(root: Path, data: dict) -> None:
    from .yamlio import write_atomic

    d = sync_dir(root)
    d.mkdir(exist_ok=True)
    write_atomic(d / CONFIG_FILE, json.dumps(data, indent=2) + "\n")


def token_for(url: str) -> str | None:
    tokens = identity.load_config().get("tokens") or {}
    return tokens.get(url.rstrip("/")) if isinstance(tokens, dict) else None


def save_login(url: str, handle: str, token: str) -> None:
    cfg = identity.load_config()
    tokens = dict(cfg.get("tokens") or {})
    tokens[url.rstrip("/")] = token
    cfg["tokens"] = tokens
    cfg["user"] = handle
    identity.save_config(cfg)


class Remote:
    def __init__(self, url: str, token: str | None, timeout: float = DEFAULT_TIMEOUT):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, body=None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}").get("error") or e.reason
            except ValueError:
                detail = e.reason
            raise RemoteError(f"{self.url}: {e.code} {detail}", e.code) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            reason = getattr(e, "reason", e)
            raise RemoteError(f"{self.url} unreachable ({reason})") from None

    def me(self) -> dict:
        return self.request("GET", "/api/me")

    def ensure_project(self, key: str) -> dict:
        return self.request("POST", "/api/projects", {"key": key})

    def push(self, project: str, ops: list) -> list:
        path = f"/api/projects/{urllib.parse.quote(project)}/ops"
        return self.request("POST", path, {"ops": ops}).get("results") or []

    def changes(self, project: str, since: int, limit: int = 500) -> dict:
        path = f"/api/projects/{urllib.parse.quote(project)}/changes?since={since}&limit={limit}"
        return self.request("GET", path)

    def inbox(self, everything: bool = False) -> dict:
        return self.request("GET", "/api/inbox" + ("?all=1" if everything else ""))

    def mark_read(self, ids: list) -> dict:
        return self.request("POST", "/api/inbox/read", {"ids": ids})


def remote_for(root: Path, timeout: float = DEFAULT_TIMEOUT) -> Remote | None:
    cfg = sync_config(root)
    if cfg is None:
        return None
    return Remote(cfg["url"], token_for(cfg["url"]), timeout)
