"""The CLI's plugin runner: repo plugins run through the bundled host (under
Node) against fixture repos and a fake GitHub, and a few cases through a fake
host script chosen with TODO_PLUGIN_HOST."""

import io
import json
import os
import shutil
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from todo import connections, gitfacts, plugins, remote, store, sync, yamlio
from todo.uids import hash_uid

from .conftest import run_cli
from .fake_server import FakeServer
from .test_gitfacts import Fixture, git

needs_node = pytest.mark.skipif(shutil.which("node") is None, reason="node isn't installed")


class FakeGitHub:
    """A local HTTP server answering GET /repos/<owner>/<name>/pulls with `prs[branch]`."""

    def __init__(self):
        self.prs, self.requests = {}, []
        gh = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                gh.requests.append((self.path, self.headers.get("authorization")))
                branch = self.path.split("head=")[1].split("&")[0].split("%3A", 1)[1].replace("%2F", "/") \
                    if "/pulls?" in self.path else None
                body = json.dumps(gh.prs.get(branch, []) if branch is not None else {}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def pr(self, branch, number, title):
        url = f"https://github.com/acme/web/pull/{number}"
        self.prs.setdefault(branch, []).append({"number": number, "title": title, "html_url": url})
        return url


@pytest.fixture
def home(tmp_path, monkeypatch):
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setenv("HOME", str(h))
    return h


@pytest.fixture
def on(home, monkeypatch):
    """Plugins on, with no GitHub token but the ones a test stores."""
    monkeypatch.delenv(plugins.OFF_ENV, raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setattr(connections, "_github_fallback", lambda: None)
    monkeypatch.setattr(gitfacts, "gh_get", lambda path: None)
    return home


@pytest.fixture
def fx(tmp_path, on, monkeypatch):
    f = Fixture(tmp_path)
    monkeypatch.chdir(f.work)
    return f


@pytest.fixture
def github(fx):
    gh = FakeGitHub()
    connections.save_connection("github", {"http": {"url": gh.url, "auth": "bearer"}})
    connections.save_credential("*/github", "ghp_test")
    yield gh
    gh.server.shutdown()


def plugins_file(fx, text):
    """Commit `.todo-plugins/plugins.yaml` (and code files) to main and push it."""
    git(fx.work, "checkout", "-q", "main")
    fx.write(".todo-plugins/plugins.yaml", text)
    git(fx.work, "commit", "-qm", "plugins")
    git(fx.work, "push", "-q", "origin", "main")


def item_with_branch(fx, title="Alpha", branch="feat/a"):
    fx.branch(branch)
    fx.commit(branch, f"{branch.replace('/', '-')}.txt", "x\n")
    return fx.item(title, [branch])


def refresh(root, item_id):
    ctx = plugins.Context(root, fresh=True)
    return plugins.run_jobs(ctx, [(item_id, {"type": "refresh"})], lock=False)


def plugin_notes(root, item_id, iid="pr-link/default"):
    return [n for n in store.get_item(root, item_id)["notes"] if (n.get("meta") or {}).get("plugin") == iid]


# ── pr-link through the bundled host ──────────────────────────────────────────
@needs_node
def test_pr_link_links_a_branch_pr_that_syncs_with_its_deterministic_uid(fx, github, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    monkeypatch.setattr(plugins, "remote_for", lambda root: server.client("alice"))
    a = item_with_branch(fx)
    sync.run_round(fx.root, server.client("alice"))            # gives the item its uid on the server
    url = github.pr("feat/a", 7, "Fix login")
    fx.commit("feat/a", "more.txt", "y\n")                     # the tip moves: the next round's push event
    sync.run_round(fx.root, server.client("alice"))
    it = store.resolve_item(fx.root, a)
    [note] = plugin_notes(fx.root, a)
    assert (note["kind"], note["text"]) == ("link", "#7 · Fix login")
    assert note["meta"]["url"] == url and note["meta"]["type"] == "pr" and note["meta"]["plugin_key"] == f"link:{url}"
    uid = hash_uid("plugin", "pr-link/default", it["uid"], f"link:{url}")
    assert note["uid"] == uid
    sync.run_round(fx.root, server.client("alice"))
    row = server.rows[uid]
    assert row["meta"]["url"] == url and row["meta"]["plugin"] == "pr-link/default"
    assert github.requests[-1][1] == "Bearer ghp_test"
    assert plugins.records(fx.root, it)["pr-link/default"]["event"] == "push feat/a"


@needs_node
def test_a_rerun_replaces_the_instance_set_and_keeps_seen_state(fx, github):
    a = item_with_branch(fx)
    gone = github.pr("feat/a", 8, "Second try")
    kept = github.pr("feat/a", 7, "Fix login")
    refresh(fx.root, a)
    assert sorted(n["meta"]["url"] for n in plugin_notes(fx.root, a)) == sorted([gone, kept])
    note = next(n for n in plugin_notes(fx.root, a) if n["meta"]["url"] == kept)
    item_dir = fx.root / store.OPEN / a
    raw = next(e for e in store._read_entries(item_dir / "notes") if e["id"] == note["id"])
    store.rewrite_entry(fx.root, a, "notes", note["id"], raw["text"], {**raw["meta"], "seen_by": ["human:tester", "human:bob"]})
    github.prs["feat/a"] = [{"number": 7, "title": "Fix login, for real", "html_url": kept}]
    [(_, [run])] = refresh(fx.root, a)
    assert run["changes"] == {"added": 0, "updated": 1, "removed": 1}
    [after] = plugin_notes(fx.root, a)
    assert (after["id"], after["uid"], after["text"]) == (note["id"], note["uid"], "#7 · Fix login, for real")
    assert after["meta"]["seen_by"] == ["human:tester", "human:bob"]
    [(_, [run])] = refresh(fx.root, a)
    assert run["changes"] == {"added": 0, "updated": 0, "removed": 0}


@needs_node
def test_a_link_already_on_the_item_is_skipped_and_logged(fx, github):
    a = item_with_branch(fx)
    url = github.pr("feat/a", 7, "Fix login")
    run_cli(fx.root, ["url", a, url, "--type", "pr"])
    refresh(fx.root, a)
    assert plugin_notes(fx.root, a) == []
    assert [n["meta"]["url"] for n in store.get_item(fx.root, a)["notes"] if n["kind"] == "link"] == [url]
    rec = plugins.records(fx.root, store.resolve_item(fx.root, a))["pr-link/default"]
    assert rec["log"] == [f"skipped link {url}: already linked on the item"]


@needs_node
def test_get_labels_plugin_links_and_shows_skip_notices(fx, github, capsys):
    a = item_with_branch(fx)
    github.pr("feat/a", 7, "Fix login")
    refresh(fx.root, a)
    run_cli(fx.root, ["get", a])
    assert "(link · pr · plugin pr-link/default) #7 · Fix login" in capsys.readouterr().out
    connections._cred_file().write_text("{}")
    refresh(fx.root, a)
    run_cli(fx.root, ["get", a])
    out = capsys.readouterr().out
    assert "plugins:\n  pr-link/default: skipped — `github` not authorized here" in out
    assert len(plugin_notes(fx.root, a)) == 1                  # a skip removes nothing


# ── triggers ──────────────────────────────────────────────────────────────────
def todo(fx, *argv, env=None):
    e = {k: v for k, v in os.environ.items() if k not in ("TODO_USER", "CLAUDECODE")}
    e.update(TODO_VIA="human", PYTHONPATH=str(Path(__file__).resolve().parent.parent), **(env or {}))
    return subprocess.run([sys.executable, "-c", "from todo.cli import main; main()", *argv], cwd=fx.work,
                          env=e, capture_output=True, text=True, timeout=120)


@needs_node
def test_a_status_move_runs_the_instances_it_triggers(fx):
    plugins_file(fx, """\
plugins:
  on-review:
    on: [{status: {to: review}}]
    attach:
      - log: "moved {{event.from}} to {{event.to}}"
""")
    a = fx.item("Alpha", [])
    connections.save_connection("github", {"http": {"url": "http://127.0.0.1:9", "auth": "bearer"}})
    connections.save_credential("*/github", "ghp_unused")
    out = todo(fx, "review", a)
    assert out.returncode == 0, out.stderr
    [entry] = store.get_item(fx.root, a)["log"]
    assert entry["text"] == "moved in-progress to review" and entry["meta"]["plugin"] == "on-review/default"
    assert todo(fx, "start", a).returncode == 0
    assert [e["text"] for e in store.get_item(fx.root, a)["log"]] == ["moved in-progress to review"]


@needs_node
def test_plugin_test_dry_runs_the_working_tree_and_prints_what_it_would_send(fx, capsys):
    hook = FakeGitHub()
    try:
        fx.write(".todo-plugins/plugins.yaml", f"""\
connections:
  hook: {{http: {{url: "{hook.url}"}}}}
plugins:
  poster:
    connections: [hook]
    on: [manual]
    steps:
      - http: {{method: POST, path: /notify, body: {{item: "{{{{item.id}}}}"}}}}
    attach:
      - log: posted
""")
        a = fx.item("Alpha", [])
        run_cli(fx.root, ["plugin", "test", "poster", a, "--local", "--event", "manual:default"])
        out = capsys.readouterr().out
        assert out == (f"{a}: poster on manual default (working tree) — dry run\n"
                       "  poster/default: would attach 1:\n    log · posted\n"
                       "    would send 1:\n      hook: POST /notify  {\"item\": \"" + a + "\"}\n"
                       "    log: would send hook POST /notify\n")
        assert hook.requests == [] and store.get_item(fx.root, a)["log"] == []
    finally:
        hook.server.shutdown()


# ── through a fake host ───────────────────────────────────────────────────────
FAKE_HOST = """\
import json, os, sys
payload = json.load(sys.stdin)
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps(payload) + "\\n")
answer = json.load(open(os.environ["FAKE_" + payload.get("mode", "instance").upper()]))
if payload.get("mode") == "event" and "results" in answer and isinstance(answer["results"], dict):
    answer = {"errors": [], "track": [], "results": answer["results"].get(payload["event"]["type"], [])}
print(json.dumps(answer))
"""


class Host:
    def __init__(self, tmp, monkeypatch):
        self.dir = tmp / "fakehost"
        self.dir.mkdir()
        (self.dir / "host.py").write_text(FAKE_HOST)
        self.log = self.dir / "log.jsonl"
        monkeypatch.setenv(plugins.HOST_ENV, f"{sys.executable} {self.dir / 'host.py'}")
        monkeypatch.setenv("FAKE_LOG", str(self.log))
        for mode in ("describe", "event"):
            monkeypatch.setenv(f"FAKE_{mode.upper()}", str(self.dir / f"{mode}.json"))
        self.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}}])
        self.results({})

    def describe(self, plugins_, instances=None):
        (self.dir / "describe.json").write_text(json.dumps({"plugins": plugins_, "instances": instances or {},
                                                            "dropped": [], "connections": {}, "errors": [], "track": []}))

    def results(self, by_event):
        (self.dir / "event.json").write_text(json.dumps({"results": by_event}))

    def calls(self, mode="event"):
        if not self.log.is_file():
            return []
        return [c for c in map(json.loads, self.log.read_text().splitlines()) if c.get("mode") == mode]


