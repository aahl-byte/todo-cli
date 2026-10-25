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


def cli_runs(server, root, *iids):
    """The server lists these instances as run by the CLI (`server_runs: false`)."""
    key = gitfacts.store_repo(root)[0]
    by = {}
    for iid in iids:
        plugin, _, inst = iid.partition("/")
        by.setdefault(plugin, []).append({"id": inst, "name": inst, "server_runs": False})
    server.plugin_config.setdefault(key, {})["plugins"] = [{"name": n, "instances": i} for n, i in by.items()]


def plugin_notes(root, item_id, iid="pr-link/default"):
    return [n for n in store.get_item(root, item_id)["notes"] if (n.get("meta") or {}).get("plugin") == iid]


# ── pr-link through the bundled host ──────────────────────────────────────────
@needs_node
def test_pr_link_links_a_branch_pr_that_syncs_with_its_deterministic_uid(fx, github, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    monkeypatch.setattr(plugins, "remote_for", lambda root: server.client("alice"))
    cli_runs(server, fx.root, "pr-link/default")
    a = item_with_branch(fx)
    sync.run_round(fx.root, server.client("alice"))            # the item's uid; first sight of the repo's tips
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
    raw = next(e for e in store.read_entries(item_dir / "notes") if e["id"] == note["id"])
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
    connections.cred_file().write_text("{}")
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
mode = payload.get("mode", "instance")
answer = json.load(open(os.environ["FAKE_" + ("EVENT" if mode == "events" else mode.upper())]))
if mode == "events":
    by = answer["results"]
    answer = {"runs": [{"errors": [], "track": [], "results": by.get(r["event"]["type"], [])} for r in payload["runs"]]}
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

    def describe(self, plugins_, instances=None, connections_=None):
        (self.dir / "describe.json").write_text(json.dumps({"plugins": plugins_, "instances": instances or {},
                                                            "dropped": [], "connections": connections_ or {},
                                                            "errors": [], "track": []}))

    def results(self, by_event):
        (self.dir / "event.json").write_text(json.dumps({"results": by_event}))

    def calls(self, mode="event"):
        """Each event run the host was given (from its batches), or each call of `mode`."""
        rows = list(map(json.loads, self.log.read_text().splitlines())) if self.log.is_file() else []
        if mode == "event":
            return [r for c in rows if c.get("mode") == "events" for r in c["runs"]]
        return [c for c in rows if c.get("mode") == mode]


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

    assert round_() == []                                               # first sight: tips only
    assert round_() == []                                               # nothing moved
    fx.commit("feat/a", "again.txt", "z\n")
    assert round_() == [(a, {"type": "push", "branch": "feat/a"})]
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
    runs[plugins.item_key(it)]["poll/default"]["at"] = "2026-01-01T00:00:00.000Z"
    (fx.root / ".plugin-runs.json").write_text(json.dumps(runs))
    plugins.after_command(fx.root)
    assert len(host.calls()) == 2


def test_a_local_only_store_keeps_instances_in_its_plugins_file(fx, host, capsys):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["manual"],
                    "settings": {"to": {"label": "To", "type": "text"}}}])
    key = gitfacts.store_repo(fx.root)[0]
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
    key = gitfacts.store_repo(fx.root)[0]
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
    plugins.reset()
    plugins.queue(a, {"type": "push", "branch": "feat/a"})
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


def test_a_link_a_run_dropped_can_come_back(fx, host):
    a = item_with_branch(fx)
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    host.results({"refresh": [ran("p", [])]})
    refresh(fx.root, a)
    assert plugin_notes(fx.root, a, "p/default") == []
    host.results({"refresh": [ran("p", [LINK])]})
    refresh(fx.root, a)
    assert [n["meta"]["url"] for n in plugin_notes(fx.root, a, "p/default")] == [LINK["url"]]
    assert plugins.removed(fx.root, store.resolve_item(fx.root, a)) == []


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
    cli_runs(server, fx.root, "p/default")
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


VERCEL = {"vercel": {"http": {"url": "https://api.vercel.com", "auth": "bearer"}}}


