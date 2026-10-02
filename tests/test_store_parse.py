from todo import store

from .conftest import bare, make_store


def test_item_without_tasks_has_empty_list_and_no_calc(root):
    it = store.resolve_item(root, "alpha")
    assert it["tasks"] == []
    assert it["calc_status"] is None


def test_item_with_tasks_parsed(tmp_path):
    root = make_store(tmp_path / "p",
        "todos:\n"
        "  - id: gamma\n"
        "    title: GAMMA\n"
        "    status: todo\n"
        "    calc-status: in-progress\n"
        "    tasks:\n"
        "      - {title: one, status: done, phase: 2}\n"
        "      - {title: two, status: in-progress}\n"
    )
    it = store.resolve_item(root, "gamma")
    assert bare(it["tasks"]) == [
        {"id": 1, "title": "one", "status": "done", "phase": 2},
        {"id": 2, "title": "two", "status": "in-progress", "phase": None},
    ]
    assert it["calc_status"] == "in-progress"
    item = root / "OPEN" / "gamma"
    assert (item / "phase-2" / "TASKS.yaml").is_file()
    assert (item / "unphased" / "TASKS.yaml").is_file()
