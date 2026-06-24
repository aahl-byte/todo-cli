from todo import store


def test_add_task_creates_list_and_calc(todo_file):
    ok = store.add_task(todo_file, "beta", "write docs")
    assert ok is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "write docs", "status": "todo"}]
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