def test_auth_with_server_posts_a_repo_connection_s_secret(fx, synced, host, monkeypatch):
    host.describe([], connections_=VERCEL)
    key = gitfacts.store_repo(fx.root)[0]
    monkeypatch.setattr(sys, "stdin", io.StringIO("vc\n"))
    run_cli(fx.root, ["connection", "auth", "vercel", "--server"])
    assert synced.plugin_creds == [(key, "vercel", "vc")]
    assert connections.load_credentials() == {f"{key}/vercel": "vc"}


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
    key = gitfacts.store_repo(fx.root)[0]
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


# ── where plugin code comes from ──────────────────────────────────────────────
def test_plugins_come_from_the_default_branch_never_the_working_tree(fx, host, monkeypatch, capsys):
    plugins_file(fx, "plugins: {safe: {on: [manual], attach: [{log: default-branch}]}}\n")
    git(fx.work, "checkout", "-q", "-b", "evil")
    fx.write(".todo-plugins/plugins.yaml", "plugins: {evil: {on: [manual], attach: [{log: WORKING-TREE}]}}\n")
    git(fx.work, "commit", "-qm", "evil")
    key = gitfacts.store_repo(fx.root)[0]
    assert "safe" in plugins.Context(fx.root).repo(key)["payload"]["text"]
    assert "evil" in plugins.Context(fx.root, local=True).repo(key)["payload"]["text"]
    calls = []
    real = plugins._git
    monkeypatch.setattr(plugins, "_git", lambda d, *a, **kw: calls.append(a) or real(d, *a, **kw))
    gone = "0" * 40
    ctx = plugins.Context(fx.root, seen={key: {"default": "main", "tips": {"main": gone}, "dir": fx.work}})
    assert "safe" in ctx.repo(key)["payload"]["text"]           # the local origin/main, no fetch
    assert not any(a[0] == "fetch" for a in calls)
    git(fx.work, "remote", "set-head", "origin", "-d")
    ctx = plugins.Context(fx.root)
    assert ctx.repo(key)["payload"] is None and ctx.repo(key)["described"] is None
    a = fx.item("Alpha", [])
    assert plugins.run(ctx, store.resolve_item(fx.root, a), {"type": "manual", "instance": "default"}) == []
    assert capsys.readouterr().err.count(f"can't tell {key}'s default branch; run git remote set-head origin -a") == 1
    assert host.calls() == []


def test_git_facts_tips_name_the_default_branch(fx, host, monkeypatch):
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    item_with_branch(fx)
    git(fx.work, "remote", "set-head", "origin", "-d")
    gitfacts.on_round(fx.root)                     # saves the ls-remote --symref answer
    key = gitfacts.store_repo(fx.root)[0]
    assert plugins.Context(fx.root).repo(key)["payload"]["text"].startswith("track:")


# ── one host per instance ─────────────────────────────────────────────────────
@pytest.fixture
def synced(fx, host, monkeypatch):
    server = FakeServer()
    remote.save_sync_config(fx.root, {"url": "http://fake", "project": "p", "deploy_step": True})
    monkeypatch.setattr(plugins, "remote_for", lambda root: server.client("alice"))
    monkeypatch.setattr(remote, "remote_for", lambda root: server.client("alice"))
    return server


def test_on_a_synced_store_the_cli_runs_only_what_the_server_leaves_it(fx, synced, host):
    a = item_with_branch(fx)
    host.results({"refresh": [ran("p", [LINK])]})
    synced.plugin_config[gitfacts.store_repo(fx.root)[0]] = {
        "plugins": [{"name": "p", "instances": [{"id": "default", "name": "default", "server_runs": True}]}]}
    assert refresh(fx.root, a) == [] and host.calls() == []
    cli_runs(synced, fx.root, "p/default")
    refresh(fx.root, a)
    assert len(host.calls()) == 1 and plugin_notes(fx.root, a, "p/default")


def test_a_synced_store_without_the_server_runs_nothing_by_itself(fx, synced, host):
    synced.plugins_down = True
    a = item_with_branch(fx)
    plugins.queue(a, {"type": "push", "branch": "feat/a"})
    plugins.after_command(fx.root)
    assert host.calls() == []


