"""End to end: the built Next.js server on PGlite, two CLI users syncing through
it. Dev A goes offline while QA B takes the item into QA and comments; when A
reconnects, A's note lands, A's stale status is rejected and logged, and A
ends with B's state.

Needs `cd server && npm install && npm run build`; skipped otherwise."""

import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from todo import store
from todo.cli import EXIT_SYNC_REJECTED

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
    env = {**os.environ, "TODO_PGLITE": str(data), "TODO_FILES_DIR": str(tmp_path / "files")}
    tokens = {}
    for handle in ("alice", "bob"):
        out = subprocess.run(["npx", "tsx", "scripts/user-add.ts", handle], cwd=SERVER, env=env,
                             capture_output=True, text=True, timeout=120)
        assert out.returncode == 0, out.stderr
        tokens[handle] = out.stdout.strip().split(": ", 1)[1]
    port = _port()
    log = open(tmp_path / "server.log", "w")
    # Its own process group, so teardown stops next-server itself and not just
    # a wrapper that would leave it running.
    proc = subprocess.Popen([str(SERVER / "node_modules" / ".bin" / "next"), "start", "-p", str(port), "-H", "127.0.0.1"],
                            cwd=SERVER, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
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
        _stop(proc)
        pytest.fail("server did not start: " + (tmp_path / "server.log").read_text())
    try:
        yield url, tokens
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


def cli(home: Path, cwd: Path, *argv, offline=False, code=0, plugins=False):
    env = {k: v for k, v in os.environ.items() if k not in ("TODO_USER", "CLAUDECODE")
           and not (plugins and k == "TODO_PLUGINS")}
    # This checkout's todo, not whichever one is installed.
    env.update(HOME=str(home), TODO_VIA="human", PYTHONPATH=str(SERVER.parent))
    if offline:
        env["TODO_OFFLINE"] = "1"
    out = subprocess.run([sys.executable, "-c", "from todo.cli import main; main()", *argv],
                         cwd=cwd, env=env, capture_output=True, text=True, timeout=120)
    assert code is None or out.returncode == code, f"todo {' '.join(argv)}\n{out.stdout}\n{out.stderr}"
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
    out = cli(ha, ra, "sync", code=EXIT_SYNC_REJECTED)
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


def test_request_versions_freeze_and_send_the_item_back(server, tmp_path):
    url, tokens = server
    home, repo = tmp_path / "home", tmp_path / "repo"
    home.mkdir()
    (repo / ".TODO").mkdir(parents=True)
    cli(home, repo, "login", url, tokens["alice"])
    cli(home, repo, "add", "Safari login", "--request", "first words")
    cli(home, repo, "link", "--remote", url, "--project", "web")
    root = (repo / ".TODO").resolve()
    cli(home, repo, "triage", "safari-login")
    cli(home, repo, "reopen", "safari-login")
    cli(home, repo, "sync")             # a command only pushes; the server's triage mark arrives on the next pull
    req = next(n for n in store.resolve_item(root, "safari-login")["notes"] if n["kind"] == "ticket-request")
    assert (req["meta"].get("version"), req["meta"].get("frozen"), req["meta"].get("triaged")) == (1, True, True)

    # A frozen version refuses edits; the log says how to post a new one.
    f = next((root / "OPEN" / "safari-login" / "notes").iterdir())
    f.write_text(f.read_text().replace("first words", "edited words"))
    cli(home, repo, "sync", code=EXIT_SYNC_REJECTED)
    it = store.resolve_item(root, "safari-login")
    assert any("request-frozen" in e["text"] and "todo request" in e["text"] for e in it["log"])
    note_id = next(n["id"] for n in it["notes"] if n["kind"] == "ticket-request")
    cli(home, repo, "renote", "safari-login", str(note_id), "renoted words", code=EXIT_SYNC_REJECTED)

    out = cli(home, repo, "request", "safari-login", "--text", "second words")
    assert "moves it back to requested" in out.stdout
    cli(home, repo, "sync")
    cli(home, repo, "sync")
    it = store.resolve_item(root, "safari-login")
    assert it["status"] == "requested"
    versions = sorted((n["meta"].get("version"), n["text"]) for n in it["notes"] if n["kind"] == "ticket-request")
    assert versions[-1] == (2, "second words")
    assert it["history"][-1]["to"] == "requested"


def test_phase_titles_app_and_relations_sync_both_ways(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]
    cli(ha, ra, "add", "Cart totals", "--app", "web", "--section", "checkout")
    cli(ha, ra, "add", "Tax rounding")
    cli(ha, ra, "phase", "cart-totals", "1", "Schema")
    cli(ha, ra, "relate", "cart-totals", "tax-rounding")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    root_b = (rb / ".TODO").resolve()
    it = store.resolve_item(root_b, "cart-totals")
    assert (it["app"], it["section"], it["phases"]) == ("web", "checkout", {"1": "Schema"})
    assert "cart-totals" in cli(hb, rb, "get", "tax-rounding").stdout.split("related:")[1]

    cli(hb, rb, "phase", "cart-totals", "2", "UI")
    cli(hb, rb, "set", "cart-totals", "section", "cart")
    cli(hb, rb, "unrelate", "tax-rounding", "cart-totals")
    cli(ha, ra, "sync")
    it = store.resolve_item((ra / ".TODO").resolve(), "cart-totals")
    assert (it["section"], it["phases"]) == ("cart", {"1": "Schema", "2": "UI"})
    assert [n for n in it["notes"] if n["kind"] == "relation"] == []


def test_offline_new_version_beats_a_stale_move_into_triage(server, tmp_path):
    url, tokens = server
    home, repo = tmp_path / "home", tmp_path / "repo"
    home.mkdir()
    (repo / ".TODO").mkdir(parents=True)
    cli(home, repo, "login", url, tokens["alice"])
    cli(home, repo, "add", "Safari login", "--request", "first")
    cli(home, repo, "link", "--remote", url, "--project", "web")
    cli(home, repo, "triage", "safari-login")
    cli(home, repo, "reopen", "safari-login")
    cli(home, repo, "request", "safari-login", "--text", "second", offline=True)
    cli(home, repo, "triage", "safari-login", offline=True)
    cli(home, repo, "sync", code=EXIT_SYNC_REJECTED)
    cli(home, repo, "sync")
    it = store.resolve_item((repo / ".TODO").resolve(), "safari-login")
    assert it["status"] == "requested"
    current = max((n for n in it["notes"] if n["kind"] == "ticket-request"), key=lambda n: n["meta"].get("version", 0))
    assert (current["text"], current["meta"].get("frozen")) == ("second", None)


def test_qa_rejected_round_trips(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]
    cli(ha, ra, "add", "Cart totals")
    cli(ha, ra, "status", "cart-totals", "in-qa")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "reject", "cart-totals", "totals", "wrong")
    cli(ha, ra, "sync")
    it = store.resolve_item((ra / ".TODO").resolve(), "cart-totals")
    assert it["status"] == "qa-rejected"
    assert it["notes"][-1]["kind"] == "qa-rejection"
    cli(ha, ra, "start", "cart-totals")
    cli(hb, rb, "sync")
    assert store.resolve_item((rb / ".TODO").resolve(), "cart-totals")["status"] == "in-progress"


