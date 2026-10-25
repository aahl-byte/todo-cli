"""HTTP client for a team server, and the per-store sync config.

`.TODO/.sync/config.json` holds `{url, project, deploy_step}`; the token for a
url lives in ~/.todo/config.yaml under `tokens:`.
"""

from __future__ import annotations

import json
import secrets
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import identity

SYNC_DIR = ".sync"
CONFIG_FILE = "config.json"
DEFAULT_TIMEOUT = 1.5
TRANSFER_TIMEOUT = 30            # a doc's bytes, up and down


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


def _explain(status: int, detail) -> str:
    """The server's error, with what to do about the two 401s: the sign-in
    gate in front of the server, and the server's own token check."""
    if status == 401 and detail == "sign-in required":
        return ("sign-in required: a sign-in gate in front of the server blocked this request; "
                "its /api path isn't open to the CLI")
    if status == 401 and detail == "unauthorized":
        return "unauthorized: the token is wrong or revoked; run `todo login <url>` for a new one"
    return str(detail)


class Remote:
    def __init__(self, url: str, token: str | None, timeout: float = DEFAULT_TIMEOUT):
        self.url = url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def request(self, method: str, path: str, body=None, timeout: float | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("content-type", "application/json")
        if self.token:
            req.add_header("authorization", f"Bearer {self.token}")
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}").get("error") or e.reason
            except ValueError:
                detail = e.reason
            raise RemoteError(f"{self.url}: {e.code} {_explain(e.code, detail)}", e.code) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            reason = getattr(e, "reason", e)
            raise RemoteError(f"{self.url} unreachable ({reason})") from None

    def _send(self, req: urllib.request.Request, timeout: float) -> bytes:
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read() or b"{}").get("error") or e.reason
            except ValueError:
                detail = e.reason
            raise RemoteError(f"{req.full_url.split('?')[0]}: {e.code} {_explain(e.code, detail)}", e.code) from None
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise RemoteError(f"{self.url} unreachable ({getattr(e, 'reason', e)})") from None

    def _docs_path(self, project: str, rest: str = "") -> str:
        return f"/api/projects/{urllib.parse.quote(project)}/docs{rest}"

    def doc_upload(self, project: str, item_uid: str, name: str, data: bytes) -> str:
        """Send a doc's bytes where the server says (its bucket, or itself), and
        return the file key to record it under."""
        t = self.request("POST", self._docs_path(project, "/upload"),
                         {"item_uid": item_uid, "name": name, "size": len(data)})
        url = urllib.parse.urljoin(self.url + "/", t["url"])
        body, ctype = multipart(t.get("fields") or {}, name, data, t["content_type"])
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("content-type", ctype)
        if self.token and _origin(url) == _origin(self.url):
            req.add_unredirected_header("authorization", f"Bearer {self.token}")
        self._send(req, max(self.timeout, TRANSFER_TIMEOUT))
        return t["key"]

    def doc_record(self, project: str, record: dict) -> dict:
        """`{status: applied|conflict, doc}`: the doc as the server has it now.
        The server hashes the stored bytes first, so this gets a transfer's time."""
        return self.request("PUT", self._docs_path(project), record, max(self.timeout, TRANSFER_TIMEOUT))

    def doc_list(self, project: str, item: str | None = None, after: str | None = None) -> dict:
        """A page of the project's doc records (or one item's): `{docs, next}`."""
        query = urllib.parse.urlencode({k: v for k, v in (("item", item), ("after", after)) if v})
        return self.request("GET", self._docs_path(project, f"?{query}" if query else ""))

    def doc_remove(self, project: str, uid: str, base: str) -> dict:
        query = urllib.parse.urlencode({"base": base})
        return self.request("DELETE", self._docs_path(project, f"/{urllib.parse.quote(uid)}?{query}"))

    def doc_bytes(self, project: str, uid: str) -> bytes:
        req = urllib.request.Request(self.url + self._docs_path(project, f"/{urllib.parse.quote(uid)}"))
        if self.token:
            # Not sent on to the bucket a read may redirect to.
            req.add_unredirected_header("authorization", f"Bearer {self.token}")
        return self._send(req, max(self.timeout, TRANSFER_TIMEOUT))

    def me(self) -> dict:
        return self.request("GET", "/api/me")

    def login_start(self, label: str) -> dict:
        return self.request("POST", "/api/login/start", {"label": label})

    def login_poll(self, device_code: str) -> dict:
        return self.request("POST", "/api/login/poll", {"device_code": device_code})

    def ensure_project(self, key: str) -> dict:
        return self.request("POST", "/api/projects", {"key": key})

    def push(self, project: str, ops: list) -> list:
        path = f"/api/projects/{urllib.parse.quote(project)}/ops"
        return self.request("POST", path, {"ops": ops}).get("results") or []

    def changes(self, project: str, since: int, limit: int = 500) -> dict:
        path = f"/api/projects/{urllib.parse.quote(project)}/changes?since={since}&limit={limit}&docs=1"
        return self.request("GET", path)

    def checkout(self, project: str, dir_: str, repo: str) -> dict:
        path = f"/api/projects/{urllib.parse.quote(project)}/checkout"
        return self.request("POST", path, {"dir": dir_, "repo": repo})

    def git_facts(self, project: str, facts: list) -> dict:
        path = f"/api/projects/{urllib.parse.quote(project)}/git-facts"
        return self.request("POST", path, {"facts": facts})

    def run_action(self, project: str, item: str, action: str) -> dict:
        path = f"/api/projects/{urllib.parse.quote(project)}/actions/run"
        return self.request("POST", path, {"item": item, "action": action})

    def inbox(self, everything: bool = False) -> dict:
        return self.request("GET", "/api/inbox" + ("?all=1" if everything else ""))

    def mark_read(self, ids: list) -> dict:
        return self.request("POST", "/api/inbox/read", {"ids": ids})


def _origin(url: str) -> tuple:
    u = urllib.parse.urlsplit(url)
    return (u.scheme, u.netloc)


def multipart(fields: dict, filename: str, data: bytes, content_type: str) -> tuple:
    """A multipart/form-data body: `fields`, then the file as `file`, last
    (S3's presigned POST ignores anything after it)."""
    boundary = "----todo" + secrets.token_hex(12)
    out = bytearray()
    for k, v in fields.items():
        out += (f'--{boundary}\r\ncontent-disposition: form-data; name="{k}"\r\n\r\n{v}\r\n').encode()
    safe = filename.encode("utf-8", "replace").decode().replace('"', "_").replace("\r", "_").replace("\n", "_")
    out += (f'--{boundary}\r\ncontent-disposition: form-data; name="file"; filename="{safe}"\r\n'
            f"content-type: {content_type}\r\n\r\n").encode()
    out += data + f"\r\n--{boundary}--\r\n".encode()
    return bytes(out), f"multipart/form-data; boundary={boundary}"


def remote_for(root: Path, timeout: float = DEFAULT_TIMEOUT) -> Remote | None:
    cfg = sync_config(root)
    if cfg is None:
        return None
    return Remote(cfg["url"], token_for(cfg["url"]), timeout)
