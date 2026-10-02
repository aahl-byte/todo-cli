"""Constant per-item ids for tasks and notes: ids stay stable across re-sorts
and sibling deletions, references resolve by id (not list index), and legacy
files (no stored id, scalar notes) migrate deterministically."""

from todo import frontmatter, store

from .conftest import TS, bare, make_store


# ── task ids ──────────────────────────────────────────────────────────────────
def test_task_id_is_stable_across_phase_resort(root):
    a = store.add_task(root, "beta", "a")            # id 1, unphased (tail)
    b = store.add_task(root, "beta", "b", phase=1)   # id 2, sorts first
    assert (a, b) == (1, 2)
    # b renders before a, but each keeps its own id regardless of position
    tasks = store.resolve_item(root, "beta")["tasks"]
    assert [(t["id"], t["title"]) for t in tasks] == [(2, "b"), (1, "a")]


def test_new_task_id_is_max_plus_one_and_survives_middle_delete(root):
    store.add_task(root, "beta", "a")   # id 1
    store.add_task(root, "beta", "b")   # id 2
    store.add_task(root, "beta", "c")   # id 3
    store.remove_task(root, "beta", 2)  # drop the middle one
    tasks = store.resolve_item(root, "beta")["tasks"]
    assert [(t["id"], t["title"]) for t in tasks] == [(1, "a"), (3, "c")]
    # a fresh task is max(existing)+1 — the surviving ids are never renumbered
    assert store.add_task(root, "beta", "d") == 4


def test_tail_id_is_reused_after_deleting_the_highest(root):
    store.add_task(root, "beta", "a")   # id 1
    store.add_task(root, "beta", "b")   # id 2
    store.remove_task(root, "beta", 2)  # remove the highest
    # max+1 policy: with 2 gone, the next id is 2 again (documented tradeoff)
    assert store.add_task(root, "beta", "c") == 2


def test_set_status_by_id_hits_the_right_task_after_resort(root):
    store.add_task(root, "beta", "a")            # id 1
    store.add_task(root, "beta", "b", phase=1)   # id 2, now renders first
    store.set_task_status(root, "beta", 1, "done")   # target id 1 (== "a")
    by_id = {t["id"]: t for t in store.resolve_item(root, "beta")["tasks"]}
    assert by_id[1]["status"] == "done"
    assert by_id[2]["status"] == "todo"


# ── note ids ──────────────────────────────────────────────────────────────────
def test_add_note_returns_serial_id(root):
    assert store.add_note(root, "beta", "first", TS) == 1
    assert store.add_note(root, "beta", "second", TS) == 2
    notes = store.resolve_item(root, "beta")["notes"]
    assert bare(notes, ("id", "text")) == [{"id": 1, "text": "first"}, {"id": 2, "text": "second"}]


def test_remove_note_by_id_keeps_other_ids(root):
    store.add_note(root, "beta", "first", TS)    # id 1
    store.add_note(root, "beta", "second", TS)   # id 2
    store.add_note(root, "beta", "third", TS)    # id 3
    assert store.remove_note(root, "beta", 2) is True
    notes = store.resolve_item(root, "beta")["notes"]
    assert [(n["id"], n["text"]) for n in notes] == [(1, "first"), (3, "third")]


def test_remove_missing_note_returns_false(root):
    store.add_note(root, "beta", "only", TS)   # id 1
    assert store.remove_note(root, "beta", 99) is False
    assert store.remove_note(root, "nope", 1) is False


def test_multiline_note_is_stored_verbatim_as_markdown(root):
    store.add_note(root, "beta", "**bold**\n\n- line two", TS)
    f, = (root / "OPEN" / "beta" / "notes").iterdir()
    assert f.name == "2026-06-25T09-30-00.000Z-1.md"
    assert frontmatter.split(f.read_text())[1] == "**bold**\n\n- line two\n"
    assert store.resolve_item(root, "beta")["notes"][0]["text"] == "**bold**\n\n- line two"


# ── legacy migration ──────────────────────────────────────────────────────────
def test_legacy_scalar_notes_get_ids(root):
    # alpha's fixture note is a bare scalar ("first note"), no id
    it = store.resolve_item(root, "alpha")
    assert bare(it["notes"], ("id", "text")) == [{"id": 1, "text": "first note"}]
    assert store.add_note(root, "alpha", "second", TS) == 2


def test_legacy_tasks_get_ids_by_position(tmp_path):
    root = make_store(tmp_path / "p",
        "todos:\n"
        "  - id: gamma\n"
        "    title: GAMMA\n"
        "    status: todo\n"
        "    tasks:\n"
        "      - {title: one, status: done}\n"
        "      - {id: 5, title: two, status: todo}\n"
        "      - {title: three, status: todo}\n"
    )
    tasks = store.resolve_item(root, "gamma")["tasks"]
    assert [t["id"] for t in tasks] == [6, 5, 7]
    assert store.add_task(root, "gamma", "four") == 8
