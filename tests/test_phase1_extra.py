"""Phase 1 edge cases the spec validation called out."""

import pytest

from todo import identity, link, store

from .conftest import TS, make_store, run_cli


def test_list_g_honours_mine(tmp_path, monkeypatch, capsys):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(link.Path, "home", classmethod(lambda cls: home))
    repo = tmp_path / "repo"
    root = make_store(repo)
    link.link(repo, None)
    run_cli(root, ["assign", "alpha", "--dev", "someone"])
    run_cli(root, ["review", "beta"])
    run_cli(root, ["assign", "beta", "--qa", "tester"])
    capsys.readouterr()
    run_cli(root, ["list", "-g", "--mine"])
    out = capsys.readouterr().out
    assert "beta" in out and "alpha" not in out


def test_deploy_plan_keeps_archived_items_with_open_post_checks(root, capsys):
    run_cli(root, ["check", "add", "beta", "manual-step", "smoke", "--post"])
    run_cli(root, ["deploy", "beta"])
    run_cli(root, ["archive"])
    capsys.readouterr()
    run_cli(root, ["deploy-plan"])
    assert "smoke" in capsys.readouterr().out


def test_deploy_plan_orders_items_by_created(root, capsys):
    f = root / "OPEN" / "alpha" / "TODO.yaml"
    f.write_text(f.read_text().replace("2026-06-24T10:00:00.000Z", "2026-06-24T12:00:00.000Z"))
    for q in ("alpha", "beta"):
        run_cli(root, ["approve", q])
        run_cli(root, ["check", "add", q, "db-script", f"SQL_{q}"])
    capsys.readouterr()
    run_cli(root, ["deploy-plan"])
    out = capsys.readouterr().out
    assert out.index("SQL_beta") < out.index("SQL_alpha")


def test_repeat_deploy_does_not_claim_force(root, capsys):
    run_cli(root, ["deploy", "beta"])
    run_cli(root, ["check", "add", "beta", "db-script", "late"])
    capsys.readouterr()
    run_cli(root, ["deploy", "beta", "--force"])
    assert "forced" not in capsys.readouterr().out
    assert len(store.resolve_item(root, "beta")["history"]) == 1


def test_reject_only_from_qa_statuses(root):
    with pytest.raises(SystemExit):
        run_cli(root, ["reject", "beta", "nope"])
    run_cli(root, ["approve", "beta"])
    run_cli(root, ["reject", "beta", "found", "a", "bug"])
    assert store.resolve_item(root, "beta")["status"] == "in-progress"


def test_task_counter_counts_deployed_as_complete(root, capsys):
    run_cli(root, ["task", "add", "beta", "a"])
    run_cli(root, ["task", "add", "beta", "b"])
    run_cli(root, ["task", "done", "beta", "1"])
    run_cli(root, ["task", "status", "beta", "2", "deployed"])
    capsys.readouterr()
    run_cli(root, ["list"])
    assert "(2/2 tasks)" in capsys.readouterr().out


def test_archived_item_stays_archived_across_complete_statuses(root):
    run_cli(root, ["deploy", "beta"])
    run_cli(root, ["archive"])
    run_cli(root, ["done", "beta"])
    assert (root / "ARCHIVED" / "beta").is_dir()


def test_get_shows_people_and_note_tags(root, capsys):
    run_cli(root, ["assign", "beta", "--dev", "bob"])
    run_cli(root, ["comment", "beta", "hello"])
    run_cli(root, ["--agent", "note", "beta", "from an agent"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    out = capsys.readouterr().out
    assert "creator:   —" in out
    assert "developer: bob" in out
    assert "qa:        —" in out
    assert "(comment · tester) hello" in out
    assert "(AI) from an agent" in out


def test_identity_precedence(tmp_path, monkeypatch):
    monkeypatch.setattr(identity.Path, "home", classmethod(lambda cls: tmp_path))
    monkeypatch.delenv("TODO_USER")
    identity.save_config({"user": "configured"})
    assert identity.user() == "configured"
    monkeypatch.setenv("TODO_USER", "env")
    assert identity.user() == "env"
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("TODO_VIA", "human")
    assert identity.via() == "human"
    monkeypatch.delenv("TODO_VIA")
    assert identity.via() == "agent"
    identity.set_via("human")
    assert identity.via() == "human"
