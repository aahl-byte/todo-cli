from todo import yamlio


def test_tasks_node_builds_id_title_status_maps():
    node = yamlio.tasks_node([
        {"id": 1, "title": "a", "status": "done"},
        {"id": 2, "title": "b", "status": "todo"},
    ])
    assert [dict(m) for m in node] == [
        {"id": 1, "title": "a", "status": "done"},
        {"id": 2, "title": "b", "status": "todo"},
    ]


def test_tasks_node_empty():
    assert list(yamlio.tasks_node([])) == []
