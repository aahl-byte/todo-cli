import pytest

from todo import store

from .conftest import run_cli
from .fake_server import FakeServer
from .test_sync import make, rnd


@pytest.fixture
def server():
    return FakeServer()


def test_set_shows_and_clears_a_class(root, capsys):
    run_cli(root, ["set", "beta", "class", "PATCH"])
    run_cli(root, ["get", "beta"])
    assert "class:     PATCH" in capsys.readouterr().out
    run_cli(root, ["set", "beta", "class", "none"])
    assert store.resolve_item(root, "beta")["class"] is None


def test_each_class_change_lands_in_history(root, capsys):
    run_cli(root, ["set", "beta", "class", "PATCH"])
    run_cli(root, ["set", "beta", "class", "PATCH"])
    run_cli(root, ["set", "beta", "class", "ARCHITECT"])
    hist = store.resolve_item(root, "beta")["history"]
    assert [(h["field"], h["from"], h["to"]) for h in hist] == [("class", None, "PATCH"), ("class", "PATCH", "ARCHITECT")]
    capsys.readouterr()
    run_cli(root, ["history", "beta"])
    assert "class PATCH → ARCHITECT" in capsys.readouterr().out


def test_list_filters_by_class(root, capsys):
    run_cli(root, ["set", "beta", "class", "PATCH"])
    capsys.readouterr()
    run_cli(root, ["list", "--all", "--class", "PATCH"])
    out = capsys.readouterr().out
    assert "beta" in out and "alpha" not in out


def test_a_class_and_its_history_reach_a_teammate(tmp_path, server, monkeypatch):
    a, b = make(tmp_path, "a", server), make(tmp_path, "b", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    assert rnd(a, server, "alice").error is None
    assert rnd(b, server, "bob", adopt=True).error is None
    run_cli(a, ["set", "login-bug", "class", "PATCH"])
    assert rnd(a, server, "alice").error is None
    run_cli(a, ["set", "login-bug", "class", "ARCHITECT"])
    assert rnd(a, server, "alice").error is None
    assert rnd(b, server, "bob").error is None
    for root in (a, b):
        it = store.resolve_item(root, "login-bug")
        assert it["class"] == "ARCHITECT"
        assert [(h["field"], h["from"], h["to"], h["provisional"]) for h in it["history"]] == \
            [("class", None, "PATCH", False), ("class", "PATCH", "ARCHITECT", False)]


def test_class_history_from_before_linking_reaches_the_server(tmp_path, server, monkeypatch):
    a = make(tmp_path, "a", server)
    monkeypatch.setenv("TODO_USER", "alice")
    run_cli(a, ["add", "Login bug"])
    run_cli(a, ["set", "login-bug", "class", "PATCH"])
    assert rnd(a, server, "alice").error is None
    rows = [r for r in server.rows.values() if r["_entity"] == "history"]
    assert [(r["field"], r["to_status"]) for r in rows] == [("class", "PATCH")]