def ran(plugin, attached=(), inst="default", **result):
    return {"plugin": plugin, "instance": {"id": inst, "name": inst},
            "result": {"attached": list(attached), "wouldSend": [], "log": [], **result}}


@pytest.fixture
def host(tmp_path, on, monkeypatch):
    return Host(tmp_path, monkeypatch)


def test_a_moved_tip_emits_one_push_event_per_branch(fx, host, monkeypatch):
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    host.results({"push": [ran("p", [{"kind": "log", "key": "k", "text": "pushed"}])]})
    a = item_with_branch(fx)
    fx.item("Idle", [])

    def round_():
        seen = {}
        gitfacts.on_round(fx.root, seen=seen)
        plugins.after_command(fx.root, seen)
        return [(c["item"]["id"], c["event"]) for c in host.calls()]

    assert round_() == [(a, {"type": "push", "branch": "feat/a"})]
    assert round_() == [(a, {"type": "push", "branch": "feat/a"})]      # nothing moved
    fx.commit("feat/a", "again.txt", "z\n")
    assert round_() == [(a, {"type": "push", "branch": "feat/a"})] * 2
    [entry] = store.get_item(fx.root, a)["log"]
    assert entry["meta"]["plugin"] == "p/default"


def test_an_every_floor_runs_a_refresh_once_its_interval_passes(fx, host, monkeypatch):
    monkeypatch.setattr(plugins, "FLOOR_EVERY", -1)
    host.describe([{"name": "poll", "shipped": False, "connections": [], "on": [], "every": "1h", "settings": {}}])
    host.results({"refresh": [ran("poll")]})
    a = fx.item("Alpha", [])
    it = store.resolve_item(fx.root, a)
    plugins.after_command(fx.root)
    assert [c["event"] for c in host.calls()] == [{"type": "refresh"}]
    plugins.after_command(fx.root)
    assert len(host.calls()) == 1                                         # ran just now
    runs = json.loads((fx.root / ".plugin-runs.json").read_text())
    runs[plugins._item_key(it)]["poll/default"]["at"] = "2026-01-01T00:00:00.000Z"
    (fx.root / ".plugin-runs.json").write_text(json.dumps(runs))
    plugins.after_command(fx.root)
    assert len(host.calls()) == 2