def test_a_manual_run_goes_through_wherever_the_instance_runs(fx, synced, host, capsys):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["manual"], "settings": {}}])
    host.results({"manual": [ran("p")]})
    a = fx.item("Alpha", [])
    run_cli(fx.root, ["plugin", "run", a, "default"])
    assert len(host.calls()) == 1
    assert "alpha: p/default (ran on this host): no change" in capsys.readouterr().out


def test_an_ambiguous_manual_run_names_the_candidates(fx, host, capsys):
    host.describe([{"name": n, "shipped": False, "connections": [], "on": ["manual"], "settings": {}} for n in ("p", "q")])
    a = fx.item("Alpha", [])
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["plugin", "run", a, "default"])
    assert "p/default, q/default" in capsys.readouterr().err and host.calls() == []


# ── cost ──────────────────────────────────────────────────────────────────────
def test_a_command_runs_every_job_in_one_host_process(fx, host):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": [{"status": {"to": "review"}}],
                    "settings": {}}])
    a, b = fx.item("Alpha", []), fx.item("Beta", [])
    for i in (a, b):
        plugins.queue(i, {"type": "status", "from": "in-progress", "to": "review"})
    plugins.after_command(fx.root)
    [batch] = host.calls("events")
    assert [r["item"]["id"] for r in batch["runs"]] == [a, b]
    assert len([c for c in host.calls("describe")]) == 1


