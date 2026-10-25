"""End to end: the built Next.js server runs a repo's plugins. GitHub and
Watchtower are one local fake. Creating an item on a branch links its PR through
the shipped pr-link plugin; moving it to review runs the repo's watchtower-session
code plugin in the host's worker. Both attachments reach /changes.

Needs `cd server && npm install && npm run build`; skipped otherwise."""

import base64
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SERVER = Path(__file__).resolve().parent.parent / "server"
FIXTURES = SERVER / "tests" / "fixtures" / "plugins"

pytestmark = pytest.mark.skipif(
    not (SERVER / ".next" / "BUILD_ID").is_file() or shutil.which("npx") is None,
    reason="server not built (cd server && npm install && npm run build)")


def _port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _fake(port: int) -> dict:
    """GitHub's answers for acme/web and Watchtower's for one new session, under /wt."""
    plugins = (FIXTURES / "watchtower.yaml").read_text().replace("http://leaf-rain:10011", f"http://127.0.0.1:{port}/wt")
    content = lambda text: {"content": base64.b64encode(text.encode()).decode()}  # noqa: E731
    return {
        ("GET", "/repos/acme/web"): {"default_branch": "main"},
        ("GET", "/repos/acme/web/branches/main"): {"commit": {"sha": "s1"}},
        ("GET", "/repos/acme/web/contents/.todo-plugins/plugins.yaml?ref=s1"): content(plugins),
        ("GET", "/repos/acme/web/contents/.todo-plugins/watchtower-session.js?ref=s1"):
            content((FIXTURES / "watchtower-session.js").read_text()),
        ("GET", "/repos/acme/web/pulls?head=acme%3Afeat%2Fx&state=all"):
            [{"number": 5, "title": "Login", "html_url": "https://github.com/acme/web/pull/5"}],
        ("GET", "/wt/api/roster"): {"sessions": []},
        ("POST", "/wt/api/sessions"): {"id": "s9"},
        ("GET", "/wt/api/sessions/s9"): {"state": "active", "status": "idle"},
        ("POST", "/wt/api/sessions/s9/message"): {},
    }


@pytest.fixture
def fake():
    port = _port()
    answers = _fake(port)
    seen = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("content-length") or 0)
            body = self.rfile.read(length) if length else b""
            seen.append((self.command, self.path, body.decode() or None))
            hit = answers.get((self.command, self.path))
            out = json.dumps(hit if hit is not None else {"message": "not found"}).encode()
            self.send_response(200 if hit is not None else 404)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        do_GET = do_POST = _answer

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{port}", seen
    finally:
        httpd.shutdown()


@pytest.fixture
def server(tmp_path, fake):
    base, _ = fake
    env = {**os.environ, "TODO_PGLITE": str(tmp_path / "pglite"), "TODO_FILES_DIR": str(tmp_path / "files"),
           "GITHUB_TOKEN": "gh-test", "GITHUB_API_URL": base, "TODO_PLUGIN_ALLOW_HOSTS": base.split("//", 1)[1]}
    out = subprocess.run(["npx", "tsx", "scripts/user-add.ts", "alice"], cwd=SERVER, env=env,
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    token = out.stdout.strip().split(": ", 1)[1]
    port = _port()
    log_path = tmp_path / "server.log"
    log = open(log_path, "w")
    # Started from elsewhere, so the worker must come from the build, not from a path relative to the working directory.
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    proc = subprocess.Popen([str(SERVER / "node_modules" / ".bin" / "next"), "start", str(SERVER), "-p", str(port), "-H", "127.0.0.1"],
                            cwd=elsewhere, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url + "/api/me", timeout=2)
        except urllib.error.HTTPError:
            break
        except OSError:
            time.sleep(0.5)
    else:
        _stop(proc)
        pytest.fail("server did not start: " + log_path.read_text())
    try:
        yield url, token, log_path
    finally:
        _stop(proc)
        log.close()


def _stop(proc):
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def _call(url, token, path, body=None):
    req = urllib.request.Request(url + path, method="GET" if body is None else "POST",
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read())


def _changes(url, token):
    return _call(url, token, "/api/projects/p/changes?since=0&limit=1000")["changes"]


def _wait_for(check, what, log_path, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        found = check()
        if found:
            return found
        time.sleep(0.5)
    pytest.fail(f"{what} never appeared; server log:\n{log_path.read_text()}")


def test_built_server_runs_shipped_and_code_plugins(server, fake):
    url, token, log_path = server
    _, seen = fake
    _call(url, token, "/api/projects", {"key": "p"})
    req = urllib.request.Request(url + "/api/projects/p/plugins/repos", method="PUT", data=json.dumps({"repos": ["acme/web"]}).encode(),
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=30).close()
    [created] = _call(url, token, "/api/projects/p/ops", {"ops": [{
        "op_id": "c1", "op": "create", "entity": "item", "uid": "I1", "item_uid": "I1",
        "data": {"id": "fix-login", "title": "Fix login", "status": "in-progress", "created": "2026-10-25T00:00:00Z",
                 "extra": {"repo": "acme/web", "branches": ["feat/x"]}}}]})["results"]
    assert created["status"] == "applied"

    def link():
        return [c for c in _changes(url, token)
                if c["entity"] == "note" and (c.get("data") or {}).get("meta", {}).get("url") == "https://github.com/acme/web/pull/5"]
    [note] = _wait_for(link, "the PR link", log_path)
    assert note["data"]["meta"]["plugin"] == "pr-link/default"

    [moved] = _call(url, token, "/api/projects/p/ops", {"ops": [{
        "op_id": "s1", "op": "set", "entity": "item", "uid": "I1", "item_uid": "I1", "data": {"status": "review"},
        "base": {"status": created["versions"]["status"]}}]})["results"]
    assert moved["status"] == "applied" and not moved.get("rejected")

    def started():
        return [c for c in _changes(url, token)
                if c["entity"] == "log" and "started Watchtower session todo: fix-login: s9" in ((c.get("data") or {}).get("text") or "")]
    _wait_for(started, "the Watchtower log line", log_path)
    assert ("POST", "/wt/api/sessions/s9/message", json.dumps({"text": "/review fix-login", "from": "todo"}, separators=(",", ":"))) in seen