def test_a_local_only_store_keeps_instances_in_its_plugins_file(fx, host, capsys):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["manual"],
                    "settings": {"to": {"label": "To", "type": "text"}}}])
    key = gitfacts._store_repo(fx.root)[0]
    run_cli(fx.root, ["plugin", "add", "p", "go", "--set", "to=review", "--on", "manual", "--name", "Go"])
    run_cli(fx.root, ["plugin", "set", "p/go", "--set", "n=3", "--disable"])
    data = yamlio.read(fx.root / ".plugins.yaml")
    assert json.loads(json.dumps(data)) == {key: {"instances": {"p": [
        {"id": "go", "name": "Go", "on": ["manual"], "settings": {"to": "review", "n": 3}, "enabled": False}]}}}
    run_cli(fx.root, ["plugin", "list"])
    assert "    go \"Go\"  off  · on: manual  · settings: to=review, n=3" in capsys.readouterr().out
    run_cli(fx.root, ["plugin", "set", "p/go", "--enable"])
    host.results({"manual": [ran("p", inst="go")]})
    a = fx.item("Alpha", [])
    run_cli(fx.root, ["plugin", "run", a, "p/go"])
    [call] = host.calls()
    assert call["storedInstances"]["p"][0]["settings"] == {"to": "review", "n": 3}
    assert call["event"] == {"type": "manual", "instance": "go"} and call["allowRepoCommands"] is True
    run_cli(fx.root, ["plugin", "rm", "p/go"])
    assert yamlio.read(fx.root / ".plugins.yaml") == {key: {"instances": {}}}


