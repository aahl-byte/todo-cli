"""Status folders: an item's status picks OPEN/DEFERRED/CANCELLED/ARCHIVED, and
the CLI reads only the folders a command needs."""

import os
from pathlib import Path

from todo import store
from todo.cli import build_parser

from .conftest import TS


def run(root, argv):
    args = build_parser().parse_args(argv)
    args.func(Path(root), args)


def folder(root, item_id):
    return next(f for f in store.FOLDERS if (root / f / item_id).is_dir())


def test_status_changes_move_the_item(root):
    run(root, ["defer", "beta"])
    assert folder(root, "beta") == "DEFERRED"
    run(root, ["start", "beta"])
    assert folder(root, "beta") == "OPEN"
    run(root, ["cancel", "beta"])
    assert folder(root, "beta") == "CANCELLED"


def test_done_stays_open_until_archived_then_stays_archived(root):
    run(root, ["done", "alpha"])
    assert folder(root, "alpha") == "OPEN"
    run(root, ["archive"])
    assert folder(root, "alpha") == "ARCHIVED"
    store.update_todo(root, "alpha", {"priority": "high"})
    assert folder(root, "alpha") == "ARCHIVED"
    run(root, ["reopen", "alpha"])
    assert folder(root, "alpha") == "OPEN"


def test_notes_and_tasks_travel_with_the_item(root):
    store.add_task(root, "beta", "t", phase=1)
    store.add_note(root, "beta", "n", TS)
    run(root, ["defer", "beta"])
    it = store.resolve_item(root, "beta")
    assert [t["title"] for t in it["tasks"]] == ["t"]
    assert [n["text"] for n in it["notes"]] == ["n"]


def test_default_list_reads_only_open(root, capsys):
    run(root, ["defer", "beta"])
    capsys.readouterr()
    run(root, ["list"])
    assert "beta" not in capsys.readouterr().out
    run(root, ["list", "--status", "deferred"])
    assert "beta" in capsys.readouterr().out


def test_misfiled_item_is_moved_on_read(root):
    (root / "DEFERRED").mkdir()
    os.rename(root / "OPEN" / "beta", root / "DEFERRED" / "beta")   # hand-moved
    assert store.resolve_item(root, "beta")["folder"] == "OPEN"
    assert folder(root, "beta") == "OPEN"


def test_title_query_prefers_open_items(root):
    store.add_todo(root, "beta two", TS)
    run(root, ["cancel", "beta-two"])
    assert store.resolve_item(root, "bet")["id"] == "beta"


def test_add_never_reuses_an_archived_id(root):
    run(root, ["done", "beta"])
    run(root, ["archive"])
    assert store.add_todo(root, "BETA", TS)["id"] == "beta-2"


def test_list_orders_by_created(root):
    store.add_todo(root, "zeta", "2026-01-01T00:00:00.000Z")
    assert [it["id"] for it in store.list_todos(root)] == ["zeta", "alpha", "beta"]