def test_acknowledgements_from_both_sides_merge(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]
    cli(ha, ra, "add", "Cart totals")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "comment", "cart-totals", "rounding is off")
    cli(ha, ra, "sync")

    cli(ha, ra, "--agent", "ack", "cart-totals", "n1", offline=True)
    cli(ha, ra, "ack", "cart-totals", "n1")
    cli(ha, ra, "sync")
    cli(hb, rb, "sync")
    seen = store.resolve_item((rb / ".TODO").resolve(), "cart-totals")["notes"][0]["meta"]["seen_by"]
    assert sorted(seen) == ["alice", "alice/agent", "bob"]
    assert "nothing new" in cli(ha, ra, "--agent", "updates", "cart-totals").stdout


def test_docs_round_trip_and_conflict(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]
    cli(ha, ra, "add", "Cart totals")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n")
    cli(ha, ra, "doc", "add", "cart-totals", str(plan))
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    path_b = Path(cli(hb, rb, "doc", "path", "cart-totals", "plan.md").stdout.strip())
    assert path_b.read_text() == "# Plan\n"
    assert cli(hb, rb, "docs", "cart-totals").stdout.strip().endswith(f"{url}/p/web/i/cart-totals/docs/plan.md")

    path_a = Path(cli(ha, ra, "doc", "path", "cart-totals", "plan.md").stdout.strip())
    path_a.write_text("# Plan\nalice\n")
    path_b.write_text("# Plan\nbob\n")
    cli(ha, ra, "sync")
    out = cli(hb, rb, "sync")
    assert "plan.conflict-bob.md" in out.stdout
    assert path_b.read_text() == "# Plan\nalice\n"
    assert (path_b.parent / "plan.conflict-bob.md").read_text() == "# Plan\nbob\n"
    cli(ha, ra, "sync")
    assert (path_a.parent / "plan.conflict-bob.md").read_text() == "# Plan\nbob\n"

    cli(ha, ra, "doc", "rm", "cart-totals", "plan.conflict-bob.md")
    cli(hb, rb, "sync")
    assert not (path_b.parent / "plan.conflict-bob.md").exists()


