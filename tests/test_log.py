"""The dev log: a dated, id-addressed sequence parallel to notes."""

from pathlib import Path

import pytest

from todo import frontmatter, store
from todo.cli import build_parser


def run(file, argv):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_add_and_read(root, capsys):
    run(root, ["log", "beta", "swapped", "the", "regex"])
    assert "added log [1]" in capsys.readouterr().out
    entry = store.resolve_item(root, "beta")["log"][0]
    assert entry["id"] == 1
    assert entry["text"] == "swapped the regex"
    assert entry["ts"].endswith("Z")


def test_log_and_notes_have_separate_id_spaces(root):
    run(root, ["log", "beta", "one"])
    run(root, ["note", "beta", "a note"])
    it = store.resolve_item(root, "beta")
    assert [e["id"] for e in it["log"]] == [1]
    assert [n["id"] for n in it["notes"]] == [1]
    assert it["notes"][0]["text"] == "a note"


def test_ids_survive_removal(root, capsys):
    for text in ("one", "two", "three"):
        run(root, ["log", "beta", text])
    run(root, ["unlog", "beta", "2"])
    it = store.resolve_item(root, "beta")
    assert [(e["id"], e["text"]) for e in it["log"]] == [(1, "one"), (3, "three")]


def test_unlog_unknown_id_exits(root):
    run(root, ["log", "beta", "one"])
    with pytest.raises(SystemExit):
        run(root, ["unlog", "beta", "9"])


def test_logs_limit(root, capsys):
    for text in ("one", "two", "three"):
        run(root, ["log", "beta", text])
    capsys.readouterr()
    run(root, ["logs", "beta", "-n", "2"])
    out = capsys.readouterr().out
    assert "one" not in out
    assert "two" in out and "three" in out


def test_get_previews_the_tail(root, capsys):
    for i in range(5):
        run(root, ["log", "beta", f"entry{i}"])
    capsys.readouterr()
    run(root, ["get", "beta"])
    out = capsys.readouterr().out
    assert "… 2 earlier" in out
    assert "entry0" not in out
    assert "entry4" in out

    run(root, ["get", "beta", "--log"])
    out = capsys.readouterr().out
    assert "entry0" in out
    assert "earlier" not in out


def test_multiline_entry_round_trips(root):
    text = "**tried**\n\n- `a`\n- `b`"
    run(root, ["log", "beta", text])
    f, = (root / "OPEN" / "beta" / "devlogs").iterdir()
    assert frontmatter.split(f.read_text())[1] == text + "\n"
    assert store.resolve_item(root, "beta")["log"][0]["text"] == text
