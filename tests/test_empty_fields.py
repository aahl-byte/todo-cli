"""Starting work fills in the developer, and a team item that starts or goes to
review without its app, section, repo or branch says so."""

from todo import remote, store

from .conftest import run_cli


def team(root):
    remote.save_sync_config(root, {"url": "http://fake", "project": "p", "deploy_step": True})
    return root


def test_start_makes_me_the_developer_when_there_is_none(root):
    run_cli(root, ["start", "beta"])
    assert store.resolve_item(root, "beta")["developer"] == "tester"


def test_start_keeps_an_assigned_developer(root):
    run_cli(root, ["assign", "beta", "--dev", "bob"])
    run_cli(root, ["start", "beta"])
    assert store.resolve_item(root, "beta")["developer"] == "bob"


def test_other_statuses_leave_the_developer_alone(root):
    run_cli(root, ["triage", "beta"])
    assert store.resolve_item(root, "beta")["developer"] is None


def test_team_start_warns_about_each_empty_field(root, capsys):
    run_cli(team(root), ["start", "beta"])
    err = capsys.readouterr().err
    assert "app, section, repo, branch" in err
    assert "todo set beta" in err


def test_team_review_names_only_the_fields_still_empty(root, capsys):
    team(root)
    for field, value in [("app", "web"), ("section", "billing"), ("repo", "o/r")]:
        run_cli(root, ["set", "beta", field, value])
    capsys.readouterr()
    run_cli(root, ["review", "beta"])
    err = capsys.readouterr().err
    assert "branch" in err and "app" not in err


def test_team_item_with_every_field_set_starts_quietly(root, capsys):
    team(root)
    for field, value in [("app", "web"), ("section", "billing"), ("repo", "o/r"), ("branch", "b")]:
        run_cli(root, ["set", "beta", field, value])
    capsys.readouterr()
    run_cli(root, ["start", "beta"])
    assert capsys.readouterr().err == ""


def test_local_store_never_warns(root, capsys):
    run_cli(root, ["start", "beta"])
    assert capsys.readouterr().err == ""