def test_an_every_floor_runs_only_the_due_plugins(fx, host, monkeypatch):
    monkeypatch.setattr(plugins, "FLOOR_EVERY", -1)
    host.describe([{"name": "poll", "shipped": False, "connections": [], "on": [], "every": "1h", "settings": {}},
                   {"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}}])
    fx.item("Alpha", [])
    plugins.after_command(fx.root)
    [call] = host.calls()
    assert call["event"] == {"type": "refresh"}
    assert call["storedInstances"]["p"] == [{"id": "default", "name": "default", "enabled": False}]
    assert "poll" not in call["storedInstances"]


def test_a_new_branch_fires_one_push(fx, host, monkeypatch):
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    item_with_branch(fx, "Seen", "feat/seen")
    seen = {}
    gitfacts.on_round(fx.root, seen=seen)
    plugins.after_command(fx.root, seen)                            # first sight
    fx.branch("feat/b")
    fx.commit("feat/b", "b.txt", "b\n")
    a = fx.item("Alpha", [])
    run_cli(fx.root, ["branch", "add", a, "feat/b"])
    seen = {}
    gitfacts.on_round(fx.root, seen=seen)
    plugins.after_command(fx.root, seen)
    seen = {}
    gitfacts.on_round(fx.root, seen=seen)
    plugins.after_command(fx.root, seen)
    assert [(c["item"]["id"], c["event"]) for c in host.calls()] == [(a, {"type": "push", "branch": "feat/b"})]


def test_tips_advance_while_plugins_are_off(fx, host, monkeypatch):
    monkeypatch.setattr(gitfacts, "POLL_EVERY", -1)
    item_with_branch(fx)

    def round_():
        seen = {}
        gitfacts.on_round(fx.root, seen=seen)
        plugins.after_command(fx.root, seen)

    round_()
    monkeypatch.setenv(plugins.OFF_ENV, "0")
    fx.commit("feat/a", "again.txt", "z\n")
    round_()
    monkeypatch.delenv(plugins.OFF_ENV)
    round_()
    assert host.calls() == []


def test_a_round_with_plugins_on_stays_within_its_process_budget(fx, tmp_path, monkeypatch):
    """Counts git and node starts through wrappers on PATH, as a person's machine would run them."""
    bins, log = tmp_path / "bin", tmp_path / "starts.log"
    bins.mkdir()
    for tool in ("git", "node"):
        real = shutil.which(tool)
        if real is None:
            pytest.skip(f"{tool} isn't installed")
        (bins / tool).write_text(f'#!/bin/sh\necho {tool} >> "{log}"\nexec "{real}" "$@"\n')
        (bins / tool).chmod(0o755)
    (bins / "gh").write_text("#!/bin/sh\nexit 1\n")
    (bins / "gh").chmod(0o755)
    plugins_file(fx, "plugins:\n  hello: {on: [push], attach: [{log: hi}]}\n")
    for n in range(5):
        item_with_branch(fx, f"Item {n}", f"feat/{n}")
    env = {"PATH": f"{bins}:{os.environ['PATH']}"}

    def starts(*argv):
        log.unlink(missing_ok=True)
        out = todo(fx, *argv, env=env)
        assert out.returncode == 0, out.stderr
        rows = log.read_text().split() if log.exists() else []
        return rows.count("git"), rows.count("node")

    def due():
        """Past git facts' throttles, as a while later would be."""
        f = fx.root / ".git-tips.json"
        state = json.loads(f.read_text())
        f.write_text(json.dumps({k: {**v, "at": 0} if isinstance(v, dict) else v for k, v in state.items()}
                                | {"local_at": 0}))

    gits, nodes = starts("list")                                       # first sight: tips only
    assert nodes == 1 and gits <= 30, (nodes, gits)                    # the describe, for the floor check
    for n in range(5):
        fx.commit(f"feat/{n}", "more.txt", f"{n}\n")
    due()
    gits, nodes = starts("list")
    assert nodes == 1 and gits <= 40, (nodes, gits)                    # one batch of five pushes
    assert all(len(store.get_item(fx.root, f"item-{n}")["log"]) == 1 for n in range(5))
    due()
    gits, nodes = starts("list")
    assert nodes == 0 and gits <= 10, (nodes, gits)


# ── docs ──────────────────────────────────────────────────────────────────────
def doc(name, content):
    return {"kind": "doc", "key": f"doc:{name}", "name": name, "content": content}


def test_plugin_docs_never_overwrite_or_remove_a_person_s_doc(fx, host):
    a = item_with_branch(fx)
    item_dir = fx.root / store.OPEN / a
    it = store.resolve_item(fx.root, a)
    from todo import docs
    docs.add(item_dir, it["uid"], "notes.md", b"mine\n", "2026-10-25T00:00:00.000Z")
    host.results({"refresh": [ran("p", [doc("notes.md", "theirs\n"), doc("plan.md", "v1\n"), doc("keep.md", "k\n")])]})
    refresh(fx.root, a)
    assert (item_dir / "docs" / "notes.md").read_text() == "mine\n"
    assert docs.read_meta(item_dir)["plan.md"]["plugin"] == "p/default"
    assert docs.read_meta(item_dir).get("notes.md", {}).get("plugin") is None
    (item_dir / "docs" / "plan.md").write_text("edited by a person\n")
    host.results({"refresh": [ran("p", [doc("plan.md", "v2\n")])]})
    refresh(fx.root, a)
    assert (item_dir / "docs" / "plan.md").read_text() == "edited by a person\n"
    assert not (item_dir / "docs" / "keep.md").exists()               # unedited and dropped: removed
    assert plugins.records(fx.root, it)["p/default"]["log"] == ["skipped doc plan.md: edited since the plugin wrote it"]
    host.results({"refresh": [ran("p", [])]})
    refresh(fx.root, a)
    assert (item_dir / "docs" / "plan.md").read_text() == "edited by a person\n"
    assert (item_dir / "docs" / "notes.md").read_text() == "mine\n"


def test_a_plugin_doc_syncs_with_its_plugin(fx, synced, host):
    cli_runs(synced, fx.root, "p/default")
    a = item_with_branch(fx)
    sync.run_round(fx.root, synced.client("alice"))
    host.results({"refresh": [ran("p", [doc("plan.md", "v1\n")])]})
    refresh(fx.root, a)
    sync.run_round(fx.root, synced.client("alice"))
    [row] = [r for r in synced.rows.values() if r["_entity"] == "doc"]
    assert row["plugin"] == "p/default"


# ── links and requests ────────────────────────────────────────────────────────
def test_url_dedupe_is_exact_and_covers_every_other_link(fx, host):
    a = item_with_branch(fx)
    run_cli(fx.root, ["url", a, "https://X.test/1", "--type", "pr"])
    twin = {**LINK, "key": "other-key"}
    host.results({"refresh": [ran("p", [LINK, twin])]})
    refresh(fx.root, a)
    assert [n["meta"]["url"] for n in plugin_notes(fx.root, a, "p/default")] == ["https://x.test/1"]


def test_a_request_posts_once_per_text_and_moves_a_local_item(fx, host):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}},
                   {"name": "watch", "shipped": False, "connections": [], "on": [{"status": {"to": "requested"}}],
                    "settings": {}}])
    a = item_with_branch(fx)
    ask = {"kind": "request", "key": "request:k", "text": "please do the thing"}
    host.results({"refresh": [ran("p", [ask])], "status": [ran("watch")]})
    refresh(fx.root, a)
    refresh(fx.root, a)
    it = store.get_item(fx.root, a)
    [req] = [n for n in it["notes"] if n["kind"] == "ticket-request"]
    assert req["uid"] == hash_uid("plugin", "p/default", it["uid"], "request:k#v1")
    assert it["status"] == "requested"
    assert {"type": "status", "from": "in-progress", "to": "requested"} in [c["event"] for c in host.calls()]


