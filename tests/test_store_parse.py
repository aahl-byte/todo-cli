from todo import store


def test_item_without_tasks_has_empty_list_and_no_calc(todo_file):
    it = store.resolve_item(todo_file, "alpha")
    assert it["tasks"] == []
    assert it["calc_status"] is None


def test_item_with_tasks_parsed(todo_file):
    todo_file.write_text(
        "todos:\n"
        "  - id: gamma\n"
        "    title: GAMMA\n"
        "    status: todo\n"
        "    calc-status: in-progress\n"
        "    tasks:\n"
        "      - {title: one, status: done}\n"
        "      - {title: two, status: in-progress}\n"
    )
    it = store.resolve_item(todo_file, "gamma")
    # legacy tasks (no stored id) get serial ids assigned by position
    assert it["tasks"] == [
        {"id": 1, "title": "one", "status": "done", "phase": None},
        {"id": 2, "title": "two", "status": "in-progress", "phase": None},
    ]
    assert it["calc_status"] == "in-progress"
