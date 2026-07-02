"""Constant per-item ids for tasks and notes: ids stay stable across re-sorts
and sibling deletions, references resolve by id (not list index), and legacy
files (no stored id, scalar notes) migrate deterministically."""

from todo import store


# ── task ids ──────────────────────────────────────────────────────────────────
def test_task_id_is_stable_across_phase_resort(todo_file):
    a = store.add_task(todo_file, "beta", "a")            # id 1, unphased (tail)
    b = store.add_task(todo_file, "beta", "b", phase=1)   # id 2, sorts first
    assert (a, b) == (1, 2)
    # b renders before a, but each keeps its own id regardless of position
    tasks = store.resolve_item(todo_file, "beta")["tasks"]
    assert [(t["id"], t["title"]) for t in tasks] == [(2, "b"), (1, "a")]


def test_new_task_id_is_max_plus_one_and_survives_middle_delete(todo_file):
    store.add_task(todo_file, "beta", "a")   # id 1
    store.add_task(todo_file, "beta", "b")   # id 2
    store.add_task(todo_file, "beta", "c")   # id 3
    store.remove_task(todo_file, "beta", 2)  # drop the middle one
    tasks = store.resolve_item(todo_file, "beta")["tasks"]
    assert [(t["id"], t["title"]) for t in tasks] == [(1, "a"), (3, "c")]
    # a fresh task is max(existing)+1 — the surviving ids are never renumbered
    assert store.add_task(todo_file, "beta", "d") == 4


def test_tail_id_is_reused_after_deleting_the_highest(todo_file):
    store.add_task(todo_file, "beta", "a")   # id 1
    store.add_task(todo_file, "beta", "b")   # id 2
    store.remove_task(todo_file, "beta", 2)  # remove the highest
    # max+1 policy: with 2 gone, the next id is 2 again (documented tradeoff)
    assert store.add_task(todo_file, "beta", "c") == 2


def test_set_status_by_id_hits_the_right_task_after_resort(todo_file):
    store.add_task(todo_file, "beta", "a")            # id 1
    store.add_task(todo_file, "beta", "b", phase=1)   # id 2, now renders first
    store.set_task_status(todo_file, "beta", 1, "done")   # target id 1 (== "a")
    by_id = {t["id"]: t for t in store.resolve_item(todo_file, "beta")["tasks"]}
    assert by_id[1]["status"] == "done"
    assert by_id[2]["status"] == "todo"


# ── note ids ──────────────────────────────────────────────────────────────────
def test_add_note_returns_serial_id(todo_file):
    assert store.add_note(todo_file, "beta", "first") == 1
    assert store.add_note(todo_file, "beta", "second") == 2
    notes = store.resolve_item(todo_file, "beta")["notes"]
    assert notes == [{"id": 1, "text": "first"}, {"id": 2, "text": "second"}]


def test_remove_note_by_id_keeps_other_ids(todo_file):
    store.add_note(todo_file, "beta", "first")    # id 1
    store.add_note(todo_file, "beta", "second")   # id 2
    store.add_note(todo_file, "beta", "third")    # id 3
    assert store.remove_note(todo_file, "beta", 2) is True
    notes = store.resolve_item(todo_file, "beta")["notes"]
    assert [(n["id"], n["text"]) for n in notes] == [(1, "first"), (3, "third")]


def test_remove_missing_note_returns_false(todo_file):
    store.add_note(todo_file, "beta", "only")   # id 1
    assert store.remove_note(todo_file, "beta", 99) is False
    assert store.remove_note(todo_file, "nope", 1) is False


def test_multiline_note_stays_a_block_literal(todo_file):
    store.add_note(todo_file, "beta", "line one\nline two")
    text = todo_file.read_text()
    assert "text: |" in text          # `|` block literal, not a folded/quoted blob
    assert "line one" in text and "line two" in text


# ── legacy migration ──────────────────────────────────────────────────────────
def test_legacy_scalar_notes_get_ids_and_persist_as_maps(todo_file):
    # alpha's fixture note is a bare scalar ("first note"), no id
    it = store.resolve_item(todo_file, "alpha")
    assert it["notes"] == [{"id": 1, "text": "first note"}]
    # a mutation persists the block-map form with the id written to disk
    store.add_note(todo_file, "alpha", "second")
    text = todo_file.read_text()
    assert "id: 1" in text and "text: first note" in text
    notes = store.resolve_item(todo_file, "alpha")["notes"]
    assert [(n["id"], n["text"]) for n in notes] == [(1, "first note"), (2, "second")]


def test_legacy_tasks_get_ids_persisted_on_mutation(todo_file):
    todo_file.write_text(
        "todos:\n"
        "  - id: gamma\n"
        "    title: GAMMA\n"
        "    status: todo\n"
        "    tasks:\n"
        "      - {title: one, status: done}\n"
        "      - {title: two, status: todo}\n"
    )
    # reading assigns ids by position (not yet persisted)
    tasks = store.resolve_item(todo_file, "gamma")["tasks"]
    assert [t["id"] for t in tasks] == [1, 2]
    # a mutation writes them; a brand-new task continues the serial
    assert store.add_task(todo_file, "gamma", "three") == 3
    text = todo_file.read_text()
    assert "id: 1" in text and "id: 2" in text and "id: 3" in text
