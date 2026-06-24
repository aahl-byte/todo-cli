from pathlib import Path

import pytest

from todo import store
from todo.cli import build_parser


def run(file, argv):
    """Parse argv and dispatch, like main() but against an explicit file."""
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_task_add_and_list(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "write", "the", "docs"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "write the docs", "status": "todo", "phase": None}]

    run(todo_file, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "[0]" in out
    assert "write the docs" in out
    assert "todo" in out


def test_task_start_shortcut_sets_status_and_calc(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "start", "beta", "0"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "in-progress"
    assert it["calc_status"] == "in-progress"


def test_task_status_explicit(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "status", "beta", "0", "review"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "review"


def test_task_rm(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "rm", "beta", "0"])
    assert store.resolve_item(todo_file, "beta")["tasks"] == []


def test_task_bad_index_exits(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    with pytest.raises(SystemExit):
        run(todo_file, ["task", "done", "beta", "9"])


def test_task_add_with_phase_flag(todo_file):
    run(todo_file, ["task", "add", "beta", "scaffold", "--phase", "1"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["phase"] == 1


def test_task_phase_command_sets_and_clears(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "phase", "beta", "0", "2"])
    assert store.resolve_item(todo_file, "beta")["tasks"][0]["phase"] == 2
    run(todo_file, ["task", "phase", "beta", "0", "none"])
    assert store.resolve_item(todo_file, "beta")["tasks"][0]["phase"] is None


def test_task_phase_rejects_non_integer(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    with pytest.raises(SystemExit):
        run(todo_file, ["task", "phase", "beta", "0", "soon"])


def test_tasks_render_shows_phase_sorted(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "second", "--phase", "2"])
    run(todo_file, ["task", "add", "beta", "first", "--phase", "1"])
    capsys.readouterr()  # drop the add echoes; assert only on the listing
    run(todo_file, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "phase 1" in out and "phase 2" in out
    assert out.index("first") < out.index("second")  # sorted by phase