def test_status_triggers_take_from_and_to(fx, host, capsys):
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["manual"], "settings": {}}])
    run_cli(fx.root, ["plugin", "add", "p", "go", "--on", "status:*:review"])
    assert yamlio.read(fx.root / ".plugins.yaml")[gitfacts.store_repo(fx.root)[0]]["instances"]["p"][0]["on"] == [
        {"status": {"from": "*", "to": "review"}}]
    a = fx.item("Alpha", [])
    host.results({"status": [ran("p", inst="go")]})
    run_cli(fx.root, ["plugin", "test", "p", a, "--event", "status:todo:review"])
    assert host.calls()[-1]["event"] == {"type": "status", "from": "todo", "to": "review"}


# ── safety ────────────────────────────────────────────────────────────────────
def test_auth_with_server_refuses_a_host_wide_connection(fx, synced, host, monkeypatch, capsys):
    monkeypatch.setattr(sys, "stdin", io.StringIO("ghp\n"))
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["connection", "auth", "github", "--server"])
    assert "host-wide" in capsys.readouterr().err
    assert synced.plugin_creds == [] and connections.load_credentials() == {}


def test_auth_with_server_says_when_the_server_has_no_key(fx, synced, host, monkeypatch, capsys):
    synced.creds_unkeyed = True
    host.describe([], connections_=VERCEL)
    monkeypatch.setattr(sys, "stdin", io.StringIO("vc\n"))
    with pytest.raises(SystemExit):
        run_cli(fx.root, ["connection", "auth", "vercel", "--server"])
    assert "TODO_SECRET_KEY" in capsys.readouterr().err


def test_a_corrupt_credentials_file_is_never_overwritten(on, capsys):
    f = on / ".todo" / "credentials.json"
    f.parent.mkdir()
    f.write_text("{not json")
    with pytest.raises(connections.CredentialsError):
        connections.save_credential("*/github", "x")
    assert f.read_text() == "{not json"


def test_concurrent_runs_keep_every_record(fx, host):
    items = [item_with_branch(fx, f"Item {n}", f"feat/{n}") for n in range(6)]
    host.results({"refresh": [ran("p", [LINK])]})
    threads = [threading.Thread(target=refresh, args=(fx.root, i)) for i in items]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    runs = json.loads((fx.root / ".plugin-runs.json").read_text())
    assert sorted(runs) == sorted(plugins.item_key(store.resolve_item(fx.root, i)) for i in items)


def test_a_failed_describe_is_not_cached(fx, host, monkeypatch):
    (host.dir / "describe.json").write_text(json.dumps({"plugins": [], "instances": {}, "dropped": [], "connections": {},
                                                         "errors": ["the plugin host failed: boom"], "track": []}))
    key = gitfacts.store_repo(fx.root)[0]
    plugins.Context(fx.root).repo(key)
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"], "settings": {}}])
    assert plugins.Context(fx.root).repo(key)["described"]["plugins"][0]["name"] == "p"


def test_a_failed_plugins_fetch_backs_off(fx, synced, host):
    synced.plugins_down = True
    key = gitfacts.store_repo(fx.root)[0]
    plugins.Context(fx.root).stored(key)
    plugins.Context(fx.root).stored(key)
    assert synced.plugin_gets == 1


