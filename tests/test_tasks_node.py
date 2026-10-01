import pytest

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


@pytest.mark.parametrize("title", [
    "E2E vs real node:20-slim " + "x" * 60,
    "is it possible to not trigger the phone keyboard when clicking a macro key?",
    "phase keeps setting itself to -1 or s 1 when clearing...? default to null",
    "make it black;, then shift it left so it centers over the border of the panel",
    "#hash, [brackets] {braces} & 'quotes' \"double\" ’curly’ | pipe > gt",
])
def test_tasks_doc_titles_parse_with_the_fast_reader(tmp_path, title):
    f = tmp_path / "TASKS.yaml"
    f.write_text(yamlio.dump(yamlio.yaml(), yamlio.tasks_doc(
        [{"id": 1, "title": title, "status": "done"}])))
    assert yamlio.read(f)["tasks"][0]["title"] == title
