"""The sync client against a fake server: diff, push, pull, conflicts and
renumbering. Two stores, A and B, stand in for two teammates."""

import threading
import time

import pytest

from todo import remote, store, sync, yamlio

from .conftest import TS, run_cli
from .fake_server import FakeServer


@pytest.fixture
def server():
    return FakeServer()


def make(tmp_path, name, server):
    root = tmp_path / name / ".TODO"
    root.mkdir(parents=True)
    remote.save_sync_config(root, {"url": "http://fake", "project": "p", "deploy_step": True})
    return root


def rnd(root, server, who, **kw):
    return sync.run_round(root, server.client(who), **kw)


@pytest.fixture
def pair(tmp_path, server, monkeypatch):
    """A has one item with a task, note, log and check; B has adopted it."""
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    run_cli(a, ["task", "add", "login-bug", "repro", "--phase", "1"])
    run_cli(a, ["note", "login-bug", "why it breaks"])
    run_cli(a, ["log", "login-bug", "tried x"])
    run_cli(a, ["check", "add", "login-bug", "db-script", "migrate"])
    run_cli(a, ["review", "login-bug"])
    assert rnd(a, server, "alice").error is None
    assert rnd(b, server, "bob", adopt=True).error is None
    return a, b


def item(root, q="login-bug"):
    return store.resolve_item(root, q)


def test_push_creates_everything_once(pair, server):
    a, _ = pair
    kinds = sorted(r["_entity"] for r in server.rows.values() if r["_entity"] != "history")
    assert kinds == ["check", "item", "log", "note", "task"]
    before = len(server.pushes)
    report = rnd(a, server, "alice")
    assert report.pushed == 0
    assert len(server.pushes) == before


def test_adopt_brings_every_entity_across(pair):
    a, b = pair
    ia, ib = item(a), item(b)
    for key in ("uid", "title", "status", "creator"):
        assert ia[key] == ib[key]
    assert [(t["uid"], t["title"], t["phase"]) for t in ia["tasks"]] == \
        [(t["uid"], t["title"], t["phase"]) for t in ib["tasks"]]
    assert [n["text"] for n in ib["notes"]] == ["why it breaks"]
    assert [e["text"] for e in ib["log"]] == ["tried x"]
    assert [c["title"] for c in ib["checks"]] == ["migrate"]


def test_offline_stale_status_is_rejected_and_logged(pair, server, monkeypatch):
    a, b = pair
    monkeypatch.setenv("TODO_USER", "bob")
    run_cli(b, ["--human", "ready-qa", "login-bug"])
    run_cli(b, ["qa", "login-bug"])
    run_cli(b, ["comment", "login-bug", "testing now"])
    assert rnd(b, server, "bob").error is None

    monkeypatch.setenv("TODO_USER", "alice")
    server.offline = True
    run_cli(a, ["start", "login-bug"])
    run_cli(a, ["note", "login-bug", "offline thought"])
    assert rnd(a, server, "alice").error
    assert item(a)["status"] == "in-progress"
    server.offline = False

    report = rnd(a, server, "alice")
    assert report.error is None and report.rejected == 1
    it = item(a)
    assert it["status"] == "in-qa"
    assert {n["text"] for n in it["notes"]} >= {"offline thought", "testing now"}
    assert "offline status → in-progress not applied; bob set in-qa" in it["log"][-1]["text"]
    assert any("offline status" in m for m in report.messages)
    assert [(h["from"], h["to"]) for h in it["history"]] == [("todo", "review"), ("review", "in-qa")]
    assert all(not h["provisional"] for h in it["history"])


def test_offline_edit_chain_is_one_write(pair, server):
    a, _ = pair
    server.offline = True
    for cmd in ("start", "review", "start"):
        run_cli(a, [cmd, "login-bug"])
    rnd(a, server, "alice")
    server.offline = False
    report = rnd(a, server, "alice")
    assert report.rejected == 0
    sets = [op for op in server.pushes[-1] if op["op"] == "set"]
    assert [op["data"] for op in sets] == [{"status": "in-progress"}]


def test_push_only_round_advances_the_snapshot(pair, server):
    a, _ = pair
    run_cli(a, ["start", "login-bug"])
    rnd(a, server, "alice", push_only=True)
    run_cli(a, ["review", "login-bug"])
    report = rnd(a, server, "alice")
    assert report.rejected == 0
    assert server.rows[item(a)["uid"]]["status"] == "review"


def test_hand_and_drawer_edits_sync(pair, server):
    a, b = pair
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text().replace("priority: medium", "priority: high"))
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    assert item(b)["priority"] == "high"


