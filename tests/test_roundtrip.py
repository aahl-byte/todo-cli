from todo import store

from .conftest import make_store

BODY = """\
todos:
  - id: alpha
    title: ALPHA
    status: in-progress
    created: 2026-06-24T10:00:00.000Z
    acceptance: keep me   # inline comment
    tasks:
      - {title: one, status: todo, phase: 1}
      - {title: two, status: todo, phase: 2}
"""


def test_item_fields_and_comments_survive_task_mutation(tmp_path):
    root = make_store(tmp_path / "p", BODY)
    meta = root / "OPEN" / "alpha" / "TODO.yaml"
    store.set_task_status(root, "alpha", 1, "in-progress")
    text = meta.read_text()
    assert "# inline comment" in text and "acceptance: keep me" in text
    assert "created: 2026-06-24T10:00:00.000Z" in text
    assert "calc-status: in-progress" in text


def test_task_mutation_rewrites_only_its_phase_file(tmp_path):
    root = make_store(tmp_path / "p", BODY)
    other = root / "OPEN" / "alpha" / "phase-2" / "TASKS.yaml"
    before = other.stat().st_mtime_ns
    store.set_task_status(root, "alpha", 1, "done")
    assert other.stat().st_mtime_ns == before


def test_emptied_phase_directory_is_removed(tmp_path):
    root = make_store(tmp_path / "p", BODY)
    store.set_task_phase(root, "alpha", 1, 2)
    item = root / "OPEN" / "alpha"
    assert not (item / "phase-1").exists()
    assert [t["title"] for t in store.resolve_item(root, "alpha")["tasks"]] == ["two", "one"]
