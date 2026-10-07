"""Who has seen each note and log entry: `todo updates` and `todo ack`."""

from todo import store

from .conftest import run_cli


def updates(root, capsys, *flags):
    capsys.readouterr()
    run_cli(root, [*flags, "updates", "beta"])
    return capsys.readouterr().out


def test_the_author_has_seen_what_they_wrote(root, capsys):
    run_cli(root, ["--agent", "log", "beta", "did x"])
    run_cli(root, ["--human", "comment", "beta", "review: check y"])
    assert "[n1]" not in updates(root, capsys, "--human")
    out = updates(root, capsys, "--agent")
    assert "[n1] (comment · tester) review: check y" in out
    assert "[l1]" not in out


def test_an_answer_is_unseen_by_the_agent_that_asked(root, capsys):
    run_cli(root, ["--agent", "ask", "beta", "which db?"])
    assert "nothing new" in updates(root, capsys, "--agent")
    run_cli(root, ["--human", "answer", "beta", "1", "postgres"])
    out = updates(root, capsys, "--agent")
    assert "[n1]" in out and "→ (tester) postgres" in out


def test_acknowledging_is_per_party(root, capsys):
    run_cli(root, ["--human", "comment", "beta", "a"])
    run_cli(root, ["--human", "log", "beta", "b"])
    run_cli(root, ["--agent", "ack", "beta", "n1", "l1"])
    assert "nothing new" in updates(root, capsys, "--agent")
    note = store.resolve_item(root, "beta")["notes"][0]
    assert note["meta"]["seen_by"] == ["tester", "tester/agent"]


def test_updates_ack_clears_the_list(root, capsys):
    run_cli(root, ["--human", "comment", "beta", "a"])
    capsys.readouterr()
    run_cli(root, ["--agent", "updates", "beta", "--ack"])
    assert "acknowledged n1" in capsys.readouterr().out
    assert "nothing new" in updates(root, capsys, "--agent")


def test_editing_resets_who_has_seen_it(root, capsys):
    run_cli(root, ["--agent", "note", "beta", "plan"])
    run_cli(root, ["--human", "ack", "beta", "n1"])
    store.edit_note(root, "beta", 1, "plan, revised")
    assert "[n1] (AI) plan, revised" in updates(root, capsys, "--agent")
    assert "nothing new" in updates(root, capsys, "--human")


def test_entries_from_before_tracking_count_as_seen(root, capsys):
    run_cli(root, ["--human", "comment", "beta", "old"])
    f = next((root / "OPEN" / "beta" / "notes").iterdir())
    f.write_text(f.read_text().replace("seen_by:\n- tester\n", ""))
    assert "nothing new" in updates(root, capsys, "--agent")
