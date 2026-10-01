"""`cancelled` is terminal like `done`: hidden from the everyday list and filed
in CANCELLED/ — but with no `completed` stamp, since nothing was completed."""

from pathlib import Path

from todo import store
from todo.cli import build_parser


def run(file, argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_cancel_shortcut(root):
    run(root, ["cancel", "beta"])
    assert store.resolve_item(root, "beta")["status"] == "cancelled"
    assert store.resolve_item(root, "beta")["completed"] is None


def test_cancelled_hidden_from_list_shown_with_all(root, capsys):
    run(root, ["cancel", "beta"])
    capsys.readouterr()
    run(root, ["list"])
    assert "beta" not in capsys.readouterr().out
    run(root, ["list", "--all"])
    assert "beta" in capsys.readouterr().out
    run(root, ["list", "--status", "cancelled"])
    assert "beta" in capsys.readouterr().out


def test_cancel_moves_to_cancelled_and_archive_takes_done(root, capsys):
    run(root, ["done", "alpha"])
    run(root, ["cancel", "beta"])
    assert (root / "CANCELLED" / "beta").is_dir()
    assert (root / "OPEN" / "alpha").is_dir()
    capsys.readouterr()
    run(root, ["archive"])
    assert "1 item(s)" in capsys.readouterr().out
    assert (root / "ARCHIVED" / "alpha").is_dir()
    assert store.list_todos(root, [store.OPEN]) == []


def test_task_cancel_rolls_up(root, capsys):
    run(root, ["task", "add", "beta", "t1"])
    run(root, ["task", "add", "beta", "t2"])
    run(root, ["task", "done", "beta", "1"])
    run(root, ["task", "cancel", "beta", "2"])
    assert store.resolve_item(root, "beta")["calc_status"] == "done"
