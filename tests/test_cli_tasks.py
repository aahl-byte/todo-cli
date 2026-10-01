from pathlib import Path

import pytest

from todo import store
from todo.cli import build_parser


def run(file, argv):
    """Parse argv and dispatch, like main() but against an explicit file."""
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_task_add_and_list(root, capsys):
    run(root, ["task", "add", "beta", "write", "the", "docs"])
    it = store.resolve_item(root, "beta")
    assert it["tasks"] == [{"id": 1, "title": "write the docs", "status": "todo", "phase": None}]

    run(root, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "[1]" in out
    assert "write the docs" in out
    assert "todo" in out


def test_task_start_shortcut_sets_status_and_calc(root, capsys):
    run(root, ["task", "add", "beta", "t1"])   # id 1
    run(root, ["task", "start", "beta", "1"])
    it = store.resolve_item(root, "beta")
    assert it["tasks"][0]["status"] == "in-progress"
    assert it["calc_status"] == "in-progress"


def test_task_status_explicit(root):
    run(root, ["task", "add", "beta", "t1"])   # id 1
    run(root, ["task", "status", "beta", "1", "review"])
    it = store.resolve_item(root, "beta")
    assert it["tasks"][0]["status"] == "review"


def test_task_rm(root):
    run(root, ["task", "add", "beta", "t1"])   # id 1
    run(root, ["task", "rm", "beta", "1"])
    assert store.resolve_item(root, "beta")["tasks"] == []


def test_task_bad_id_exits(root):
    run(root, ["task", "add", "beta", "t1"])
    with pytest.raises(SystemExit):
        run(root, ["task", "done", "beta", "9"])


def test_task_add_with_phase_flag(root):
    run(root, ["task", "add", "beta", "scaffold", "--phase", "1"])
    it = store.resolve_item(root, "beta")
    assert it["tasks"][0]["phase"] == 1


def test_task_phase_command_sets_and_clears(root):
    run(root, ["task", "add", "beta", "t1"])   # id 1
    run(root, ["task", "phase", "beta", "1", "2"])
    assert store.resolve_item(root, "beta")["tasks"][0]["phase"] == 2
    run(root, ["task", "phase", "beta", "1", "none"])
    assert store.resolve_item(root, "beta")["tasks"][0]["phase"] is None


def test_task_phase_rejects_non_integer(root):
    run(root, ["task", "add", "beta", "t1"])   # id 1
    with pytest.raises(SystemExit):
        run(root, ["task", "phase", "beta", "1", "soon"])


def test_tasks_render_shows_phase_sorted(root, capsys):
    run(root, ["task", "add", "beta", "second", "--phase", "2"])
    run(root, ["task", "add", "beta", "first", "--phase", "1"])
    capsys.readouterr()  # drop the add echoes; assert only on the listing
    run(root, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "phase 1" in out and "phase 2" in out
    assert out.index("first") < out.index("second")  # sorted by phase


def test_status_name_as_legacy_command(root):
    # every one of the 7 statuses works as a bare subcommand
    for status in ["todo", "in-triage", "in-progress", "review",
                   "blocked", "deferred", "done"]:
        run(root, [status, "beta"])
        assert store.resolve_item(root, "beta")["status"] == status
