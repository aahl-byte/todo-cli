from todo import store, ulid

from .conftest import run_cli


def test_ulids_are_unique_and_ordered():
    ids = [ulid.new() for _ in range(2000)]
    assert len(set(ids)) == len(ids)
    assert ids == sorted(ids)
    assert all(len(i) == 26 for i in ids)


def test_task_uid_survives_edits(root):
    run_cli(root, ["task", "add", "beta", "one", "--phase", "1"])
    run_cli(root, ["task", "add", "beta", "two", "--phase", "1"])
    uid = store.resolve_item(root, "beta")["tasks"][0]["uid"]
    run_cli(root, ["task", "start", "beta", "1"])
    run_cli(root, ["task", "move", "beta", "1", "--bottom"])
    run_cli(root, ["task", "phase", "beta", "1", "3"])
    t = next(t for t in store.resolve_item(root, "beta")["tasks"] if t["id"] == 1)
    assert (t["uid"], t["phase"], t["status"]) == (uid, 3, "in-progress")
