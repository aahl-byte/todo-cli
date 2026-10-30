import pytest

from todo import store

from .conftest import run_cli


def test_tag_adds_untag_removes_and_case_only_twins_are_one_tag(root, capsys):
    run_cli(root, ["tag", "beta", "auto-deploy", "Hotfix"])
    run_cli(root, ["tag", "beta", "AUTO-DEPLOY"])
    assert store.resolve_item(root, "beta")["tags"] == ["auto-deploy", "Hotfix"]
    run_cli(root, ["untag", "beta", "hotfix"])
    assert store.resolve_item(root, "beta")["tags"] == ["auto-deploy"]
    assert capsys.readouterr().out.splitlines()[-1] == "beta: tags = auto-deploy"


def test_a_tag_with_a_comma_is_refused(root):
    with pytest.raises(SystemExit):
        run_cli(root, ["tag", "beta", "a,b"])
    assert store.resolve_item(root, "beta")["tags"] == []


def test_each_tag_change_is_history(root):
    run_cli(root, ["tag", "beta", "auto-deploy"])
    run_cli(root, ["tag", "beta", "auto-deploy"])
    run_cli(root, ["untag", "beta", "auto-deploy"])
    history = [(h["field"], h["from"], h["to"]) for h in store.resolve_item(root, "beta")["history"]]
    assert history == [("tags", None, "auto-deploy"), ("tags", "auto-deploy", None)]


def test_list_by_tag_and_status(root, capsys):
    run_cli(root, ["tag", "beta", "auto-deploy", "ui"])
    run_cli(root, ["tag", "alpha", "ui"])
    capsys.readouterr()
    run_cli(root, ["list", "--tag", "auto-deploy", "--tag", "UI"])
    out = capsys.readouterr().out
    assert "beta" in out and "alpha" not in out
    run_cli(root, ["list", "--tag", "ui", "--status", "done"])
    assert "BETA" not in capsys.readouterr().out


def test_get_shows_tags(root, capsys):
    run_cli(root, ["tag", "beta", "auto-deploy"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    assert "tags:      auto-deploy" in capsys.readouterr().out
