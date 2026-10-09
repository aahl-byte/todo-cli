"""Follow-up questions and replies sit in the thread of the question they follow."""

from pathlib import Path

import pytest

from todo import render, store
from todo.cli import build_parser


def run(file, argv):
    args = build_parser().parse_args(argv)
    args.func(Path(file), args)


def test_follow_ups_join_the_first_questions_thread(root, capsys):
    run(root, ["ask", "beta", "which", "db?"])
    run(root, ["answer", "beta", "1", "postgres"])
    run(root, ["ask", "beta", "which", "version?", "--re", "1"])
    run(root, ["comment", "beta", "use", "16", "--re", "2"])
    notes = store.resolve_item(root, "beta")["notes"]
    first = notes[0]["uid"]
    assert [(n["kind"], (n.get("meta") or {}).get("thread")) for n in notes] == \
        [("clarification", None), ("clarification", first), ("comment", first)]
    assert render.note_lines(notes[1:], every=notes)[0].endswith("re [1]: which version?")


def test_follow_ups_go_under_questions_only(root):
    run(root, ["comment", "beta", "hello"])
    with pytest.raises(SystemExit):
        run(root, ["ask", "beta", "huh?", "--re", "1"])
