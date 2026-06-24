from todo import yamlio


def test_tasks_node_builds_title_status_maps():
    node = yamlio.tasks_node([
        {"title": "a", "status": "done"},
        {"title": "b", "status": "todo"},
    ])
    assert [dict(m) for m in node] == [
        {"title": "a", "status": "done"},
        {"title": "b", "status": "todo"},
    ]


def test_tasks_node_empty():
    assert list(yamlio.tasks_node([])) == []
