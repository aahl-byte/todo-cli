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


def test_metadata_goes_last_and_round_trips():
    meta = {"uid": "U", "kind": "comment", "mentions": ["a"], "answer": "multi\n-->\nline"}
    text = frontmatter.join(meta, "top\n---\nbottom\n")
    assert text.startswith("top\n")
    assert text.rstrip().endswith("-->")
    assert frontmatter.split(text) == (meta, "top\n---\nbottom\n")


def test_older_front_matter_still_reads_and_converts(root):
    from todo import migrate
    d = root / "OPEN" / "beta" / "notes"
    d.mkdir()
    f = d / "2026-06-25T09-30-00.000Z-1.md"
    f.write_text("---\nuid: U1\nkind: context\nauthor: x\n---\nthe point\n")
    assert notes(root)[0]["text"] == "the point"
    (root / migrate.FORMAT_FILE).unlink(missing_ok=True)
    assert migrate.convert_note_meta(root) == 1
    assert f.read_text().startswith("the point\n")
    n = notes(root)[0]
    assert (n["uid"], n["text"]) == ("U1", "the point")
    assert migrate.convert_note_meta(root) == 0


def test_a_note_that_merely_contains_a_comment_stays_a_body(root):
    d = root / "OPEN" / "beta" / "notes"
    d.mkdir()
    (d / "2026-06-25T09-30-00.000Z-1.md").write_text("text\n<!--todo\nnot: meta\n-->\n")
    assert notes(root)[0]["text"] == "text\n<!--todo\nnot: meta\n-->"


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


def test_request_posts_a_version_and_sends_an_unsynced_item_back(root, capsys):
    run_cli(root, ["add", "Safari login", "--request", "v1 text"])
    run_cli(root, ["status", "safari-login", "in-progress"])
    run_cli(root, ["request", "safari-login", "v2 text"])
    it = store.resolve_item(root, "safari-login")
    assert it["status"] == "requested"
    assert [n["text"] for n in it["notes"] if n["kind"] == "ticket-request"] == ["v1 text", "v2 text"]


def test_get_shows_only_the_current_request_and_flags_untriaged(root, capsys):
    run_cli(root, ["add", "Safari login", "--request", "old words"])
    item_dir = root / "OPEN" / "safari-login" / "notes"
    f = next(item_dir.iterdir())
    meta, body = frontmatter.split(f.read_text())
    f.write_text(frontmatter.join({**meta, "version": 1, "frozen": True, "triaged": True}, body))
    run_cli(root, ["request", "safari-login", "new words"])
    f2 = next(p for p in item_dir.iterdir() if p != f)
    meta, body = frontmatter.split(f2.read_text())
    f2.write_text(frontmatter.join({**meta, "version": 2, "frozen": True, "frozen_via": "skip"}, body))
    run_cli(root, ["status", "safari-login", "in-progress"])
    capsys.readouterr()
    run_cli(root, ["get", "safari-login"])
    out = capsys.readouterr().out
    assert "new words" in out and "old words" not in out
    assert "v2" in out and "(untriaged)" in out


def test_app_section_and_request_url(root, capsys):
    run_cli(root, ["add", "Cart bug", "--request", "totals wrong", "--url", "https://shop.test/cart",
                   "--app", "web", "--section", "checkout"])
    it = store.resolve_item(root, "cart-bug")
    assert (it["app"], it["section"]) == ("web", "checkout")
    assert it["notes"][0]["meta"]["url"] == "https://shop.test/cart"
    run_cli(root, ["set", "cart-bug", "section", "none"])
    assert store.resolve_item(root, "cart-bug")["section"] is None
    capsys.readouterr()
    run_cli(root, ["get", "cart-bug"])
    out = capsys.readouterr().out
    assert "app:       web" in out and "https://shop.test/cart" in out
    with pytest.raises(SystemExit):
        run_cli(root, ["add", "x", "--request", "y", "--url", "ftp://nope"])


def test_new_link_types(root):
    run_cli(root, ["url", "beta", "https://design.test/f/1", "--type", "design"])
    assert notes(root)[0]["meta"]["type"] == "design"


def test_phase_titles_round_trip_and_render(root, capsys):
    run_cli(root, ["task", "add", "beta", "migrate", "--phase", "1"])
    run_cli(root, ["phase", "beta", "1", "Schema"])
    run_cli(root, ["phase", "beta", "3", "Rollout"])
    assert store.resolve_item(root, "beta")["phases"] == {"1": "Schema", "3": "Rollout"}
    capsys.readouterr()
    run_cli(root, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "phase 1 · Schema" in out and "phase 3 · Rollout  (no tasks)" in out
    run_cli(root, ["task", "add", "beta", "another", "--phase", "1"])
    run_cli(root, ["phase", "beta", "3"])
    assert store.resolve_item(root, "beta")["phases"] == {"1": "Schema"}


def test_relate_shows_on_both_sides_and_unrelates_from_either(root, capsys):
    run_cli(root, ["add", "Cart totals"])
    run_cli(root, ["add", "Tax rounding"])
    run_cli(root, ["relate", "cart-totals", "tax-rounding"])
    run_cli(root, ["relate", "tax-rounding", "cart-totals"])          # already related: no second note
    capsys.readouterr()
    run_cli(root, ["get", "tax-rounding"])
    out = capsys.readouterr().out
    assert "related:" in out and "cart-totals" in out.split("related:")[1]
    assert [n["kind"] for n in notes(root, "cart-totals")] == ["relation"]
    run_cli(root, ["unrelate", "tax-rounding", "cart-totals"])
    assert notes(root, "cart-totals") == []