def test_a_synced_store_keeps_instances_on_the_server(fx, host, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(plugins, "remote_for", lambda root: server.client("alice"))
    key = gitfacts._store_repo(fx.root)[0]
    run_cli(fx.root, ["plugin", "add", "p", "go", "--set", "to=review"])
    assert server.plugin_config[key]["instances"]["p"] == [{"id": "go", "name": "go", "settings": {"to": "review"}}]
    cache = json.loads((fx.root / ".sync" / "plugins.json").read_text())
    assert cache[key]["instances"]["p"][0]["id"] == "go"
    server.plugin_config = None                                            # an older server: 404
    assert plugins.Context(fx.root, fresh=True).stored(key)["instances"] == {}


def test_an_error_result_leaves_the_store_as_it_was(fx, host, capsys):
    a = item_with_branch(fx)
    link = {"kind": "link", "key": "link:https://x.test/1", "type": "preview", "url": "https://x.test/1"}
    host.results({"refresh": [ran("p", [link])]})
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}}])
    refresh(fx.root, a)
    before = store.get_item(fx.root, a)["notes"]
    assert [n["meta"]["url"] for n in before] == ["https://x.test/1"]
    host.results({"refresh": [ran("p", error="vercel: GET /v6/deployments answered 500")]})
    refresh(fx.root, a)
    assert store.get_item(fx.root, a)["notes"] == before
    rec = plugins.records(fx.root, store.resolve_item(fx.root, a))["p/default"]
    assert rec["error"] == "vercel: GET /v6/deployments answered 500"
    assert capsys.readouterr().err.count("vercel: GET /v6/deployments answered 500") == 1
    host.results({"refresh": [ran("p", skipped="p: `vercel` not authorized here")]})
    refresh(fx.root, a)
    assert store.get_item(fx.root, a)["notes"] == before


