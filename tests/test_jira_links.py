"""`todo jira link/unlink`: the item's `jira:` list, shown by `todo get` and
synced as an ordinary item field."""

import pytest

from todo import store

from .conftest import run_cli
from .test_sync import item, make, pair, rnd, server  # noqa: F401 — fixtures


def test_link_keeps_order_and_skips_duplicates(root, capsys):
    run_cli(root, ["jira", "link", "alpha", "cns-123", "CNS-456"])
    run_cli(root, ["jira", "link", "alpha", "CNS-456", "WEB-7"])
    assert store.resolve_item(root, "alpha")["jira"] == ["CNS-123", "CNS-456", "WEB-7"]
    assert "jira:\n  - CNS-123\n" in (root / "OPEN" / "alpha" / "TODO.yaml").read_text()


def test_unlink_drops_the_key_and_the_field_once_empty(root):
    run_cli(root, ["jira", "link", "alpha", "CNS-1", "CNS-2"])
    run_cli(root, ["jira", "unlink", "alpha", "CNS-1"])
    assert store.resolve_item(root, "alpha")["jira"] == ["CNS-2"]
    run_cli(root, ["jira", "unlink", "alpha", "cns-2"])
    assert store.resolve_item(root, "alpha")["jira"] == []
    assert "jira" not in (root / "OPEN" / "alpha" / "TODO.yaml").read_text()


def test_bad_keys_and_unknown_unlinks_are_refused(root):
    with pytest.raises(SystemExit) as e:
        run_cli(root, ["jira", "link", "alpha", "not a key"])
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        run_cli(root, ["jira", "unlink", "alpha", "CNS-9"])
    assert e.value.code == 1


def test_get_shows_keys_with_their_jira_status(root, capsys):
    run_cli(root, ["jira", "link", "alpha", "CNS-1", "CNS-2"])
    f = root / "OPEN" / "alpha" / "TODO.yaml"
    f.write_text(f.read_text() + "jira_status:\n  CNS-1: In Progress\n")
    capsys.readouterr()
    run_cli(root, ["get", "alpha"])
    assert "jira:      CNS-1 (In Progress), CNS-2" in capsys.readouterr().out


def test_links_sync_both_ways(pair, server):
    a, b = pair
    run_cli(a, ["jira", "link", "login-bug", "CNS-123", "WEB-4"])
    rnd(a, server, "alice")
    row = server.rows[item(a)["uid"]]
    assert row["extra"]["jira"] == ["CNS-123", "WEB-4"]
    rnd(b, server, "bob")
    assert item(b)["jira"] == ["CNS-123", "WEB-4"]

    run_cli(b, ["jira", "unlink", "login-bug", "CNS-123"])
    rnd(b, server, "bob")
    assert server.rows[item(a)["uid"]]["extra"]["jira"] == ["WEB-4"]
    rnd(a, server, "alice")
    assert item(a)["jira"] == ["WEB-4"]

    run_cli(a, ["jira", "unlink", "login-bug", "WEB-4"])
    rnd(a, server, "alice")
    assert "jira" not in server.rows[item(a)["uid"]]["extra"]
    rnd(b, server, "bob")
    assert item(b)["jira"] == []


def test_a_status_the_bridge_records_reaches_get(pair, server, capsys):
    a, _ = pair
    run_cli(a, ["jira", "link", "login-bug", "CNS-123"])
    rnd(a, server, "alice")
    uid = item(a)["uid"]
    server.apply([{"op_id": "s1", "op": "set", "entity": "item", "uid": uid, "item_uid": uid,
                   "data": {"extra.jira_status": {"CNS-123": "In Review"}}}], "jira-bridge")
    rnd(a, server, "alice")
    capsys.readouterr()
    run_cli(a, ["get", "login-bug"])
    assert "jira:      CNS-123 (In Review)" in capsys.readouterr().out