def test_an_item_without_a_uid_gets_one_on_its_first_run(fx, host):
    a = item_with_branch(fx)
    item_file = fx.root / store.OPEN / a / store.ITEM_FILE
    y, meta = yamlio.load(item_file)
    del meta["uid"]
    yamlio.save(y, item_file, meta)
    refresh(fx.root, a)
    assert store.resolve_item(fx.root, a)["uid"]


def test_a_store_wide_refresh_holds_items_one_at_a_time():
    from todo.cli import _named_items, build_parser
    assert _named_items(Path("/nowhere"), build_parser().parse_args(["refresh"])) == []


# ── the server's wire ─────────────────────────────────────────────────────────
def _removes(server):
    return [op for batch in server.pushes for op in batch if op["op"] == "remove"]


def test_a_runner_removal_tells_the_server_and_a_person_s_does_not(fx, synced, host):
    cli_runs(synced, fx.root, "p/default")
    a = item_with_branch(fx)
    sync.run_round(fx.root, synced.client("alice"))
    other = {**LINK, "key": "link:https://x.test/2", "url": "https://x.test/2"}
    host.results({"refresh": [ran("p", [LINK, other])]})
    refresh(fx.root, a)
    sync.run_round(fx.root, synced.client("alice"))
    host.results({"refresh": [ran("p", [other])]})
    refresh(fx.root, a)                                            # the runner drops LINK
    sync.run_round(fx.root, synced.client("alice"))
    [runner] = _removes(synced)
    assert runner["plugin"] is True
    [mine] = [n for n in plugin_notes(fx.root, a, "p/default")]
    run_cli(fx.root, ["unnote", a, str(mine["id"])])               # a person drops the other
    sync.run_round(fx.root, synced.client("alice"))
    assert "plugin" not in _removes(synced)[1]
    host.results({"refresh": [ran("p", [LINK, other])]})
    refresh(fx.root, a)
    sync.run_round(fx.root, synced.client("alice"))
    assert [n["meta"]["url"] for n in plugin_notes(fx.root, a, "p/default")] == [LINK["url"]]
    assert hash_uid("plugin", "p/default", store.resolve_item(fx.root, a)["uid"], LINK["key"]) in synced.rows


def test_secret_settings_show_as_set_and_never_reach_the_host(fx, synced, host, capsys):
    key = gitfacts.store_repo(fx.root)[0]
    host.describe([{"name": "p", "shipped": False, "connections": [], "on": ["push"],
                    "settings": {"token": {"label": "Token", "type": "secret", "optional": True}}}])
    synced.plugin_config[key] = {
        "instances": {"p": [{"id": "default", "name": "default", "settings": {"token": {"set": True}, "n": 1}}]},
        "plugins": [{"name": "p", "instances": [{"id": "default", "name": "default", "server_runs": False}]}]}
    run_cli(fx.root, ["plugin", "list"])
    assert "settings: token=(set), n=1" in capsys.readouterr().out
    a = item_with_branch(fx)
    refresh(fx.root, a)
    [call] = host.calls()
    assert call["storedInstances"]["p"][0]["settings"] == {"n": 1}


def test_connection_list_reads_repo_and_host_secrets_on_the_server(fx, synced, host, capsys):
    key = gitfacts.store_repo(fx.root)[0]
    host.describe([], connections_=VERCEL)
    synced.plugin_creds.append((key, "vercel", "x"))
    synced.host_secrets = ["github"]
    run_cli(fx.root, ["connection", "list"])
    out = capsys.readouterr().out
    assert "github" in out and "built in · secret here: none · on the server: yes" in out
    assert "vercel" in out and f"repo {key} · secret here: none · on the server: yes" in out


def test_adding_an_item_runs_one_refresh(fx, host):
    host.describe([{"name": "poll", "shipped": False, "connections": [], "on": [], "every": "1h", "settings": {}}])
    run_cli(fx.root, ["add", "New thing"])
    plugins.after_command(fx.root)
    assert [(c["item"]["id"], c["event"]) for c in host.calls()] == [("new-thing", {"type": "refresh"})]