def test_a_host_that_fails_is_one_notice_and_the_command_goes_on(fx, host, monkeypatch, capsys):
    a = item_with_branch(fx)
    plugins.queue(a, {"type": "push", "branch": "feat/a"})
    plugins.after_command(fx.root)                                  # caches the description
    monkeypatch.setenv(plugins.HOST_ENV, f"{sys.executable} -c 'import sys; sys.exit(3)'")
    plugins.queue(a, {"type": "push", "branch": "feat/a"})
    plugins._said.clear()
    plugins.after_command(fx.root)
    err = capsys.readouterr().err
    assert err.count("the plugin host exited 3") == 1 and store.get_item(fx.root, a)["notes"] == []


def test_without_node_plugins_skip_with_one_notice(fx, on, monkeypatch, capsys):
    real = shutil.which
    monkeypatch.setattr(plugins.shutil, "which", lambda name, *a, **kw: None if name == "node" else real(name, *a, **kw))
    a, b = fx.item("Alpha", []), fx.item("Beta", [])
    plugins.queue(a, {"type": "status", "from": "todo", "to": "in-progress"})
    plugins.queue(b, {"type": "status", "from": "todo", "to": "in-progress"})
    plugins.after_command(fx.root)
    assert capsys.readouterr().err.count(plugins.NO_NODE) == 1
    assert not (fx.root / plugins.RUNS_FILE).exists() and not (fx.root / ".plugin-runs.json").exists()


def test_a_new_branch_runs_a_refresh_for_the_item(fx, host):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}}])
    a = fx.item("Alpha", [])
    run_cli(fx.root, ["branch", "add", a, "feat/a"])
    run_cli(fx.root, ["branch", "add", a, "feat/a"])
    plugins.after_command(fx.root)
    assert [c["event"] for c in host.calls()] == [{"type": "push", "branch": "feat/a"}]


LINK = {"kind": "link", "key": "link:https://x.test/1", "type": "preview", "url": "https://x.test/1"}


