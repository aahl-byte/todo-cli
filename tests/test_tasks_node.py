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


def test_tasks_doc_quotes_colons_so_the_fast_reader_parses_it(tmp_path):
    f = tmp_path / "TASKS.yaml"
    f.write_text(yamlio.dump(yamlio.yaml(), yamlio.tasks_doc(
        [{"id": 1, "title": "E2E vs real node:20-slim " + "x" * 60, "status": "done"}])))
    assert yamlio.read(f)["tasks"][0]["title"].startswith("E2E vs real node:20-slim")
