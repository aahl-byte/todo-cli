from todo import yamlio


def test_tasks_doc_builds_flow_maps_without_phase():
    doc = yamlio.tasks_doc([
        {"id": 1, "title": "a", "status": "done", "phase": 3},
        {"id": 2, "title": "b", "status": "todo"},
    ])
    assert yamlio.dump(yamlio.yaml(), doc) == (
        "tasks:\n"
        "  - {id: 1, title: a, status: done}\n"
        "  - {id: 2, title: b, status: todo}\n"
    )


def test_tasks_doc_empty():
    assert list(yamlio.tasks_doc([])["tasks"]) == []
