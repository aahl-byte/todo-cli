"""The team lifecycle: new statuses and shortcuts, the agent → QA rule,
deployed as a complete status, and status history."""

import pytest

from todo import store
from todo.status import derive_calc_status

from .conftest import run_cli


def status(root, q="beta"):
    return store.resolve_item(root, q)["status"]


def folder(root, item_id):
    return next(f for f in store.FOLDERS if (root / f / item_id).is_dir())


@pytest.mark.parametrize("cmd,want", [
    ("request", "requested"), ("ready-qa", "ready-for-qa"), ("qa", "in-qa"),
    ("approve", "ready-to-deploy"), ("deploy", "deployed"),
])
def test_shortcuts_set_their_status(root, cmd, want):
    run_cli(root, [cmd, "beta"])
    assert status(root) == want


def test_reject_needs_text_and_files_a_qa_rejection(root):
    run_cli(root, ["qa", "beta"])
    with pytest.raises(SystemExit):
        run_cli(root, ["reject", "beta"])
    assert status(root) == "in-qa"
    run_cli(root, ["reject", "beta", "still", "broken", "@bob"])
    it = store.resolve_item(root, "beta")
    assert it["status"] == "qa-rejected"
    note = it["notes"][-1]
    assert note["kind"] == "qa-rejection"
    assert note["text"] == "still broken @bob"
    assert note["meta"]["mentions"] == ["bob"]
    assert note["meta"]["with_status"] == "qa-rejected"


def test_agent_cannot_hand_to_qa(root, monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.delenv("TODO_VIA")
    with pytest.raises(SystemExit):
        run_cli(root, ["ready-qa", "beta"])
    with pytest.raises(SystemExit):
        run_cli(root, ["status", "beta", "ready-for-qa"])
    assert status(root) == "todo"
    run_cli(root, ["--agent", "review", "beta"])
    assert status(root) == "review"


def test_human_flag_overrides_claudecode(root, monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.delenv("TODO_VIA")
    run_cli(root, ["--human", "ready-qa", "beta"])
    assert status(root) == "ready-for-qa"
    assert store.resolve_item(root, "beta")["history"][-1]["via"] == "human"


def test_deployed_is_complete_hidden_and_archived(root, capsys):
    run_cli(root, ["deploy", "beta"])
    it = store.resolve_item(root, "beta")
    assert it["completed"]
    capsys.readouterr()
    run_cli(root, ["list"])
    assert "beta" not in capsys.readouterr().out
    run_cli(root, ["archive"])
    assert folder(root, "beta") == "ARCHIVED"
    store.update_todo(root, "beta", {"priority": "high"})
    assert folder(root, "beta") == "ARCHIVED"
    run_cli(root, ["reopen", "beta"])
    assert store.resolve_item(root, "beta")["completed"] is None
    assert folder(root, "beta") == "OPEN"


def test_history_appends_once_per_real_change(root, capsys):
    run_cli(root, ["start", "beta"])
    run_cli(root, ["start", "beta"])
    run_cli(root, ["review", "beta"])
    hist = store.resolve_item(root, "beta")["history"]
    assert [(h["from"], h["to"], h["by"]) for h in hist] == [
        ("todo", "in-progress", "tester"), ("in-progress", "review", "tester")]
    assert all(h["uid"] for h in hist)
    run_cli(root, ["history", "beta"])
    assert "in-progress → review" in capsys.readouterr().out


def test_get_shows_only_the_last_three_transitions(root, capsys):
    for cmd in ["triage", "reopen", "start", "review", "start"]:
        run_cli(root, [cmd, "beta"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    out = capsys.readouterr().out
    assert "… 2 earlier" in out


@pytest.mark.parametrize("tasks,want", [
    (["deployed", "deployed"], "deployed"),
    (["done", "deployed"], "done"),
    (["in-qa", "review"], "in-qa"),
    (["ready-for-qa", "todo"], "ready-for-qa"),
    (["ready-to-deploy", "in-triage"], "ready-to-deploy"),
    (["requested", "todo"], "requested"),
])
def test_calc_status_ranks_team_statuses(tasks, want):
    assert derive_calc_status(tasks) == want


def test_task_shortcuts_skip_deploy(root):
    run_cli(root, ["task", "add", "beta", "x"])
    with pytest.raises(SystemExit):
        run_cli(root, ["task", "deploy", "beta", "1"])
    run_cli(root, ["task", "approve", "beta", "1"])
    assert store.resolve_item(root, "beta")["tasks"][0]["status"] == "ready-to-deploy"
