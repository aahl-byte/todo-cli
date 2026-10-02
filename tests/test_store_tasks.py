from todo import store

from .conftest import bare


def test_add_task_creates_list_and_calc(root):
    new_id = store.add_task(root, "beta", "write docs")
    assert new_id == 1  # first task in this item
    it = store.resolve_item(root, "beta")
    assert bare(it["tasks"]) == [{"id": 1, "title": "write docs", "status": "todo", "phase": None}]
    assert it["calc_status"] == "todo"  # single todo task


def test_set_task_status_recomputes_calc(root):
    store.add_task(root, "beta", "t1")   # id 1
    store.add_task(root, "beta", "t2")   # id 2
    assert store.set_task_status(root, "beta", 1, "done") is True
    it = store.resolve_item(root, "beta")
    assert it["tasks"][0]["status"] == "done"
    # one done, one todo → highest present is todo
    assert it["calc_status"] == "todo"
    store.set_task_status(root, "beta", 2, "in-progress")
    it = store.resolve_item(root, "beta")
    assert it["calc_status"] == "in-progress"


def test_all_done_rolls_calc_to_done(root):
    store.add_task(root, "beta", "t1")   # id 1
    store.set_task_status(root, "beta", 1, "done")
    it = store.resolve_item(root, "beta")
    assert it["calc_status"] == "done"


def test_remove_last_task_drops_calc_status(root):
    store.add_task(root, "beta", "t1")   # id 1
    assert store.remove_task(root, "beta", 1) is True
    it = store.resolve_item(root, "beta")
    assert it["tasks"] == []
    assert it["calc_status"] is None
    # the key is gone from the file, not written as null
    assert "calc-status" not in (root / "OPEN" / "beta" / "TODO.yaml").read_text()


def test_task_mutation_leaves_manual_status_and_completed_untouched(root):
    store.add_task(root, "beta", "t1")   # id 1
    store.set_task_status(root, "beta", 1, "done")
    it = store.resolve_item(root, "beta")
    assert it["status"] == "todo"
    assert it["completed"] is None


def test_mutations_on_missing_item_return_false(root):
    assert store.add_task(root, "nope", "x") is None
    assert store.set_task_status(root, "nope", 1, "done") is False
    assert store.remove_task(root, "nope", 1) is False


def test_add_task_with_phase_stores_and_emits_it(root):
    store.add_task(root, "beta", "scaffold", phase=2)   # id 1
    it = store.resolve_item(root, "beta")
    assert bare(it["tasks"]) == [{"id": 1, "title": "scaffold", "status": "todo", "phase": 2}]
    assert (root / "OPEN" / "beta" / "phase-2" / "TASKS.yaml").is_file()


def test_tasks_auto_sort_by_phase_unphased_last(root):
    store.add_task(root, "beta", "late", phase=3)
    store.add_task(root, "beta", "no-phase")          # unphased → sorts last
    store.add_task(root, "beta", "early", phase=1)
    titles = [t["title"] for t in store.resolve_item(root, "beta")["tasks"]]
    assert titles == ["early", "late", "no-phase"]


def test_same_phase_keeps_insertion_order(root):
    store.add_task(root, "beta", "a", phase=1)
    store.add_task(root, "beta", "b", phase=1)
    titles = [t["title"] for t in store.resolve_item(root, "beta")["tasks"]]
    assert titles == ["a", "b"]


def test_set_task_phase_resorts_and_can_clear(root):
    store.add_task(root, "beta", "x")                 # id 1, unphased
    store.add_task(root, "beta", "y", phase=1)        # id 2, sorts before x
    # the id is constant across re-sorts: x is always id 1 no matter where it
    # renders. Give it phase 0 → it jumps to the front.
    assert store.set_task_phase(root, "beta", 1, 0) is True
    titles = [t["title"] for t in store.resolve_item(root, "beta")["tasks"]]
    assert titles == ["x", "y"]
    # clearing the phase (None) sends it back to the unphased tail — still id 1
    store.set_task_phase(root, "beta", 1, None)
    it = store.resolve_item(root, "beta")
    assert [t["title"] for t in it["tasks"]] == ["y", "x"]
    assert it["tasks"][1]["phase"] is None
    assert "phase" not in (root / "OPEN" / "beta" / "unphased" / "TASKS.yaml").read_text()


def test_set_task_phase_on_missing_item_returns_false(root):
    assert store.set_task_phase(root, "nope", 0, 1) is False
