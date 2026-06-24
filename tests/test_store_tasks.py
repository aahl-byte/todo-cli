from todo import store


def test_add_task_creates_list_and_calc(todo_file):
    ok = store.add_task(todo_file, "beta", "write docs")
    assert ok is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "write docs", "status": "todo", "phase": None}]
    assert it["calc_status"] == "todo"  # single todo task


def test_set_task_status_recomputes_calc(todo_file):
    store.add_task(todo_file, "beta", "t1")
    store.add_task(todo_file, "beta", "t2")
    assert store.set_task_status(todo_file, "beta", 0, "done") is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "done"
    # one done, one todo → highest present is todo
    assert it["calc_status"] == "todo"
    store.set_task_status(todo_file, "beta", 1, "in-progress")
    it = store.resolve_item(todo_file, "beta")
    assert it["calc_status"] == "in-progress"


def test_all_done_rolls_calc_to_done(todo_file):
    store.add_task(todo_file, "beta", "t1")
    store.set_task_status(todo_file, "beta", 0, "done")
    it = store.resolve_item(todo_file, "beta")
    assert it["calc_status"] == "done"


def test_remove_last_task_drops_calc_status(todo_file):
    store.add_task(todo_file, "beta", "t1")
    assert store.remove_task(todo_file, "beta", 0) is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == []
    assert it["calc_status"] is None
    # the key is gone from the file, not written as null
    assert "calc-status" not in todo_file.read_text()


def test_task_mutation_leaves_manual_status_and_completed_untouched(todo_file):
    store.add_task(todo_file, "beta", "t1")
    store.set_task_status(todo_file, "beta", 0, "done")
    it = store.resolve_item(todo_file, "beta")
    assert it["status"] == "todo"
    assert it["completed"] is None


def test_mutations_on_missing_item_return_false(todo_file):
    assert store.add_task(todo_file, "nope", "x") is False
    assert store.set_task_status(todo_file, "nope", 0, "done") is False
    assert store.remove_task(todo_file, "nope", 0) is False


def test_add_task_with_phase_stores_and_emits_it(todo_file):
    store.add_task(todo_file, "beta", "scaffold", phase=2)
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "scaffold", "status": "todo", "phase": 2}]
    # the phase key is actually written to the file (only when set)
    assert "phase: 2" in todo_file.read_text()


def test_tasks_auto_sort_by_phase_unphased_last(todo_file):
    store.add_task(todo_file, "beta", "late", phase=3)
    store.add_task(todo_file, "beta", "no-phase")          # unphased → sorts last
    store.add_task(todo_file, "beta", "early", phase=1)
    titles = [t["title"] for t in store.resolve_item(todo_file, "beta")["tasks"]]
    assert titles == ["early", "late", "no-phase"]


def test_same_phase_keeps_insertion_order(todo_file):
    store.add_task(todo_file, "beta", "a", phase=1)
    store.add_task(todo_file, "beta", "b", phase=1)
    titles = [t["title"] for t in store.resolve_item(todo_file, "beta")["tasks"]]
    assert titles == ["a", "b"]


def test_set_task_phase_resorts_and_can_clear(todo_file):
    store.add_task(todo_file, "beta", "x")                 # index 0, unphased
    store.add_task(todo_file, "beta", "y", phase=1)        # sorts before x
    # x is now index 1; give it phase 0 → it jumps to the front
    assert store.set_task_phase(todo_file, "beta", 1, 0) is True
    titles = [t["title"] for t in store.resolve_item(todo_file, "beta")["tasks"]]
    assert titles == ["x", "y"]
    # clearing the phase (None) sends it back to the unphased tail
    store.set_task_phase(todo_file, "beta", 0, None)
    it = store.resolve_item(todo_file, "beta")
    assert [t["title"] for t in it["tasks"]] == ["y", "x"]
    assert it["tasks"][1]["phase"] is None
    assert "phase: 0" not in todo_file.read_text()         # cleared key not written


def test_set_task_phase_on_missing_item_returns_false(todo_file):
    assert store.set_task_phase(todo_file, "nope", 0, 1) is False