@pytest.mark.skipif(shutil.which("node") is None, reason="node isn't installed")
def test_plugins_list_and_instances_against_the_server(server, tmp_path):
    url, tokens = server
    home, repo = tmp_path / "home", tmp_path / "repo"
    home.mkdir()
    (repo / ".TODO").mkdir(parents=True)
    cli(home, repo, "login", url, tokens["alice"])
    cli(home, repo, "link", "--remote", url, "--project", "web")
    out = cli(home, repo, "plugin", "list", "--repo", "acme/web", plugins=True)
    assert "pr-link (shipped)  on: push, pr · needs github" in out.stdout
    assert "    default  on  · implicit" in out.stdout
    added = cli(home, repo, "plugin", "add", "pr-link", "x", "--repo", "acme/web", plugins=True, code=None)
    if added.returncode != 0:
        assert "404" in added.stderr        # a server without the plugins routes yet
    else:
        assert "    x  on" in cli(home, repo, "plugin", "list", "--repo", "acme/web", plugins=True).stdout


def test_tags_round_trip_with_their_history(server, tmp_path):
    url, tokens = server
    users = {}
    for who in ("alice", "bob"):
        home, repo = tmp_path / who / "home", tmp_path / who / "repo"
        home.mkdir(parents=True)
        (repo / ".TODO").mkdir(parents=True)
        cli(home, repo, "login", url, tokens[who])
        users[who] = (home, repo)
    (ha, ra), (hb, rb) = users["alice"], users["bob"]
    cli(ha, ra, "add", "Cart totals")
    cli(ha, ra, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "link", "--remote", url, "--project", "web")
    cli(hb, rb, "tag", "cart-totals", "auto-deploy")
    cli(ha, ra, "sync")
    it = store.resolve_item((ra / ".TODO").resolve(), "cart-totals")
    assert it["tags"] == ["auto-deploy"]
    assert [(h["field"], h["to"], h["by"]) for h in it["history"] if h["field"]] == [("tags", "auto-deploy", "bob")]
    cli(ha, ra, "untag", "cart-totals", "auto-deploy")
    cli(hb, rb, "sync")
    assert store.resolve_item((rb / ".TODO").resolve(), "cart-totals")["tags"] == []
    out = cli(hb, rb, "list", "--tag", "auto-deploy")
    assert "cart-totals" not in out.stdout
