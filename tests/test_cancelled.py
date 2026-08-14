"""`cancelled` is terminal like `done`: hidden from the everyday list, swept up
by archive — but with no `completed` stamp, since nothing was completed."""

from pathlib import Path

from todo import store
from todo.cli import build_parser


def run(file, argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_cancel_shortcut(todo_file):
    run(todo_file, ["cancel", "beta"])
    assert store.resolve_item(todo_file, "beta")["status"] == "cancelled"
    assert store.resolve_item(todo_file, "beta")["completed"] is None


def test_cancelled_hidden_from_list_shown_with_all(todo_file, capsys):
    run(todo_file, ["cancel", "beta"])
    capsys.readouterr()
    run(todo_file, ["list"])
    assert "beta" not in capsys.readouterr().out
    run(todo_file, ["list", "--all"])
    assert "beta" in capsys.readouterr().out
    run(todo_file, ["list", "--status", "cancelled"])
    assert "beta" in capsys.readouterr().out


def test_archive_takes_done_and_cancelled(todo_file, capsys):
    run(todo_file, ["done", "alpha"])
    run(todo_file, ["cancel", "beta"])
    capsys.readouterr()
    run(todo_file, ["archive"])
    assert "2 item(s)" in capsys.readouterr().out
    assert store.list_todos(todo_file) == []
    archive = next((todo_file.parent / "ARCHIVE" / "TODO").iterdir())
    assert {it["id"] for it in store.list_todos(archive)} == {"alpha", "beta"}


def test_task_cancel_rolls_up(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "add", "beta", "t2"])
    run(todo_file, ["task", "done", "beta", "1"])
    run(todo_file, ["task", "cancel", "beta", "2"])
    assert store.resolve_item(todo_file, "beta")["calc_status"] == "done"