def test_logs_and_requests_only_add(fx, host):
    a = item_with_branch(fx)
    for text in ("first", "second"):
        host.results({"refresh": [ran("p", [{"kind": "log", "key": f"log:{text}", "text": text},
                                            {"kind": "request", "key": f"request:{text}", "text": f"ask {text}"}])]})
        refresh(fx.root, a)
    it = store.get_item(fx.root, a)
    assert [e["text"] for e in it["log"]] == ["first", "second"]
    assert [n["text"] for n in it["notes"] if n["kind"] == "ticket-request"] == ["ask first", "ask second"]


def test_a_removed_plugin_note_is_never_made_again(fx, host):
    a = item_with_branch(fx)
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    [note] = plugin_notes(fx.root, a, "p/default")
    run_cli(fx.root, ["unnote", a, str(note["id"])])
    [(_, [run])] = refresh(fx.root, a)
    assert plugin_notes(fx.root, a, "p/default") == [] and run["changes"]["added"] == 0
    assert note["uid"] in plugins.removed(fx.root, store.resolve_item(fx.root, a))
    host.results({"refresh": [ran("p", [])]})
    refresh(fx.root, a)
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    assert plugin_notes(fx.root, a, "p/default") == []


def test_a_link_a_run_dropped_stays_dropped(fx, host):
    a = item_with_branch(fx)
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    host.results({"refresh": [ran("p", [])]})
    refresh(fx.root, a)
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    assert plugin_notes(fx.root, a, "p/default") == []


def test_a_dry_run_instance_attaches_nothing_and_records_its_run(fx, host):
    a = item_with_branch(fx)
    run = ran("p", [LINK], wouldSend=[{"connection": "hook", "method": "POST", "path": "/x"}])
    run["instance"]["dry_run"] = True
    host.results({"refresh": [run]})
    refresh(fx.root, a)
    assert store.get_item(fx.root, a)["notes"] == []
    rec = plugins.records(fx.root, store.resolve_item(fx.root, a))["p/default"]
    assert rec["dry_run"] is True and rec["would_send"] == 1 and rec["attached"][0]["url"] == "https://x.test/1"


