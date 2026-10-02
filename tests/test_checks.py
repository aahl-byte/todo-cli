"""Deployment checks, the deploy gate and `todo deploy-plan`."""

import pytest

from todo import store, yamlio

from .conftest import run_cli


def checks(root, q="beta"):
    return store.resolve_item(root, q)["checks"]


def test_check_lifecycle(root):
    run_cli(root, ["check", "add", "beta", "db-script", "add", "index", "--payload", "db/1.sql"])
    run_cli(root, ["check", "add", "beta", "env-var", "TTL=3600: seconds", "--post"])
    c1, c2 = checks(root)
    assert (c1["kind"], c1["title"], c1["payload"], c1["timing"], c1["status"]) == (
        "db-script", "add index", "db/1.sql", "pre-deploy", "pending")
    assert (c2["timing"], c2["title"], c2["payload"]) == ("post-deploy", "TTL=3600: seconds", None)
    assert c1["uid"] and c2["uid"] and c1["uid"] != c2["uid"]
    run_cli(root, ["check", "done", "beta", "1"])
    assert checks(root)[0]["status"] == "done"
    run_cli(root, ["check", "reopen", "beta", "1"])
    assert checks(root)[0]["status"] == "pending"
    run_cli(root, ["check", "rm", "beta", "1"])
    assert [c["id"] for c in checks(root)] == [2]


def test_checks_file_parses_with_the_c_loader(root):
    run_cli(root, ["check", "add", "beta", "other", "a: b, {c} #d", "--payload", "x=1; y?"])
    f = root / "OPEN" / "beta" / "checks" / "CHECKS.yaml"
    doc = yamlio.read(f)
    assert doc["checks"][0]["title"] == "a: b, {c} #d"
    assert doc["checks"][0]["payload"] == "x=1; y?"


def test_removing_the_last_check_removes_the_file(root):
    run_cli(root, ["check", "add", "beta", "other", "x"])
    run_cli(root, ["check", "rm", "beta", "1"])
    assert not (root / "OPEN" / "beta" / "checks").exists()


@pytest.mark.parametrize("argv", [["deploy", "beta"], ["status", "beta", "deployed"],
                                  ["deployed", "beta"]])
def test_gate_blocks_deploy_with_pending_pre_deploy(root, argv):
    run_cli(root, ["check", "add", "beta", "db-script", "migrate"])
    with pytest.raises(SystemExit):
        run_cli(root, argv)
    assert store.resolve_item(root, "beta")["status"] == "todo"
    run_cli(root, argv + ["--force"])
    it = store.resolve_item(root, "beta")
    assert it["status"] == "deployed"
    assert it["history"][-1]["forced"] is True


def test_post_deploy_checks_do_not_gate(root):
    run_cli(root, ["check", "add", "beta", "manual-step", "smoke test", "--post"])
    run_cli(root, ["deploy", "beta"])
    it = store.resolve_item(root, "beta")
    assert it["status"] == "deployed"
    assert it["history"][-1]["forced"] is False


def test_deploy_plan_groups_orders_and_warns(root, capsys):
    run_cli(root, ["add", "prereq thing"])
    for q in ("alpha", "beta"):
        run_cli(root, ["approve", q])
    run_cli(root, ["check", "add", "beta", "env-var", "B_ENV"])
    run_cli(root, ["check", "add", "alpha", "db-script", "A_SQL"])
    run_cli(root, ["check", "add", "beta", "db-script", "B_SQL"])
    run_cli(root, ["check", "add", "alpha", "prereq-branch", "NEEDS", "--payload", "prereq-thing"])
    run_cli(root, ["check", "add", "alpha", "prereq-branch", "BRANCH", "--payload", "feat/x"])
    run_cli(root, ["check", "add", "alpha", "manual-step", "smoke", "--post"])
    capsys.readouterr()
    run_cli(root, ["deploy-plan"])
    out = capsys.readouterr().out
    order = ["NEEDS", "BRANCH", "A_SQL", "B_SQL", "B_ENV", "post-deploy", "smoke"]
    positions = [out.index(w) for w in order]
    assert positions == sorted(positions)
    needs_line = next(ln for ln in out.splitlines() if "NEEDS" in ln)
    branch_line = next(ln for ln in out.splitlines() if "BRANCH" in ln)
    assert "⚠ not deployed" in needs_line
    assert "⚠" not in branch_line


def test_deploy_plan_lists_deployed_items_with_open_post_checks(root, capsys):
    run_cli(root, ["check", "add", "beta", "manual-step", "verify", "--post"])
    run_cli(root, ["deploy", "beta"])
    capsys.readouterr()
    run_cli(root, ["deploy-plan"])
    out = capsys.readouterr().out
    assert "deployed — post-deploy pending" in out
    assert "verify" in out