def test_legacy_note_gets_a_uid_written_back(pair, server):
    a, b = pair
    d = a / "OPEN" / "login-bug" / "notes"
    (d / "2026-06-25T09-30-00.000Z-9.md").write_text("hand-written note\n")
    rnd(a, server, "alice")
    n = next(n for n in item(a)["notes"] if n["text"] == "hand-written note")
    assert n["uid"]
    rnd(b, server, "bob")
    assert "hand-written note" in [n["text"] for n in item(b)["notes"]]


def test_number_collision_renames_the_local_entry(pair, server):
    a, b = pair
    run_cli(a, ["note", "login-bug", "from a"])
    run_cli(b, ["note", "login-bug", "from b"])
    rnd(a, server, "alice")
    report = rnd(b, server, "bob")
    assert any("note [2] → [3]" in m for m in report.messages)
    notes = {n["text"]: n["id"] for n in item(b)["notes"]}
    assert notes == {"why it breaks": 1, "from a": 2, "from b": 3}
    rnd(a, server, "alice")
    assert {n["text"]: n["id"] for n in item(a)["notes"]} == notes


def test_item_id_collision_renames_the_directory(tmp_path, server):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    run_cli(a, ["add", "Login"])
    run_cli(b, ["add", "Login"])
    rnd(a, server, "alice")
    report = rnd(b, server, "bob")
    assert (b / "OPEN" / "login-2").is_dir()
    assert any("login → login-2" in m for m in report.messages)
    assert (b / "OPEN" / "login").is_dir()                  # A's item, pulled


def test_pull_keeps_comments_and_unknown_keys(pair, server):
    a, b = pair
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text("# keep me\n" + f.read_text() + "acceptance: it works\n")
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    assert "acceptance: it works" in (b / "OPEN" / "login-bug" / "TODO.yaml").read_text()
    run_cli(b, ["assign", "login-bug", "--dev", "bob"])
    rnd(b, server, "bob")
    rnd(a, server, "alice")
    text = f.read_text()
    assert text.startswith("# keep me\n")
    assert "acceptance: it works" in text
    assert "developer: bob" in text


def test_pull_keeps_an_edit_made_after_the_diff(pair, server):
    a, b = pair
    run_cli(b, ["assign", "login-bug", "--qa", "carol"])
    rnd(b, server, "bob")
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    client = server.client("alice")
    real = client.changes

    def changes_with_a_drawer_edit(project, since, limit=500):
        if f.read_text().count("qa_assignee: null"):
            f.write_text(f.read_text().replace("qa_assignee: null", "qa_assignee: dave"))
        return real(project, since, limit)

    client.changes = changes_with_a_drawer_edit
    sync.run_round(a, client)
    assert item(a)["qa_assignee"] == "dave"
    report = rnd(a, server, "alice")
    assert report.rejected == 1                    # carol was set first; dave was a stale edit
    assert item(a)["qa_assignee"] == "carol"


