"""End to end: the built Next.js server on PGlite, two CLI users syncing through
it. Dev A goes offline while QA B takes the item into QA and comments; when A
reconnects, A's note lands, A's stale status is rejected and logged, and A
ends with B's state.

Needs `cd server && npm install && npm run build`; skipped otherwise."""

import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from todo import store

SERVER = Path(__file__).resolve().parent.parent / "server"

pytestmark = pytest.mark.skipif(
    not (SERVER / ".next" / "BUILD_ID").is_file() or shutil.which("npx") is None,
    reason="server not built (cd server && npm install && npm run build)")


def _port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path):
    data = tmp_path / "pglite"
    env = {**os.environ, "TODO_PGLITE": str(data)}
    tokens = {}
    for handle in ("alice", "bob"):
        out = subprocess.run(["npx", "tsx", "scripts/user-add.ts", handle], cwd=SERVER, env=env,
                             capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        tokens[handle] = out.stdout.strip().split(": ", 1)[1]
    port = _port()
    log = open(tmp_path / "server.log", "w")
    proc = subprocess.Popen(["npx", "next", "start", "-p", str(port), "-H", "127.0.0.1"],
                            cwd=SERVER, env=env, stdout=log, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}"
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url + "/api/me", timeout=2)
        except urllib.error.HTTPError:
            break                      # 401: up and answering
        except OSError:
            time.sleep(0.5)
    else:
        proc.kill()
        pytest.fail("server did not start: " + (tmp_path / "server.log").read_text())
    yield url, tokens
    proc.terminate()
    try:
        proc.wait(10)
    except subprocess.TimeoutExpired:
        proc.kill()
    log.close()


def cli(home: Path, cwd: Path, *argv, offline=False):
    env = {k: v for k, v in os.environ.items() if k not in ("TODO_USER", "CLAUDECODE")}
    env.update(HOME=str(home), TODO_VIA="human")
    if offline:
        env["TODO_OFFLINE"] = "1"
    out = subprocess.run([sys.executable, "-c", "from todo.cli import main; main()", *argv],
                         cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, f"todo {' '.join(argv)}\n{out.stdout}\n{out.stderr}"
    return out


def test_offline_dev_and_qa_converge(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]

    cli(ha, ra, "add", "Login bug")
    cli(ha, ra, "assign", "login-bug", "--qa", "bob")
    cli(ha, ra, "review", "login-bug")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    root_b = (rb / ".TODO").resolve()
    assert store.resolve_item(root_b, "login-bug")["status"] == "review"

    cli(hb, rb, "ready-qa", "login-bug")
    cli(hb, rb, "qa", "login-bug")
    cli(hb, rb, "comment", "login-bug", "testing on Safari now")

    cli(ha, ra, "start", "login-bug", offline=True)
    cli(ha, ra, "note", "login-bug", "offline: found the cookie bug", offline=True)
    out = cli(ha, ra, "sync")
    assert "1 rejected" in out.stdout

    it = store.resolve_item((ra / ".TODO").resolve(), "login-bug")
    assert it["status"] == "in-qa"
    texts = [n["text"] for n in it["notes"]]
    assert "testing on Safari now" in texts
    assert "offline: found the cookie bug" in texts
    assert any("offline status → in-progress not applied; bob set in-qa" in e["text"] for e in it["log"])
    assert [(h["from"], h["to"]) for h in it["history"]] == [
        ("todo", "review"), ("review", "ready-for-qa"), ("ready-for-qa", "in-qa")]

    cli(hb, rb, "sync")
    itb = store.resolve_item(root_b, "login-bug")
    assert "offline: found the cookie bug" in [n["text"] for n in itb["notes"]]
    box = cli(ha, ra, "inbox").stdout
    assert "(inbox empty)" in box             # alice was neither mentioned nor handed anything


def test_relinking_between_projects_never_duplicates(server, tmp_path):
    url, tokens = server
    home, repo = tmp_path / "home", tmp_path / "repo"
    home.mkdir()
    (repo / ".TODO").mkdir(parents=True)
    cli(home, repo, "login", url, tokens["alice"])
    cli(home, repo, "add", "Login bug")
    for project in ("web", "other", "web"):
        cli(home, repo, "link", "--remote", url, "--project", project)
        cli(home, repo, "sync")
    root = (repo / ".TODO").resolve()
    assert [it["id"] for it in store.list_todos(root)] == ["login-bug"]
    import json
    for project in ("web", "other"):
        req = urllib.request.Request(f"{url}/api/projects/{project}/changes?since=0",
                                     headers={"authorization": f"Bearer {tokens['alice']}"})
        changes = json.loads(urllib.request.urlopen(req).read())["changes"]
        items = [c["data"]["id"] for c in changes if c["entity"] == "item" and c["data"]]
        assert items == ["login-bug"], (project, items)
