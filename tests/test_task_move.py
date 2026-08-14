"""Ordering within a phase: `task move`, plus the drop-to-bottom re-phase."""

from pathlib import Path

import pytest

from todo import store
from todo.cli import build_parser


def run(file, argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def titles(file, query="beta"):
    return [t["title"] for t in store.resolve_item(file, query)["tasks"]]


@pytest.fixture
def three(todo_file):
    for title in ("a", "b", "c"):
        run(todo_file, ["task", "add", "beta", title, "--phase", "1"])
    return todo_file


def test_move_after(three):
    run(three, ["task", "move", "beta", "1", "--after", "3"])
    assert titles(three) == ["b", "c", "a"]


def test_move_before(three):
    run(three, ["task", "move", "beta", "3", "--before", "1"])
    assert titles(three) == ["c", "a", "b"]


def test_move_top_and_bottom(three):
    run(three, ["task", "move", "beta", "2", "--top"])
    assert titles(three) == ["b", "a", "c"]
    run(three, ["task", "move", "beta", "2", "--bottom"])
    assert titles(three) == ["a", "c", "b"]


def test_move_defaults_to_top(three):
    run(three, ["task", "move", "beta", "3"])
    assert titles(three) == ["c", "a", "b"]


def test_move_only_reorders_within_its_phase(three):
    run(three, ["task", "add", "beta", "z", "--phase", "2"])   # id 4
    run(three, ["task", "move", "beta", "1", "--bottom"])
    assert titles(three) == ["b", "c", "a", "z"]


def test_move_relative_to_another_phase_adopts_it(three):
    run(three, ["task", "add", "beta", "z", "--phase", "2"])   # id 4
    run(three, ["task", "move", "beta", "1", "--after", "4"])
    assert titles(three) == ["b", "c", "z", "a"]
    moved = next(t for t in store.resolve_item(three, "beta")["tasks"] if t["id"] == 1)
    assert moved["phase"] == 2


def test_move_top_of_unphased_group(three):
    run(three, ["task", "add", "beta", "y"])                   # id 4, unphased
    run(three, ["task", "add", "beta", "z"])                   # id 5, unphased
    run(three, ["task", "move", "beta", "5", "--top"])
    assert titles(three) == ["a", "b", "c", "z", "y"]


def test_rephase_drops_to_bottom_of_target_phase(three):
    run(three, ["task", "add", "beta", "z", "--phase", "2"])   # id 4
    run(three, ["task", "phase", "beta", "1", "2"])
    assert titles(three) == ["b", "c", "z", "a"]


def test_move_rejects_unknown_and_self_targets(three):
    with pytest.raises(SystemExit):
        run(three, ["task", "move", "beta", "1", "--after", "99"])
    with pytest.raises(SystemExit):
        run(three, ["task", "move", "beta", "1", "--after", "1"])