def test_removes_sync_and_carry_a_base(pair, server):
    a, b = pair
    run_cli(a, ["task", "rm", "login-bug", "1"])
    run_cli(a, ["check", "rm", "login-bug", "1"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    ib = item(b)
    assert ib["tasks"] == [] and ib["checks"] == []


def test_remove_over_a_newer_edit_is_rejected(pair, server):
    a, b = pair
    run_cli(b, ["task", "start", "login-bug", "1"])
    rnd(b, server, "bob")
    run_cli(a, ["task", "rm", "login-bug", "1"])
    report = rnd(a, server, "alice")
    assert report.rejected == 1
    assert server.rows[item(b)["tasks"][0]["uid"]]["status"] == "in-progress"


def test_task_reorder_syncs(pair, server):
    a, b = pair
    run_cli(a, ["task", "add", "login-bug", "second", "--phase", "1"])
    run_cli(a, ["task", "add", "login-bug", "third", "--phase", "1"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    run_cli(a, ["task", "move", "login-bug", "3", "--top"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    assert [t["title"] for t in item(b)["tasks"]] == ["third", "repro", "second"]


def test_rejection_rolls_back_with_its_status(pair, server, monkeypatch):
    a, b = pair
    for cmd in (["--human", "ready-qa"], ["qa"]):
        run_cli(a, cmd + ["login-bug"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    run_cli(b, ["approve", "login-bug"])
    rnd(b, server, "bob")
    run_cli(a, ["reject", "login-bug", "safari", "broken"])
    report = rnd(a, server, "alice")
    it = item(a)
    assert it["status"] == "ready-to-deploy"
    assert all(n["kind"] != "qa-rejection" for n in it["notes"])
    assert any("its text: safari broken" in e["text"] for e in it["log"])
    assert report.rejected >= 1


def test_agent_status_carries_via(pair, server):
    a, _ = pair
    run_cli(a, ["--agent", "start", "login-bug"])
    rnd(a, server, "alice")
    op = next(op for op in server.pushes[-1] if op["op"] == "set")
    assert op["via"] == "agent"


def test_forced_deploy_carries_force(pair, server):
    a, _ = pair
    run_cli(a, ["approve", "login-bug"])
    run_cli(a, ["deploy", "login-bug", "--force"])
    rnd(a, server, "alice")
    op = next(op for op in server.pushes[-1] if op["op"] == "set")
    assert op["force"] is True


def test_no_deploy_step_approves_to_done(pair, server):
    a, _ = pair
    server.deploy_step = False
    rnd(a, server, "alice")
    run_cli(a, ["approve", "login-bug"])
    assert item(a)["status"] == "done"


def test_lock_makes_a_second_command_wait(tmp_path, server):
    a = make(tmp_path, "a", server)
    order = []

    def second():
        with sync.locked(a):
            order.append("second")

    with sync.locked(a):
        t = threading.Thread(target=second)
        t.start()
        time.sleep(0.2)
        order.append("first")
    t.join(2)
    assert order == ["first", "second"]


def test_offline_env_skips_the_round(pair, monkeypatch):
    a, _ = pair
    monkeypatch.setenv("TODO_OFFLINE", "1")
    assert sync.quiet_round(a) is None


def test_quiet_round_reports_offline_and_keeps_changes(pair, server, monkeypatch, capsys):
    a, _ = pair
    monkeypatch.setattr(remote, "remote_for", lambda root: server.client("alice"))
    server.offline = True
    run_cli(a, ["start", "login-bug"])
    sync.quiet_round(a)
    assert "offline" in capsys.readouterr().err
    assert [op["op"] for op in sync.pending(a)] == ["set"]


# ── regressions from the phase 2 validation ──────────────────────────────────
def test_children_arrive_even_when_their_item_changed_later(tmp_path, server, monkeypatch):
    a, c = make(tmp_path, "a", server), make(tmp_path, "c", server)
    run_cli(a, ["add", "Login bug"])
    run_cli(a, ["task", "add", "login-bug", "repro"])
    run_cli(a, ["check", "add", "login-bug", "db-script", "migrate"])
    run_cli(a, ["start", "login-bug"])
    rnd(a, server, "alice")
    rnd(c, server, "carol", adopt=True)
    ic = item(c)
    assert [t["title"] for t in ic["tasks"]] == ["repro"]
    assert [x["title"] for x in ic["checks"]] == ["migrate"]
    assert [(h["from"], h["to"]) for h in ic["history"]] == [("todo", "in-progress")]


def test_history_from_before_linking_reaches_the_server(tmp_path, server):
    a = make(tmp_path, "a", server)
    run_cli(a, ["add", "Login bug"])
    run_cli(a, ["start", "login-bug"])
    run_cli(a, ["review", "login-bug"])
    rnd(a, server, "alice")
    rows = sorted((r["n"], r["from_status"], r["to_status"]) for r in server.rows.values() if r["_entity"] == "history")
    assert rows == [(1, "todo", "in-progress"), (2, "in-progress", "review")]
    hist = item(a)["history"]
    assert [(h["from"], h["to"], h["provisional"]) for h in hist] == [
        ("todo", "in-progress", False), ("in-progress", "review", False)]


class Flaky:
    """A client whose next push applies on the server but loses its response."""

    def __init__(self, server, who):
        self.inner = server.client(who)
        self.drop_next = True

    def push(self, project, ops):
        results = self.inner.push(project, ops)
        if self.drop_next:
            self.drop_next = False
            raise remote.RemoteError("timed out")
        return results

    def changes(self, project, since, limit=500):
        return self.inner.changes(project, since, limit)


def test_lost_push_response_replays_without_self_rejection(pair, server):
    a, _ = pair
    run_cli(a, ["status", "login-bug", "in-progress"])
    flaky = Flaky(server, "alice")
    assert sync.run_round(a, flaky).error
    run_cli(a, ["status", "login-bug", "blocked"])
    report = sync.run_round(a, flaky)
    assert report.error is None and report.rejected == 0
    assert server.rows[item(a)["uid"]]["status"] == "blocked"
    assert item(a)["status"] == "blocked"


def test_lost_create_response_keeps_later_edits(tmp_path, server):
    a = make(tmp_path, "a", server)
    run_cli(a, ["add", "Login"])
    flaky = Flaky(server, "alice")
    sync.run_round(a, flaky)
    store.update_todo(a, "login", {"title": "Login v2"})
    report = sync.run_round(a, flaky)
    assert report.rejected == 0
    assert server.rows[item(a, "login")["uid"]]["title"] == "Login v2"


def test_group_rollback_keeps_the_other_fields_for_next_round(pair, server):
    a, b = pair
    for cmd in (["--human", "ready-qa"], ["qa"]):
        run_cli(a, cmd + ["login-bug"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    run_cli(b, ["approve", "login-bug"])
    rnd(b, server, "bob")
    run_cli(a, ["reject", "login-bug", "broken"])
    store.update_todo(a, "login-bug", {"title": "Login bug (Safari)"})
    rnd(a, server, "alice")
    rnd(a, server, "alice")
    assert server.rows[item(a)["uid"]]["title"] == "Login bug (Safari)"
    assert item(a)["status"] == "ready-to-deploy"


def test_unreadable_super_phase_never_removes_children(pair, server):
    a, _ = pair
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text().replace("super-phase: null", "super-phase: two"))
    assert sync.pending(a) == []


def test_pulled_item_whose_id_is_taken_locally_still_arrives(tmp_path, server, monkeypatch):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    run_cli(a, ["add", "Login bug"])
    rnd(a, server, "alice")
    run_cli(b, ["add", "Login bug"])
    rnd(b, server, "bob", adopt=True)
    assert (b / "OPEN" / "login-bug").is_dir() and (b / "OPEN" / "login-bug-2").is_dir()
    uids = {store.resolve_item(b, i)["uid"] for i in ("login-bug", "login-bug-2")}
    assert uids == {r["uid"] for r in server.rows.values() if r["_entity"] == "item"}


def test_invalid_values_are_logged_once_and_reverted(pair, server):
    a, _ = pair
    f = next((a / "OPEN" / "login-bug" / "phase-1").glob("TASKS.yaml"))
    f.write_text(f.read_text().replace("status: todo", "status: wip"))
    rnd(a, server, "alice")
    rnd(a, server, "alice")
    logs = [e["text"] for e in item(a)["log"] if "not applied" in e["text"]]
    assert len(logs) == 1
    assert item(a)["tasks"][0]["status"] == "todo"


def test_uid_exists_adopts_the_server_copy(pair, server):
    a, b = pair
    uid = item(a)["notes"][0]["uid"]
    server.rows[uid]["text"] = "server text"
    del server.rows[uid]["versions"]["text"]
    sync.save_snapshot(b, {**sync.load_snapshot(b), "entities": {
        k: v for k, v in sync.load_snapshot(b)["entities"].items() if k != uid}})
    report = rnd(b, server, "bob")
    assert any("took the server's copy" in m for m in report.messages)
    assert item(b)["notes"][0]["text"] == "server text"


def test_op_order_and_bases(pair, server):
    a, _ = pair
    run_cli(a, ["approve", "login-bug"])
    run_cli(a, ["check", "done", "login-bug", "1"])
    run_cli(a, ["deploy", "login-bug"])
    run_cli(a, ["note", "login-bug", "shipped"])
    run_cli(a, ["task", "rm", "login-bug", "1"])
    snap = sync.load_snapshot(a)["entities"]
    rnd(a, server, "alice")
    ops = server.pushes[-1]
    assert [(op["op"], op["entity"]) for op in ops] == [
        ("create", "note"), ("set", "check"), ("set", "item"), ("remove", "task")]
    check_op, item_op, rm_op = ops[1], ops[2], ops[3]
    assert check_op["base"] == {"status": snap[check_op["uid"]]["versions"]["status"]}
    assert item_op["data"] == {"status": "deployed"}
    assert rm_op["base"] == snap[rm_op["uid"]]["versions"]


def test_main_runs_every_command_inside_the_lock(pair, server, monkeypatch, tmp_path):
    a, _ = pair
    events = []

    class Recorder:
        def __init__(self, root):
            events.append("lock")

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            events.append("unlock")

    monkeypatch.setattr(sync, "locked", Recorder)
    monkeypatch.setattr(sync, "quiet_round", lambda root, push_only=False: events.append("push" if push_only else "round"))
    from todo import cli
    monkeypatch.setattr("sys.argv", ["todo", "--dir", str(a), "note", "login-bug", "hi"])
    cli.main()
    assert events == ["lock", "round", "push", "unlock"]


def test_null_unknown_keys_survive_a_pull(pair, server):
    a, b = pair
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text() + "acceptance: null\n")
    run_cli(b, ["assign", "login-bug", "--dev", "bob"])
    rnd(b, server, "bob")
    rnd(a, server, "alice")
    assert "acceptance: null" in f.read_text()


def test_identical_checks_get_distinct_fallback_uids(pair, server):
    a, _ = pair
    f = a / "OPEN" / "login-bug" / "checks" / "CHECKS.yaml"
    f.write_text("checks:\n  - {id: 1, kind: other, title: smoke, payload: null, timing: pre-deploy, status: pending}\n"
                 "  - {id: 2, kind: other, title: smoke, payload: null, timing: pre-deploy, status: pending}\n")
    sync.ensure_uids(a, "p")
    uids = [c["uid"] for c in item(a)["checks"]]
    assert len(set(uids)) == 2


# ── regressions from the phase 2 re-validation ───────────────────────────────
def test_children_of_a_refused_item_push_once_it_is_fixed(tmp_path, server, monkeypatch):
    a = make(tmp_path, "a", server)
    run_cli(a, ["add", "Login"])
    run_cli(a, ["note", "login", "context"])
    run_cli(a, ["task", "add", "login", "t1"])
    real_create = server._create

    def refuse_blank(op, author):
        if op["entity"] == "item" and not str(op["data"].get("title", "")).strip():
            return {"op_id": op["op_id"], "status": "rejected", "reason": "invalid-title"}
        return real_create(op, author)

    monkeypatch.setattr(server, "_create", refuse_blank)
    f = a / "OPEN" / "login" / "TODO.yaml"
    f.write_text(f.read_text().replace("title: Login", "title: '   '"))
    rnd(a, server, "alice")
    for _ in range(3):
        rnd(a, server, "alice")
    assert len([e for e in item(a, "login")["log"] if "not applied" in e["text"]]) == 1
    f.write_text(f.read_text().replace("title: '   '", "title: Login"))
    rnd(a, server, "alice")
    kinds = sorted(r["_entity"] for r in server.rows.values() if r["_entity"] != "history")
    assert kinds == ["item", "log", "note", "task"]


def test_a_newer_change_supersedes_a_deferred_one(pair, server):
    a, b = pair
    snap = sync.load_snapshot(a)
    uid = item(a)["uid"]
    stale = {"seq": 1, "entity": "item", "uid": uid, "item_uid": uid, "deleted": False,
             "data": {**server.rows[uid], "title": "stale title"}}
    stale["data"].pop("_entity")
    snap["deferred"] = [stale]
    sync.save_snapshot(a, snap)
    run_cli(b, ["assign", "login-bug", "--dev", "bob"])
    rnd(b, server, "bob")
    rnd(a, server, "alice")
    assert item(a)["title"] == "Login bug"
    assert sync.load_snapshot(a)["deferred"] == []


def test_a_bad_super_phase_does_not_stop_other_pulls(pair, server):
    a, b = pair
    run_cli(b, ["add", "Other"])
    rnd(b, server, "bob")
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text().replace("super-phase: null", "super-phase: abc"))
    run_cli(b, ["assign", "login-bug", "--dev", "bob"])
    run_cli(b, ["assign", "other", "--dev", "bob"])
    rnd(b, server, "bob")
    report = rnd(a, server, "alice")
    assert report.error is None
    assert item(a, "other")["developer"] == "bob"
    f.write_text(f.read_text().replace("super-phase: abc", "super-phase: null"))
    rnd(a, server, "alice")
    assert item(a)["developer"] == "bob"


def test_replayed_rejection_does_not_clobber_a_newer_edit(pair, server, monkeypatch):
    a, _ = pair
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.delenv("TODO_VIA")
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text().replace("status: review", "status: ready-for-qa"))
    real_set = server._set

    def agent_rule(op, author):
        if op["entity"] == "item" and op["data"].get("status") == "ready-for-qa" and op.get("via") == "agent":
            return {"op_id": op["op_id"], "status": "rejected",
                    "rejected": [{"field": "status", "reason": "agent-handoff", "server_value": "review",
                                  "version": server.rows[op["uid"]]["versions"]["status"]}], "versions": {}}
        return real_set(op, author)

    monkeypatch.setattr(server, "_set", agent_rule)
    flaky = Flaky(server, "alice")
    sync.run_round(a, flaky)
    monkeypatch.setenv("TODO_VIA", "human")
    run_cli(a, ["start", "login-bug"])
    sync.run_round(a, flaky)
    assert item(a)["status"] == "in-progress"
    assert server.rows[item(a)["uid"]]["status"] == "in-progress"


def test_held_status_keeps_its_provisional_history(pair, server):
    a, b = pair
    for cmd in (["--human", "ready-qa"], ["qa"]):
        run_cli(a, cmd + ["login-bug"])
    rnd(a, server, "alice")
    rnd(b, server, "bob")
    run_cli(b, ["approve", "login-bug"])
    rnd(b, server, "bob")
    run_cli(a, ["--agent", "reject", "login-bug", "broken"])
    rnd(a, server, "alice")
    assert all(not h["provisional"] for h in item(a)["history"])   # stale: server status adopted


# ── regressions from the third sync validation ───────────────────────────────
def test_superseded_replay_keeps_the_newer_forced_deploy(pair, server):
    a, _ = pair
    run_cli(a, ["approve", "login-bug"])
    rnd(a, server, "alice")
    run_cli(a, ["start", "login-bug"])
    flaky = Flaky(server, "alice")
    sync.run_round(a, flaky)
    run_cli(a, ["status", "login-bug", "deployed", "--force"])
    sync.run_round(a, flaky)
    pushed = [op for batch in server.pushes for op in batch if op["op"] == "set" and op["data"].get("status") == "deployed"]
    assert pushed and pushed[-1].get("force") is True


def test_an_unparseable_item_file_does_not_stop_the_round(pair, server):
    a, b = pair
    run_cli(b, ["add", "Other"])
    rnd(b, server, "bob")
    f = a / "OPEN" / "login-bug" / "TODO.yaml"
    f.write_text(f.read_text().replace("title: Login bug", "title: [Login bug"))
    report = rnd(a, server, "alice")
    assert report.error is None
    assert (a / "OPEN" / "other").is_dir()


def test_a_replayed_refusal_parks_the_refused_data_not_a_later_fix(tmp_path, server, monkeypatch):
    a = make(tmp_path, "a", server)
    run_cli(a, ["add", "Login"])
    real_create = server._create

    def refuse_blank(op, author):
        if op["entity"] == "item" and not str(op["data"].get("title", "")).strip():
            return {"op_id": op["op_id"], "status": "rejected", "reason": "invalid-title"}
        return real_create(op, author)

    monkeypatch.setattr(server, "_create", refuse_blank)
    f = a / "OPEN" / "login" / "TODO.yaml"
    f.write_text(f.read_text().replace("title: Login", "title: '   '"))
    flaky = Flaky(server, "alice")
    sync.run_round(a, flaky)
    f.write_text(f.read_text().replace("title: '   '", "title: Login fixed"))
    sync.run_round(a, flaky)
    sync.run_round(a, flaky)
    assert [r["title"] for r in server.rows.values() if r["_entity"] == "item"] == ["Login fixed"]


def test_a_held_status_keeps_its_provisional_history_until_it_lands(pair, server):
    a, b = pair
    for cmd in (["--human", "ready-qa"], ["qa"]):
        run_cli(a, cmd + ["login-bug"])
    rnd(a, server, "alice")
    real_apply = server.apply

    def roll_back_everything(ops, author):
        return [{"op_id": op["op_id"], "status": "rejected", "reason": "group-rolled-back"} for op in ops]

    server.apply = roll_back_everything
    run_cli(a, ["--agent", "start", "login-bug"])
    rnd(a, server, "alice", push_only=True)
    assert any(h["provisional"] and h["to"] == "in-progress" for h in item(a)["history"])
    server.apply = real_apply
    rnd(a, server, "alice")
    op = next(op for op in server.pushes[-1] if op["op"] == "set")
    assert op["via"] == "agent"


# ── regressions from the final validation ────────────────────────────────────
def test_one_malformed_tasks_file_does_not_stop_sync(pair, server):
    a, b = pair
    run_cli(b, ["add", "Other"])
    rnd(b, server, "bob")
    (a / "OPEN" / "login-bug" / "phase-1" / "TASKS.yaml").write_text("tasks:\n  - id: [oops\n")
    report = rnd(a, server, "alice")
    assert report.error is None
    assert (a / "OPEN" / "other").is_dir()


def test_a_refused_batch_is_split_and_the_bad_op_parked(pair, server, monkeypatch):
    a, _ = pair
    run_cli(a, ["note", "login-bug", "fine"])
    run_cli(a, ["note", "login-bug", "poison"])
    client = server.client("alice")
    real = client.push

    def picky(project, ops):
        if any(op["entity"] == "note" and "poison" in op["data"].get("text", "") for op in ops):
            raise remote.RemoteError("400 bad op", 400)
        return real(project, ops)

    client.push = picky
    report = sync.run_round(a, client)
    assert report.error is None
    texts = {r.get("text") for r in server.rows.values() if r["_entity"] == "note"}
    assert "fine" in texts and "poison" not in texts
    assert sync.load_outbox(a) == []
    assert any("refused by the server (400)" in m for m in report.messages)
    assert sync.run_round(a, client).error is None


def test_integer_uids_in_files_are_read_as_strings(pair):
    a, _ = pair
    f = a / "OPEN" / "login-bug" / "phase-1" / "TASKS.yaml"
    import re
    f.write_text(re.sub(r"uid: [^,}]+", "uid: 42", f.read_text()))
    assert store.resolve_item(a, "login-bug")["tasks"][0]["uid"] == "42"


def test_groups_stay_in_one_batch(monkeypatch):
    monkeypatch.setattr(sync, "BATCH", 2)
    ops = [{"op_id": str(i), "uid": str(i), "op": "set", "entity": "item", "item_uid": "x", "data": {}} for i in range(3)]
    ops[1]["group"] = ops[2]["group"] = "g"
    batches = sync._batches(ops)
    assert [[op["op_id"] for op in b] for b in batches] == [["0"], ["1", "2"]]


def test_pulled_delete_lands_when_the_item_also_moved_folder(pair, server):
    a, b = pair
    run_cli(b, ["defer", "login-bug"])
    run_cli(b, ["unnote", "login-bug", "1"])
    rnd(b, server, "bob")
    report = rnd(a, server, "alice")
    assert (a / "DEFERRED" / "login-bug").is_dir()
    assert item(a)["notes"] == []
    assert not any("removed" in m for m in report.messages)


def test_adopt_takes_the_server_value_over_a_stale_clone(tmp_path, server):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    run_cli(a, ["add", "Login"])
    import shutil
    shutil.copytree(a / "OPEN", b / "OPEN")        # b is a clone made before the next edit
    rnd(a, server, "alice")
    run_cli(a, ["start", "login"])
    rnd(a, server, "alice")
    rnd(b, server, "bob", adopt=True)
    assert item(b, "login")["status"] == "in-progress"
    assert server.rows[item(a, "login")["uid"]]["status"] == "in-progress"


def test_the_cursor_survives_a_pull_that_fails_midway(pair, server, monkeypatch):
    a, b = pair
    for i in range(3):
        run_cli(b, ["note", "login-bug", f"n{i}"])
    rnd(b, server, "bob")
    client = server.client("alice")
    real = client.changes
    calls = []

    def one_page_then_fail(project, since, limit=500):
        calls.append(since)
        if len(calls) > 1:
            raise remote.RemoteError("timed out")
        return real(project, since, 1)

    client.changes = one_page_then_fail
    before = sync.load_snapshot(a)["cursor"]
    sync.run_round(a, client)
    assert sync.load_snapshot(a)["cursor"] > before


def test_relinking_to_another_project_starts_fresh(pair, server, monkeypatch):
    a, _ = pair
    from todo import cli
    sync.save_outbox(a, [{"op_id": "x"}])
    monkeypatch.setattr(remote, "token_for", lambda url: "t")

    class FakeRemote:
        def __init__(self, *a, **k):
            pass

        def ensure_project(self, key):
            return {"deploy_step": True}

    monkeypatch.setattr(remote, "Remote", FakeRemote)
    monkeypatch.setattr(sync, "run_round", lambda root, rem, adopt=False: sync.Report())
    args = type("A", (), {"remote": "http://fake", "project": "other", "name": None})()
    cli._link_remote(a.parent, args)
    assert not (a / ".sync" / "snapshot.json").exists()
    assert sync.load_outbox(a) == []


def test_notes_keep_their_authors_via(pair, server, monkeypatch):
    a, _ = pair
    run_cli(a, ["--human", "note", "login-bug", "by a person"])
    monkeypatch.setenv("TODO_VIA", "agent")
    rnd(a, server, "alice")
    op = next(op for op in server.pushes[-1] if op["entity"] == "note")
    assert op["via"] == "human"


def test_config_with_tokens_is_private(tmp_path, monkeypatch):
    from todo import identity
    monkeypatch.setattr(identity.Path, "home", classmethod(lambda cls: tmp_path))
    remote.save_login("http://x", "alice", "secret")
    assert (identity.config_path().stat().st_mode & 0o777) == 0o600


# ── regressions from the last re-validation ──────────────────────────────────
def test_a_404_is_a_round_error_and_parks_nothing(pair, server):
    a, _ = pair
    run_cli(a, ["note", "login-bug", "while the server was gone"])
    client = server.client("alice")
    real = client.push
    client.push = lambda project, ops: (_ for _ in ()).throw(remote.RemoteError("404 no such project", 404))
    assert sync.run_round(a, client).error
    assert sync.load_snapshot(a)["stuck"] == {}
    client.push = real
    sync.run_round(a, client)
    assert "while the server was gone" in {r.get("text") for r in server.rows.values()}


def test_an_item_created_into_qa_by_a_person_syncs_from_an_agent_session(tmp_path, server, monkeypatch):
    a = make(tmp_path, "a", server)
    run_cli(a, ["add", "Login"])
    run_cli(a, ["--human", "start", "login"])
    run_cli(a, ["--human", "ready-qa", "login"])
    monkeypatch.setenv("TODO_VIA", "agent")
    rnd(a, server, "alice")
    op = next(op for op in server.pushes[-1] if op["entity"] == "item")
    assert op["via"] == "human"


def test_relinking_the_same_project_keeps_unpushed_local_edits(pair, server):
    a, b = pair
    run_cli(b, ["start", "login-bug"])
    rnd(b, server, "bob")
    store.update_todo(a, "login-bug", {"title": "Edited locally"})
    rnd(a, server, "alice", adopt=True)
    assert item(a)["title"] == "Edited locally"
    assert server.rows[item(a)["uid"]]["title"] == "Edited locally"


def test_first_link_reports_what_the_server_overwrote(tmp_path, server):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    run_cli(a, ["add", "Login"])
    import shutil
    shutil.copytree(a / "OPEN", b / "OPEN")
    rnd(a, server, "alice")
    run_cli(a, ["start", "login"])
    rnd(a, server, "alice")
    report = rnd(b, server, "bob", adopt=True)
    assert any("took the server's status" in m for m in report.messages)


def test_a_re_added_task_with_a_removed_uid_gets_a_fresh_one(pair, server):
    a, _ = pair
    f = a / "OPEN" / "login-bug" / "phase-1" / "TASKS.yaml"
    f.write_text(f.read_text() + "  - {id: 2, title: write docs, status: todo}\n")
    rnd(a, server, "alice")
    run_cli(a, ["task", "rm", "login-bug", "2"])
    rnd(a, server, "alice")
    f.write_text(f.read_text() + "  - {id: 2, title: write docs, status: todo}\n")
    rnd(a, server, "alice")
    rnd(a, server, "alice")
    assert [t["title"] for t in item(a)["tasks"]] == ["repro", "write docs"]
    live = [r["title"] for r in server.rows.values() if r["_entity"] == "task"]
    assert sorted(live) == ["repro", "write docs"]


def test_splitting_a_refused_batch_keeps_groups_whole(pair, server, monkeypatch):
    seen = []
    ops = [{"op_id": "g1", "uid": "1", "group": "G", "op": "set", "entity": "item", "item_uid": "x", "data": {}},
           {"op_id": "g2", "uid": "2", "group": "G", "op": "create", "entity": "note", "item_uid": "x", "data": {}},
           {"op_id": "z", "uid": "3", "op": "set", "entity": "task", "item_uid": "x", "data": {}}]

    class Refuser:
        def push(self, project, batch):
            seen.append([op["op_id"] for op in batch])
            raise remote.RemoteError("400", 400)

    a, _ = pair
    sync._push(a, Refuser(), "p", ops, sync.scan(a), sync.load_snapshot(a), sync.Report(), set(), set())
    assert ["g1"] not in seen and ["g2", "z"] not in seen
    assert ["g1", "g2"] in seen and ["z"] in seen


def test_a_parked_remove_is_not_retried(pair, server):
    a, _ = pair
    run_cli(a, ["task", "rm", "login-bug", "1"])
    client = server.client("alice")
    real = client.push

    def refuse_removes(project, ops):
        if any(op["op"] == "remove" for op in ops):
            raise remote.RemoteError("400", 400)
        return real(project, ops)

    client.push = refuse_removes
    for _ in range(3):
        sync.run_round(a, client)
    assert len([e for e in item(a)["log"] if "refused by the server" in e["text"]]) == 1


def test_relinking_to_another_project_issues_fresh_uids(pair, server, monkeypatch):
    a, _ = pair
    from todo import cli
    old = {item(a)["uid"], item(a)["tasks"][0]["uid"], item(a)["notes"][0]["uid"]}
    monkeypatch.setattr(remote, "token_for", lambda url: "t")

    class FakeRemote:
        def __init__(self, *a, **k):
            pass

        def ensure_project(self, key):
            return {"deploy_step": True}

    monkeypatch.setattr(remote, "Remote", FakeRemote)
    monkeypatch.setattr(sync, "run_round", lambda root, rem, adopt=False: sync.Report())
    cli._link_remote(a.parent, type("A", (), {"remote": "http://fake", "project": "other", "name": None})())
    new = {item(a)["uid"], item(a)["tasks"][0]["uid"], item(a)["notes"][0]["uid"]}
    assert not (old & new)
