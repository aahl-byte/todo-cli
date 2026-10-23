"""An item lists several branches: `todo branch add|rm`, `todo set … branch`,
legacy single-`branch` items, and the list's trip through sync."""

import pytest

from todo import remote, store, yamlio

from .conftest import run_cli
from .fake_server import FakeServer
from .test_sync import make, rnd


def meta(root, q="beta"):
    it = store.resolve_item(root, q)
    return yamlio.read(root / it["folder"] / it["id"] / store.ITEM_FILE)


def write_legacy_branch(root, value, q="beta"):
    it = store.resolve_item(root, q)
    f = root / it["folder"] / it["id"] / store.ITEM_FILE
    f.write_text(f.read_text() + f"branch: {value}\n")


def test_legacy_branch_reads_as_a_one_branch_list(root):
    write_legacy_branch(root, "feat/old")
    assert store.resolve_item(root, "beta")["branches"] == ["feat/old"]


def test_first_write_rewrites_legacy_branch_as_branches(root):
    write_legacy_branch(root, "feat/old")
    run_cli(root, ["set", "beta", "app", "web"])
    m = meta(root)
    assert m["branches"] == ["feat/old"] and "branch" not in m


def test_no_branches_leaves_the_key_out(root):
    assert store.resolve_item(root, "beta")["branches"] == []
    run_cli(root, ["set", "beta", "app", "web"])
    assert "branches" not in meta(root)


def test_branch_add_appends_and_ignores_duplicates(root, capsys):
    run_cli(root, ["branch", "add", "beta", "feat/x"])
    run_cli(root, ["branch", "add", "beta", "feat/y"])
    run_cli(root, ["branch", "add", "beta", "feat/x"])
    assert store.resolve_item(root, "beta")["branches"] == ["feat/x", "feat/y"]
    assert capsys.readouterr().out.splitlines()[-1] == "beta: branches = feat/x, feat/y"


def test_branch_rm_removes_one_and_ignores_a_missing_one(root, capsys):
    run_cli(root, ["branch", "add", "beta", "feat/x"])
    run_cli(root, ["branch", "add", "beta", "feat/y"])
    run_cli(root, ["branch", "rm", "beta", "feat/x"])
    run_cli(root, ["branch", "rm", "beta", "feat/x"])
    assert store.resolve_item(root, "beta")["branches"] == ["feat/y"]
    run_cli(root, ["branch", "rm", "beta", "feat/y"])
    assert capsys.readouterr().out.splitlines()[-1] == "beta: branches = —"
    assert "branches" not in meta(root)


def test_set_branch_replaces_the_list_and_none_clears_it(root, capsys):
    run_cli(root, ["branch", "add", "beta", "feat/x"])
    run_cli(root, ["branch", "add", "beta", "feat/y"])
    run_cli(root, ["set", "beta", "branch", "feat/z"])
    assert store.resolve_item(root, "beta")["branches"] == ["feat/z"]
    assert capsys.readouterr().out.splitlines()[-1] == "beta: branches = feat/z"
    run_cli(root, ["set", "beta", "branch", "none"])
    assert store.resolve_item(root, "beta")["branches"] == []


def test_get_lists_every_branch(root, capsys):
    run_cli(root, ["set", "beta", "repo", "o/r"])
    run_cli(root, ["branch", "add", "beta", "feat/x"])
    run_cli(root, ["branch", "add", "beta", "feat/y"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    assert "branches:  o/r · feat/x, feat/y" in capsys.readouterr().out


def test_get_shows_dashes_for_no_repo_or_branches(root, capsys):
    run_cli(root, ["get", "beta"])
    assert "branches:  — · —" in capsys.readouterr().out


def test_empty_branches_counts_as_an_empty_field(root, capsys):
    remote.save_sync_config(root, {"url": "http://fake", "project": "p", "deploy_step": True})
    for field, value in [("app", "web"), ("section", "billing"), ("repo", "o/r")]:
        run_cli(root, ["set", "beta", field, value])
    capsys.readouterr()
    run_cli(root, ["start", "beta"])
    assert "has no branch." in capsys.readouterr().err


@pytest.fixture
def server():
    return FakeServer()


def test_branches_sync_as_extra_branches(tmp_path, server, monkeypatch):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    run_cli(a, ["branch", "add", "login-bug", "feat/x"])
    run_cli(a, ["branch", "add", "login-bug", "feat/y"])
    assert rnd(a, server, "alice").error is None
    row = next(r for r in server.rows.values() if r["_entity"] == "item")
    assert row["extra"]["branches"] == ["feat/x", "feat/y"]
    assert rnd(b, server, "bob", adopt=True).error is None
    assert store.resolve_item(b, "login-bug")["branches"] == ["feat/x", "feat/y"]

    monkeypatch.setenv("TODO_USER", "bob")
    run_cli(b, ["branch", "rm", "login-bug", "feat/x"])
    assert rnd(b, server, "bob").error is None
    assert rnd(a, server, "alice").error is None
    assert store.resolve_item(a, "login-bug")["branches"] == ["feat/y"]


def test_a_rewritten_legacy_branch_drops_extra_branch(tmp_path, server, monkeypatch):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    write_legacy_branch(a, "feat/old", "login-bug")
    assert rnd(a, server, "alice").error is None
    assert rnd(b, server, "bob", adopt=True).error is None
    assert store.resolve_item(b, "login-bug")["branches"] == ["feat/old"]

    run_cli(a, ["branch", "add", "login-bug", "feat/new"])
    assert rnd(a, server, "alice").error is None
    row = next(r for r in server.rows.values() if r["_entity"] == "item")
    assert row["extra"].get("branch") is None
    assert row["extra"]["branches"] == ["feat/old", "feat/new"]
    assert rnd(b, server, "bob").error is None
    assert store.resolve_item(b, "login-bug")["branches"] == ["feat/old", "feat/new"]
    assert "branch" not in meta(b, "login-bug")
