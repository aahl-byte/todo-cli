"""Deployment checks carry one tick per environment (dev, staging, production);
a check is done once production is ticked."""

from todo import remote, store, sync

from .conftest import run_cli
from .fake_server import FakeServer


def check(root, q="beta"):
    return store.resolve_item(root, q)["checks"][0]


def add(root):
    run_cli(root, ["check", "add", "beta", "db-script", "migrate", "--payload", "db/1.sql"])


def test_a_new_check_has_no_environment_ticked(root):
    add(root)
    assert check(root)["envs"] == [] and check(root)["status"] == "pending"


def test_ticking_staging_leaves_it_pending_and_production_makes_it_done(root):
    add(root)
    run_cli(root, ["check", "done", "beta", "1", "S", "dev"])
    assert check(root)["envs"] == ["dev", "staging"] and check(root)["status"] == "pending"
    run_cli(root, ["check", "done", "beta", "1", "P"])
    assert check(root)["envs"] == ["dev", "staging", "production"] and check(root)["status"] == "done"


def test_reopen_production_sends_it_back_to_pending(root):
    add(root)
    run_cli(root, ["check", "done", "beta", "1"])
    run_cli(root, ["check", "reopen", "beta", "1", "production"])
    assert check(root)["envs"] == ["dev", "staging"] and check(root)["status"] == "pending"


def test_done_and_reopen_with_no_environment_mean_all_of_them(root):
    add(root)
    run_cli(root, ["check", "done", "beta", "1"])
    assert check(root)["envs"] == ["dev", "staging", "production"]
    run_cli(root, ["check", "reopen", "beta", "1"])
    assert check(root)["envs"] == [] and check(root)["status"] == "pending"


def test_a_check_done_before_environments_counts_as_ticked_everywhere(root):
    add(root)
    store.set_check_status(root, "beta", 1, "done")
    assert store.ticked(check(root)) == ["dev", "staging", "production"]
    run_cli(root, ["check", "reopen", "beta", "1", "P"])
    assert check(root)["envs"] == ["dev", "staging"]


def test_checks_list_shows_each_environment(root, capsys):
    add(root)
    run_cli(root, ["check", "done", "beta", "1", "D"])
    capsys.readouterr()
    run_cli(root, ["checks", "beta"])
    assert "[D · ·] [1]" in capsys.readouterr().out


def test_environments_round_trip_through_the_server(tmp_path, monkeypatch):
    server = FakeServer()
    roots = []
    for name in ("a", "b"):
        r = tmp_path / name / ".TODO"
        r.mkdir(parents=True)
        remote.save_sync_config(r, {"url": "http://fake", "project": "p", "deploy_step": True})
        roots.append(r)
    a, b = roots
    run_cli(a, ["add", "Ship it"])
    run_cli(a, ["check", "add", "ship-it", "db-script", "migrate"])
    run_cli(a, ["check", "done", "ship-it", "1", "S"])
    sync.run_round(a, server.client("alice"))
    sync.run_round(b, server.client("bob"))
    assert check(b, "ship-it")["envs"] == ["staging"]
    run_cli(b, ["check", "done", "ship-it", "1", "P"])
    sync.run_round(b, server.client("bob"))
    sync.run_round(a, server.client("alice"))
    assert check(a, "ship-it")["envs"] == ["staging", "production"] and check(a, "ship-it")["status"] == "done"
