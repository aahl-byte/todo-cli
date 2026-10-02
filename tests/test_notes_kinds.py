"""Note kinds, front matter, authorship, people fields and requests."""

import pytest

from todo import frontmatter, store

from .conftest import TS, run_cli


def notes(root, q="beta"):
    return store.resolve_item(root, q)["notes"]


def test_new_notes_carry_uid_author_via(root, monkeypatch):
    monkeypatch.setenv("TODO_VIA", "agent")
    run_cli(root, ["note", "beta", "why"])
    n = notes(root)[0]
    assert (n["kind"], n["author"], n["via"], n["text"]) == ("context", "tester", "agent", "why")
    assert len(n["uid"]) == 26


def test_log_entries_carry_authorship(root):
    run_cli(root, ["log", "beta", "tried x"])
    e = store.resolve_item(root, "beta")["log"][0]
    assert (e["author"], e["via"], e["text"]) == ("tester", "human", "tried x")


def test_front_matter_round_trips_and_body_keeps_rules():
    text = frontmatter.join({"uid": "U", "kind": "comment", "mentions": ["a"]},
                            "top\n---\nbottom\n")
    assert frontmatter.split(text) == ({"uid": "U", "kind": "comment", "mentions": ["a"]},
                                       "top\n---\nbottom\n")


def test_legacy_body_opening_with_a_rule_stays_a_body(root):
    d = root / "OPEN" / "beta" / "notes"
    d.mkdir()
    (d / "2026-06-25T09-30-00.000Z-1.md").write_text("---\ntitle: x\n---\nbody\n")
    n = notes(root)[0]
    assert n["kind"] == "context"
    assert n["text"] == "---\ntitle: x\n---\nbody"


def test_comment_records_mentions(root):
    run_cli(root, ["comment", "beta", "@carol", "can", "you", "check?", "cc", "@bob.", "@carol"])
    n = notes(root)[0]
    assert n["kind"] == "comment"
    assert n["meta"]["mentions"] == ["carol", "bob"]


def test_email_is_not_a_mention():
    assert store.mentions("mail a@b.com and @dev") == ["dev"]


def test_url_attaches_a_typed_link(root):
    run_cli(root, ["url", "beta", "https://x/pr/1", "--type", "pr", "--label", "PR 1"])
    n = notes(root)[0]
    assert n["kind"] == "link"
    assert n["meta"] == {"url": "https://x/pr/1", "label": "PR 1", "type": "pr"}


def test_ask_then_answer_closes_the_clarification(root, capsys):
    run_cli(root, ["ask", "beta", "which", "browsers?"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    assert "open questions:" in capsys.readouterr().out
    run_cli(root, ["answer", "beta", "1", "Safari", "16+"])
    n = notes(root)[0]
    assert n["meta"]["state"] == "answered"
    assert n["meta"]["answer"] == "Safari 16+"
    assert n["meta"]["answered_by"] == "tester"
    assert n["text"] == "which browsers?"
    run_cli(root, ["get", "beta"])
    assert "open questions:" not in capsys.readouterr().out


def test_answer_refuses_non_clarifications(root):
    run_cli(root, ["note", "beta", "context"])
    with pytest.raises(SystemExit):
        run_cli(root, ["answer", "beta", "1", "x"])


def test_notes_filter_by_kind(root, capsys):
    run_cli(root, ["note", "beta", "ctx"])
    run_cli(root, ["comment", "beta", "hi"])
    capsys.readouterr()
    run_cli(root, ["notes", "beta", "--kind", "comment"])
    out = capsys.readouterr().out
    assert "hi" in out and "ctx" not in out


def test_add_with_request_files_a_requested_item(root):
    run_cli(root, ["add", "Safari login", "--request", "PM: users can't log in"])
    it = store.resolve_item(root, "safari-login")
    assert it["status"] == "requested"
    assert it["creator"] == "tester"
    assert it["uid"]
    assert [(n["kind"], n["text"]) for n in it["notes"]] == [
        ("ticket-request", "PM: users can't log in")]


def test_assign_sets_and_clears_people(root):
    run_cli(root, ["assign", "beta", "--dev", "bob", "--qa", "carol"])
    it = store.resolve_item(root, "beta")
    assert (it["developer"], it["qa_assignee"]) == ("bob", "carol")
    run_cli(root, ["assign", "beta", "--qa", "none"])
    it = store.resolve_item(root, "beta")
    assert (it["developer"], it["qa_assignee"]) == ("bob", None)


def test_list_mine(root, capsys, monkeypatch):
    run_cli(root, ["assign", "beta", "--dev", "tester"])
    run_cli(root, ["assign", "alpha", "--qa", "someone"])
    capsys.readouterr()
    run_cli(root, ["list", "--mine"])
    out = capsys.readouterr().out
    assert "beta" in out and "alpha" not in out


def test_item_file_keeps_unknown_keys_and_comments(root):
    f = root / "OPEN" / "beta" / "TODO.yaml"
    f.write_text("# keep me\n" + f.read_text() + "acceptance: it works\n")
    store.update_todo(root, "beta", {"developer": "bob"}, TS)
    text = f.read_text()
    assert text.startswith("# keep me\n")
    assert "acceptance: it works" in text
    assert "developer: bob" in text
