"""Per-environment markers: an item records which of dev, staging and
production its work has reached, set by hand."""

import pytest

from todo import store, sync

from .conftest import run_cli


def envs(root, q="beta"):
    return store.resolve_item(root, q)["envs"]


def test_env_marks_by_label_or_name_in_lifecycle_order(root):
    run_cli(root, ["env", "beta", "P", "dev"])
    assert envs(root) == ["dev", "production"]


def test_off_clears_a_marker_and_the_last_one_drops_the_field(root):
    run_cli(root, ["env", "beta", "S"])
    run_cli(root, ["env", "beta", "staging", "--off"])
    assert envs(root) == []
    assert "envs" not in (root / "OPEN" / "beta" / "TODO.yaml").read_text()


def test_each_change_is_logged(root):
    run_cli(root, ["env", "beta", "S", "P"])
    run_cli(root, ["env", "beta", "S"])
    run_cli(root, ["env", "beta", "P", "--off"])
    assert [e["text"] for e in store.resolve_item(root, "beta")["log"]] == [
        "in staging, production", "no longer in production"]


def test_unknown_environment_is_refused(root, capsys):
    with pytest.raises(SystemExit):
        run_cli(root, ["env", "beta", "qa"])
    assert "dev (D), staging (S), production (P)" in capsys.readouterr().err


def test_get_and_list_show_the_markers(root, capsys):
    run_cli(root, ["env", "beta", "D", "S"])
    capsys.readouterr()
    run_cli(root, ["get", "beta"])
    assert "envs:      D S ·" in capsys.readouterr().out
    run_cli(root, ["list"])
    beta = next(line for line in capsys.readouterr().out.splitlines() if line.startswith("beta"))
    assert beta.endswith("[DS·]")


def test_markers_sync_as_an_extra_field(root):
    run_cli(root, ["env", "beta", "S"])
    item_dir = root / "OPEN" / "beta"
    assert sync._item_flat(item_dir, store._load_meta(item_dir)[1])["extra.envs"] == ["staging"]