def test_the_server_refusing_a_removed_plugin_note_is_final(fx, host, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(plugins, "remote_for", lambda root: server.client("alice"))
    a = item_with_branch(fx)
    sync.run_round(fx.root, server.client("alice"))
    it = store.resolve_item(fx.root, a)
    uid = hash_uid("plugin", "p/default", it["uid"], LINK["key"])
    server.tombs[uid] = (1, "bob")
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    report = sync.run_round(fx.root, server.client("alice"))
    assert plugin_notes(fx.root, a, "p/default") == [] and uid in plugins.removed(fx.root, it)
    assert any("from plugin p/default not applied; bob removed it" in m for m in report.messages)
    refresh(fx.root, a)
    sync.run_round(fx.root, server.client("alice"))
    assert plugin_notes(fx.root, a, "p/default") == [] and uid not in server.rows


# ── connections and credentials ───────────────────────────────────────────────
def test_credentials_are_private_and_keyed_by_repo_or_host(on, monkeypatch, tmp_path, capsys):
    root = tmp_path / "proj" / ".TODO"
    root.mkdir(parents=True)
    monkeypatch.setattr(sys, "stdin", io.StringIO("ghp_host\n"))
    run_cli(root, ["connection", "auth", "github"])
    monkeypatch.setattr(sys, "stdin", io.StringIO("vc_repo\n"))
    run_cli(root, ["connection", "auth", "vercel", "--repo", "Acme/Web"])
    f = on / ".todo" / "credentials.json"
    assert stat.S_IMODE(f.stat().st_mode) == 0o600
    assert json.loads(f.read_text()) == {"*/github": "ghp_host", "acme/web/vercel": "vc_repo"}
    assert connections.secrets_for("acme/web") == {"repo": {"vercel": "vc_repo"}, "host": {"github": "ghp_host"}}
    assert connections.secrets_for("acme/other") == {"repo": {}, "host": {"github": "ghp_host"}}
    assert "ghp_host" not in capsys.readouterr().out


def test_auth_reads_the_secret_hidden_from_a_terminal(on, monkeypatch, tmp_path, capsys):
    root = tmp_path / "proj" / ".TODO"
    root.mkdir(parents=True)
    prompts = []

    class Tty(io.StringIO):
        def isatty(self):
            return True

    monkeypatch.setattr(sys, "stdin", Tty(""))
    monkeypatch.setattr("getpass.getpass", lambda prompt: prompts.append(prompt) or "s3cret")
    run_cli(root, ["connection", "auth", "github"])
    assert prompts == ["secret for github (hidden): "]
    assert connections.load_credentials() == {"*/github": "s3cret"}
    assert "s3cret" not in capsys.readouterr().out


def test_auth_with_server_posts_the_secret(fx, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(remote, "remote_for", lambda root: server.client("alice"))
    monkeypatch.setattr(sys, "stdin", io.StringIO("vc\n"))
    run_cli(fx.root, ["connection", "auth", "vercel", "--repo", "acme/web", "--server"])
    assert server.plugin_creds == [("acme/web", "vercel", "vc")]


def test_connection_add_and_list(fx, host, capsys):
    run_cli(fx.root, ["connection", "add", "hook", "--http", "https://hooks.test", "--auth", "header:X-Key"])
    assert connections.host_connections()["hook"] == {"http": {"url": "https://hooks.test", "auth": "header:X-Key"}}
    connections.save_credential("*/hook", "k")
    run_cli(fx.root, ["connection", "list"])
    out = capsys.readouterr().out
    assert "github         http https://api.github.com (bearer)  · built in · secret here: none" in out
    assert "hook           http https://hooks.test (header:X-Key)  · ~/.todo/connections.yaml · secret here: " \
           "~/.todo/credentials.json" in out


def test_the_payload_keeps_repo_and_host_secrets_apart(fx, host):
    key = gitfacts._store_repo(fx.root)[0]
    connections.save_credential("*/github", "ghp_host")
    connections.save_credential(f"{key}/vercel", "vc")
    connections.save_credential("other/repo/vercel", "not-ours")
    a = item_with_branch(fx)
    refresh(fx.root, a)
    [call] = host.calls()
    assert call["secrets"] == {"repo": {"vercel": "vc"}, "host": {"github": "ghp_host"}}
    assert call["repoKey"] == key and call["hostConnections"]["github"]["http"]["url"] == "https://api.github.com"
    assert call["item"]["dir"] == str(fx.work) and call["item"]["branches"] == ["feat/a"]
    assert call["repo"]["text"].startswith("track:")


def test_plugins_shows_each_instance_last_run_on_the_item(fx, host, capsys):
    a = item_with_branch(fx)
    host.results({"refresh": [ran("p", [{"kind": "log", "key": "k", "text": "deployed preview"}], log=["one call"])]})
    refresh(fx.root, a)
    run_cli(fx.root, ["plugins", a])
    out = capsys.readouterr().out
    assert out.startswith("p/default  ") and "(refresh)\n  attached 1\n    log · deployed preview\n  log: one call\n" in out
    run_cli(fx.root, ["get", a])
    assert "(plugin p/default) deployed preview" in capsys.readouterr().out


def test_connection_test_makes_one_read_only_call(fx, host, capsys):
    gh = FakeGitHub()
    try:
        run_cli(fx.root, ["connection", "add", "github", "--http", gh.url, "--auth", "bearer"])
        with pytest.raises(SystemExit):
            run_cli(fx.root, ["connection", "test", "github"])
        assert "github: failed — no secret on this host" in capsys.readouterr().out
        connections.save_credential("*/github", "ghp_t")
        run_cli(fx.root, ["connection", "test", "github"])
        assert capsys.readouterr().out == f"github: ok — 200 from {gh.url}/\n"
        assert gh.requests == [("/", "Bearer ghp_t")]
    finally:
        gh.server.shutdown()
