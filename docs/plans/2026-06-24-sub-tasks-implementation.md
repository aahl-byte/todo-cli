# Sub-tasks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give `todo` items a list of child **tasks** (each with the full 7-status lifecycle) plus an auto-maintained derived `calc-status` scalar, exposed through a `todo tasks` / `todo task …` CLI surface.

**Architecture:** Tasks are leaf maps `{title, status}` stored under each item's `tasks:` key, beside the unchanged `notes`. A pure `derive_calc_status()` in `status.py` maps the children's statuses to one scalar that store writes into a separate `calc-status:` field on every task mutation. The manual `status` field and everything keyed on it (`archive`, `--status`, done-hiding) are untouched — `calc-status` is informational. Display of individual statuses (dots) is the web drawer's job, out of scope here.

**Tech Stack:** Python 3.9+, `ruamel.yaml` (round-trip, comment-preserving), `pytest`, `argparse`.

**Reference:** Approved design at `docs/plans/2026-06-24-sub-tasks-design.md`.

---

## Conventions for the implementer

- Run all commands from the repo root `~/git/todo`.
- The package is installed editable (`pip install -e .`), so `from todo import …`
  works and the `todo` CLI reflects source changes immediately.
- Existing helpers you'll reuse: `util.now()` (ISO-Z timestamp), `util.to_str()`
  (None-safe str), `util.die(msg, code)`, `store.resolve_item()` (fuzzy lookup,
  dies on miss/ambiguity), `yamlio.load_or_empty()` / `yamlio.save()`.
- Indices are **0-based**, matching `notes` / `unnote`.
- TDD throughout: write the failing test, watch it fail, implement, watch it pass,
  commit.

---

## Task 0: Test scaffolding

**Files:**
- Modify: `pyproject.toml`
- Create: `tests/__init__.py` (empty)
- Create: `tests/conftest.py`

**Step 1: Add a dev extra for pytest.**

In `pyproject.toml`, after the `[project]` table's `dependencies = [...]` block,
add:

```toml
[project.optional-dependencies]
dev = ["pytest>=7"]
```

**Step 2: Create `tests/__init__.py`** (empty file).

**Step 3: Create `tests/conftest.py`** with a fixture that writes a temp
`TODO.yaml` and hands back its `Path`:

```python
"""Shared fixtures: a temp TODO.yaml the store/CLI can mutate in isolation."""

from pathlib import Path

import pytest

SAMPLE = """\
# Project TODO — edit through the `todo` CLI.
todos:
  - id: alpha
    title: ALPHA
    type: feature
    status: in-progress
    priority: medium
    phase: null
    created: 2026-06-24T10:00:00.000Z
    completed: null
    notes:
      - first note
  - id: beta
    title: BETA
    type: feature
    status: todo
    priority: medium
    phase: null
    created: 2026-06-24T11:00:00.000Z
    completed: null
    notes: []
"""


@pytest.fixture
def todo_file(tmp_path) -> Path:
    f = tmp_path / "TODO.yaml"
    f.write_text(SAMPLE)
    return f
```

**Step 4: Verify pytest collects nothing yet but runs clean.**

Run: `python -m pytest -q`
Expected: `no tests ran` (exit 5) — confirms pytest is wired up.

**Step 5: Commit.**

```bash
git add pyproject.toml tests/__init__.py tests/conftest.py
git commit -m "test: pytest scaffolding + temp TODO.yaml fixture"
```

---

## Task 1: `derive_calc_status` (pure function)

**Files:**
- Modify: `todo/status.py`
- Test: `tests/test_calc_status.py`

**Step 1: Write the failing test** — create `tests/test_calc_status.py`:

```python
from todo.status import derive_calc_status


def test_no_tasks_returns_none():
    assert derive_calc_status([]) is None


def test_all_done():
    assert derive_calc_status(["done", "done"]) == "done"


def test_all_deferred():
    assert derive_calc_status(["deferred", "deferred"]) == "deferred"


def test_deferred_excluded_from_done_check():
    # the only non-deferred task is done → parent done
    assert derive_calc_status(["done", "deferred"]) == "done"


def test_in_progress_dominates():
    assert derive_calc_status(["todo", "in-progress", "done"]) == "in-progress"


def test_blocked_when_nothing_in_progress():
    assert derive_calc_status(["todo", "blocked", "done"]) == "blocked"


def test_precedence_order():
    # in-progress > blocked > review > in-triage > todo
    assert derive_calc_status(["review", "in-triage", "todo"]) == "review"
    assert derive_calc_status(["in-triage", "todo"]) == "in-triage"


def test_some_done_rest_todo_is_todo():
    # nothing active; highest present among the precedence list is todo
    assert derive_calc_status(["done", "todo"]) == "todo"
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_calc_status.py -q`
Expected: FAIL — `ImportError: cannot import name 'derive_calc_status'`.

**Step 3: Implement** — append to `todo/status.py`:

```python
# Precedence for the DERIVED parent scalar (calc-status), highest first.
# `done` (all non-deferred done) and `deferred` (all deferred) are handled
# separately; this list ranks the in-flight states.
CALC_PRECEDENCE = ["in-progress", "blocked", "review", "in-triage", "todo"]


def derive_calc_status(task_statuses):
    """Roll a list of child task statuses up to one scalar, or None when there
    are no tasks. `deferred` children are excluded from the completion math: an
    item is `done` only when every non-deferred task is done; if every task is
    deferred the item is `deferred`; otherwise it's the highest-ranked state
    present (see CALC_PRECEDENCE)."""
    if not task_statuses:
        return None
    non_deferred = [s for s in task_statuses if s != "deferred"]
    if not non_deferred:
        return "deferred"
    if all(s == "done" for s in non_deferred):
        return "done"
    for s in CALC_PRECEDENCE:
        if s in non_deferred:
            return s
    return "todo"
```

**Step 4: Run to verify it passes.**

Run: `python -m pytest tests/test_calc_status.py -q`
Expected: PASS (8 passed).

**Step 5: Commit.**

```bash
git add todo/status.py tests/test_calc_status.py
git commit -m "feat: derive_calc_status — roll task statuses up to one scalar"
```

---

## Task 2: yamlio `tasks_node` helper

**Files:**
- Modify: `todo/yamlio.py`
- Test: `tests/test_tasks_node.py`

**Step 1: Write the failing test** — create `tests/test_tasks_node.py`:

```python
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
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_tasks_node.py -q`
Expected: FAIL — `AttributeError: module 'todo.yamlio' has no attribute 'tasks_node'`.

**Step 3: Implement** — append to `todo/yamlio.py` (CommentedMap is already
imported indirectly; add it to the top-of-file import from
`ruamel.yaml.comments` so the line reads
`from ruamel.yaml.comments import CommentedMap, CommentedSeq`):

```python
def tasks_node(tasks) -> CommentedSeq:
    """Build the `tasks:` sequence — one compact flow map `{title, status}` per
    task. Rebuilt wholesale on each mutation (like notes); tasks don't carry
    inline comments, so nothing is lost."""
    seq = CommentedSeq()
    for t in tasks:
        m = CommentedMap()
        m["title"] = str(t["title"])
        m["status"] = str(t["status"])
        m.fa.set_flow_style()
        seq.append(m)
    return seq
```

**Step 4: Run to verify it passes.**

Run: `python -m pytest tests/test_tasks_node.py -q`
Expected: PASS (2 passed).

**Step 5: Commit.**

```bash
git add todo/yamlio.py tests/test_tasks_node.py
git commit -m "feat: yamlio.tasks_node — compact {title,status} task maps"
```

---

## Task 3: store — parse tasks + calc-status in `_to_item`

**Files:**
- Modify: `todo/store.py` (`_to_item`)
- Test: `tests/test_store_parse.py`

**Step 1: Write the failing test** — create `tests/test_store_parse.py`:

```python
from todo import store


def test_item_without_tasks_has_empty_list_and_no_calc(todo_file):
    it = store.resolve_item(todo_file, "alpha")
    assert it["tasks"] == []
    assert it["calc_status"] is None


def test_item_with_tasks_parsed(todo_file):
    # seed a task directly through the (about-to-exist) add_task in later tasks;
    # here we just assert the parse shape on a hand-written file.
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
    assert it["tasks"] == [
        {"title": "one", "status": "done"},
        {"title": "two", "status": "in-progress"},
    ]
    assert it["calc_status"] == "in-progress"
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_store_parse.py -q`
Expected: FAIL — `KeyError: 'tasks'`.

**Step 3: Implement** — in `todo/store.py`, extend `_to_item` to parse tasks and
`calc-status`. Replace the body of `_to_item` so it adds the two new keys:

```python
def _to_item(node) -> dict:
    notes_raw = node.get("notes")
    notes = [to_str(n) for n in notes_raw] if isinstance(notes_raw, list) else []
    tasks_raw = node.get("tasks")
    tasks = []
    if isinstance(tasks_raw, list):
        for t in tasks_raw:
            if isinstance(t, dict):
                tasks.append({
                    "title": to_str(t.get("title")),
                    "status": to_str(t.get("status")) or "todo",
                })
    calc = node.get("calc-status")
    phase = node.get("phase")
    created = node.get("created")
    completed = node.get("completed")
    return {
        "id": to_str(node.get("id")),
        "title": to_str(node.get("title")),
        "type": to_str(node.get("type")) or "feature",
        "status": to_str(node.get("status")) or "todo",
        "priority": to_str(node.get("priority")) if node.get("priority") is not None else None,
        "phase": int(phase) if phase not in (None, "") else None,
        "notes": notes,
        "tasks": tasks,
        "calc_status": to_str(calc) if calc not in (None, "") else None,
        "created": to_str(created) if created not in (None, "") else None,
        "completed": to_str(completed) if completed not in (None, "") else None,
    }
```

**Step 4: Run to verify it passes.**

Run: `python -m pytest tests/test_store_parse.py -q`
Expected: PASS (2 passed). Also run the full suite: `python -m pytest -q`
(everything green — confirms the `_to_item` shape change didn't break parsing).

**Step 5: Commit.**

```bash
git add todo/store.py tests/test_store_parse.py
git commit -m "feat: parse tasks + calc-status into the item dict"
```

---

## Task 4: store — task mutations (add / set-status / remove) with calc-status write-back

**Files:**
- Modify: `todo/store.py`
- Test: `tests/test_store_tasks.py`

**Step 1: Write the failing test** — create `tests/test_store_tasks.py`:

```python
from todo import store


def test_add_task_creates_list_and_calc(todo_file):
    ok = store.add_task(todo_file, "beta", "write docs")
    assert ok is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "write docs", "status": "todo"}]
    assert it["calc_status"] == "todo"  # single todo task


def test_set_task_status_recomputes_calc(todo_file):
    store.add_task(todo_file, "beta", "t1")
    store.add_task(todo_file, "beta", "t2")
    assert store.set_task_status(todo_file, "beta", 0, "done") is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "done"
    # one done, one todo → highest present is todo
    assert it["calc_status"] == "todo"
    store.set_task_status(todo_file, "beta", 1, "in-progress")
    it = store.resolve_item(todo_file, "beta")
    assert it["calc_status"] == "in-progress"


def test_all_done_rolls_calc_to_done(todo_file):
    store.add_task(todo_file, "beta", "t1")
    store.set_task_status(todo_file, "beta", 0, "done")
    it = store.resolve_item(todo_file, "beta")
    assert it["calc_status"] == "done"


def test_remove_last_task_drops_calc_status(todo_file):
    store.add_task(todo_file, "beta", "t1")
    assert store.remove_task(todo_file, "beta", 0) is True
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == []
    assert it["calc_status"] is None
    # the key is gone from the file, not written as null
    assert "calc-status" not in todo_file.read_text()


def test_task_mutation_leaves_manual_status_and_completed_untouched(todo_file):
    # beta starts status: todo, completed: null — rolling calc to done must NOT
    # touch the manual status or stamp completed.
    store.add_task(todo_file, "beta", "t1")
    store.set_task_status(todo_file, "beta", 0, "done")
    it = store.resolve_item(todo_file, "beta")
    assert it["status"] == "todo"
    assert it["completed"] is None


def test_mutations_on_missing_item_return_false(todo_file):
    assert store.add_task(todo_file, "nope", "x") is False
    assert store.set_task_status(todo_file, "nope", 0, "done") is False
    assert store.remove_task(todo_file, "nope", 0) is False
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_store_tasks.py -q`
Expected: FAIL — `AttributeError: module 'todo.store' has no attribute 'add_task'`.

**Step 3: Implement** — add to `todo/store.py`. First import the helper at the
top (with the existing imports):

```python
from .status import derive_calc_status
```

Then add the task helpers (place them after `update_todo`):

```python
def _tasks_of(node) -> list:
    raw = node.get("tasks")
    if not isinstance(raw, list):
        return []
    return [
        {"title": to_str(t.get("title")), "status": to_str(t.get("status")) or "todo"}
        for t in raw if isinstance(t, dict)
    ]


def _write_tasks(node, tasks) -> None:
    """Rewrite the node's tasks and recompute its derived calc-status. Never
    touches the manual `status` or `completed` — those stay human-driven."""
    node["tasks"] = yamlio.tasks_node(tasks)
    calc = derive_calc_status([t["status"] for t in tasks])
    if calc is None:
        node.pop("calc-status", None)
    else:
        node["calc-status"] = calc


def _mutate_tasks(file, item_id, transform) -> bool:
    """Load fresh, find the item, hand its task list to `transform` (which
    mutates it in place), then rewrite + recompute + save. Returns False if the
    item doesn't exist."""
    y, data = yamlio.load_or_empty(file)
    seq = _seq(data)
    if seq is None:
        return False
    node = _find_node(seq, item_id)
    if node is None:
        return False
    tasks = _tasks_of(node)
    transform(tasks)
    _write_tasks(node, tasks)
    yamlio.save(y, file, data)
    return True


def add_task(file, item_id, title: str) -> bool:
    t = title.strip()
    if not t:
        return False
    return _mutate_tasks(file, item_id, lambda tasks: tasks.append({"title": t, "status": "todo"}))


def set_task_status(file, item_id, index: int, status: str) -> bool:
    def _set(tasks):
        if 0 <= index < len(tasks):
            tasks[index]["status"] = status
    return _mutate_tasks(file, item_id, _set)


def remove_task(file, item_id, index: int) -> bool:
    def _rm(tasks):
        if 0 <= index < len(tasks):
            del tasks[index]
    return _mutate_tasks(file, item_id, _rm)
```

Note: `set_task_status` / `remove_task` validate the index in the CLI (Task 6)
against `len(it["tasks"])` before calling, mirroring `cmd_unnote`; the in-place
guards here just keep the store functions safe if called directly.

**Step 4: Run to verify it passes.**

Run: `python -m pytest tests/test_store_tasks.py -q`
Expected: PASS (6 passed). Then full suite: `python -m pytest -q` — all green.

**Step 5: Commit.**

```bash
git add todo/store.py tests/test_store_tasks.py
git commit -m "feat: store task mutations with calc-status write-back"
```

---

## Task 5: round-trip preservation test

**Files:**
- Test: `tests/test_roundtrip.py`

This is a regression guard for the durability contract: a task mutation must not
churn comments or ISO timestamps elsewhere in the file.

**Step 1: Write the test** — create `tests/test_roundtrip.py`:

```python
from todo import store


def test_comments_and_timestamps_survive_task_mutation(todo_file):
    before = todo_file.read_text()
    assert "# Project TODO" in before  # sanity: fixture has a comment

    store.add_task(todo_file, "alpha", "a new task")
    after = todo_file.read_text()

    # the leading comment is preserved
    assert "# Project TODO" in after
    # alpha's created timestamp is byte-identical (no datetime churn)
    assert "2026-06-24T10:00:00.000Z" in after
    # beta (untouched item) timestamp also intact
    assert "2026-06-24T11:00:00.000Z" in after
    # the existing note survives
    assert "first note" in after
    # the task landed
    assert "a new task" in after
```

**Step 2: Run.**

Run: `python -m pytest tests/test_roundtrip.py -q`
Expected: PASS (1 passed). If the comment assertion fails, the fixture's
top-of-file comment handling needs review before proceeding — do not work around
it by removing the assertion.

**Step 3: Commit.**

```bash
git add tests/test_roundtrip.py
git commit -m "test: task mutation preserves comments + timestamps"
```

---

## Task 6: CLI — `tasks` listing + `task` subcommand group

**Files:**
- Modify: `todo/cli.py`
- Test: `tests/test_cli_tasks.py`

**Step 1: Write the failing test** — create `tests/test_cli_tasks.py`. These
drive the CLI end-to-end via `build_parser()` so argument wiring is covered:

```python
from todo import store
from todo.cli import build_parser


def run(file, argv):
    """Parse argv and dispatch, like main() but against an explicit file."""
    from pathlib import Path
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(Path(file), args)


def test_task_add_and_list(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "write", "the", "docs"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"] == [{"title": "write the docs", "status": "todo"}]

    run(todo_file, ["tasks", "beta"])
    out = capsys.readouterr().out
    assert "[0]" in out
    assert "write the docs" in out
    assert "todo" in out


def test_task_start_shortcut_sets_status_and_calc(todo_file, capsys):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "start", "beta", "0"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "in-progress"
    assert it["calc_status"] == "in-progress"


def test_task_status_explicit(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "status", "beta", "0", "review"])
    it = store.resolve_item(todo_file, "beta")
    assert it["tasks"][0]["status"] == "review"


def test_task_rm(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    run(todo_file, ["task", "rm", "beta", "0"])
    assert store.resolve_item(todo_file, "beta")["tasks"] == []


def test_task_bad_index_exits(todo_file):
    run(todo_file, ["task", "add", "beta", "t1"])
    import pytest
    with pytest.raises(SystemExit):
        run(todo_file, ["task", "done", "beta", "9"])
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_cli_tasks.py -q`
Expected: FAIL — argparse exits with "invalid choice: 'task'" (SystemExit) on the
first `run`, surfacing as an error in the non-`pytest.raises` tests.

**Step 3: Implement handlers** — add to `todo/cli.py` (after `cmd_unnote`):

```python
def _task_index(it, idx: int) -> None:
    if idx < 0 or idx >= len(it["tasks"]):
        die(f"Bad task index {idx} (have {len(it['tasks'])} tasks).", 2)


def cmd_tasks(file: Path, args) -> None:
    render.print_tasks(store.resolve_item(file, args.query))


def cmd_task_add(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    title = " ".join(args.title).strip()
    if not title:
        die('Missing title. Usage: todo task add <item> "<title>"', 2)
    store.add_task(file, it["id"], title)
    print(f'{it["id"]}: added task [{len(it["tasks"])}] {title}')


def _set_task_status(file: Path, query: str, index: int, status: str) -> None:
    if status not in STATUSES:
        die(f'Invalid status "{status}". One of: {", ".join(STATUSES)}', 2)
    it = store.resolve_item(file, query)
    _task_index(it, index)
    store.set_task_status(file, it["id"], index, status)
    nxt = store.resolve_item(file, it["id"])
    calc = nxt["calc_status"] or "—"
    print(f'{it["id"]}: task [{index}] → {status}  (calc-status: {calc})')


def cmd_task_status(file: Path, args) -> None:
    _set_task_status(file, args.query, args.index, args.status)


def cmd_task_shortcut(file: Path, args) -> None:
    _set_task_status(file, args.query, args.index, SHORTCUTS[args.command])


def cmd_task_rm(file: Path, args) -> None:
    it = store.resolve_item(file, args.query)
    _task_index(it, args.index)
    store.remove_task(file, it["id"], args.index)
    print(f'{it["id"]}: removed task [{args.index}]')
```

**Step 4: Wire the parsers** — in `build_parser()`, after the `notes`/`unnote`
parsers and before the `add` parser, add the `tasks` command and the `task`
group:

```python
    p = sub.add_parser("tasks", parents=[common], help="list an item's child tasks")
    p.add_argument("query", help="id or part of a title")
    p.set_defaults(func=cmd_tasks)

    tp = sub.add_parser("task", parents=[common], help="manage an item's child tasks")
    tsub = tp.add_subparsers(dest="taskcmd", metavar="<taskcmd>")

    ta = tsub.add_parser("add", parents=[common], help="append a task")
    ta.add_argument("query", help="id or part of a title")
    ta.add_argument("title", nargs="+", help="the task title")
    ta.set_defaults(func=cmd_task_add)

    tst = tsub.add_parser("status", parents=[common], help="set a task's status explicitly")
    tst.add_argument("query", help="id or part of a title")
    tst.add_argument("index", type=int, help="task index (see `todo tasks`)")
    tst.add_argument("status", choices=STATUSES, help="new status")
    tst.set_defaults(func=cmd_task_status)

    trm = tsub.add_parser("rm", parents=[common], help="remove a task")
    trm.add_argument("query", help="id or part of a title")
    trm.add_argument("index", type=int, help="task index (see `todo tasks`)")
    trm.set_defaults(func=cmd_task_rm)

    for name, helptext in SHORTCUT_HELP.items():
        tv = tsub.add_parser(name, parents=[common], help=f"task {helptext}")
        tv.add_argument("query", help="id or part of a title")
        tv.add_argument("index", type=int, help="task index (see `todo tasks`)")
        tv.set_defaults(func=cmd_task_shortcut)
```

**Step 5: Handle bare `todo task`** — in `main()`, the `task` group needs a
fallback when no `taskcmd` is given. After the existing
`if not getattr(args, "command", None):` block, add:

```python
    if args.command == "task" and not getattr(args, "func", None):
        parser.parse_args(["task", "--help"])
        sys.exit(0)
```

(Place this before the `file = …` line. `parse_args(["task","--help"])` prints
the task group's help and exits.)

**Step 6: Run to verify it passes.**

Run: `python -m pytest tests/test_cli_tasks.py -q`
Expected: PASS (5 passed). Then full suite green: `python -m pytest -q`.

**Step 7: Commit.**

```bash
git add todo/cli.py tests/test_cli_tasks.py
git commit -m "feat: todo tasks + task add/status/rm + lifecycle shortcuts"
```

---

## Task 7: rendering — `get` shows tasks + calc-status; `list` marks items with tasks

**Files:**
- Modify: `todo/render.py`
- Test: `tests/test_render.py`

**Step 1: Write the failing test** — create `tests/test_render.py`:

```python
from todo import render


def _item(**over):
    base = {
        "id": "x", "title": "X", "type": "feature", "status": "in-progress",
        "priority": "medium", "phase": None, "notes": [], "tasks": [],
        "calc_status": None, "created": None, "completed": None,
    }
    base.update(over)
    return base


def test_print_tasks_lists_indices(capsys):
    it = _item(tasks=[{"title": "one", "status": "done"},
                      {"title": "two", "status": "todo"}],
               calc_status="todo")
    render.print_tasks(it)
    out = capsys.readouterr().out
    assert "[0]" in out and "one" in out
    assert "[1]" in out and "two" in out
    assert "calc-status" in out


def test_print_tasks_empty(capsys):
    render.print_tasks(_item())
    assert "no tasks" in capsys.readouterr().out


def test_print_item_includes_tasks_block(capsys):
    it = _item(tasks=[{"title": "one", "status": "done"}], calc_status="done")
    render.print_item(it)
    out = capsys.readouterr().out
    assert "tasks:" in out
    assert "one" in out
    assert "calc-status:" in out


def test_print_list_marks_items_with_tasks(capsys):
    items = [_item(id="withkids",
                   tasks=[{"title": "a", "status": "done"},
                          {"title": "b", "status": "todo"}],
                   calc_status="todo"),
             _item(id="plain")]
    render.print_list(items)
    out = capsys.readouterr().out
    assert "1/2 tasks" in out  # 1 of 2 done
```

**Step 2: Run to verify it fails.**

Run: `python -m pytest tests/test_render.py -q`
Expected: FAIL — `AttributeError: module 'todo.render' has no attribute 'print_tasks'`.

**Step 3: Implement** — in `todo/render.py`:

Add `print_tasks`:

```python
def print_tasks(it) -> None:
    tasks = it["tasks"]
    if not tasks:
        print("(no tasks)")
        return
    color = _use_color()
    for i, t in enumerate(tasks):
        cell = colorize(t["status"], f'{t["status"]:<12}', color)
        print(f'  [{i}] {cell} {t["title"]}')
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
```

In `print_item`, after the `status:` line add a `calc-status:` line (only when
set), and after the notes block add a tasks block. Concretely, insert right after
the existing `print(f'status:    …')` line:

```python
    if it["calc_status"]:
        print(f'calc-status: {colorize(it["calc_status"], it["calc_status"], color)}')
```

and append at the end of `print_item`:

```python
    if it["tasks"]:
        print("tasks:")
        for i, t in enumerate(it["tasks"]):
            cell = colorize(t["status"], f'{t["status"]:<12}', color)
            print(f'  [{i}] {cell} {t["title"]}')
```

In `print_list`, append a task marker to each row. Change the loop body so the
print line becomes:

```python
    for it in items:
        status = it["status"]
        cell = colorize(status, f"{status:<12}", color)
        mark = ""
        if it["tasks"]:
            done = sum(1 for t in it["tasks"] if t["status"] == "done")
            mark = f'  ({done}/{len(it["tasks"])} tasks)'
        print(f'{it["id"]:<{w}}  {cell} {(it["priority"] or "—"):<8} {it["title"]}{mark}')
```

**Step 4: Run to verify it passes.**

Run: `python -m pytest tests/test_render.py -q`
Expected: PASS (4 passed). Full suite green: `python -m pytest -q`.

**Step 5: Commit.**

```bash
git add todo/render.py tests/test_render.py
git commit -m "feat: render tasks + calc-status in get/list"
```

---

## Task 8: docs — packaged SKILL.md + README

**Files:**
- Modify: `todo/skill/SKILL.md`
- Modify: `README.md`

No test; this is documentation. Keep it tight and match the existing voice.

**Step 1: Update `todo/skill/SKILL.md`.**

Add a `## Child tasks` section after the `## The lifecycle` section:

```markdown
## Child tasks

An item can own a list of **child tasks** — discrete units of the item, each with
its own status from the same seven above. Use tasks (not extra top-level items,
not notes) when you break an item into pieces while working it, so the list stays
uncluttered and the item's fine-grained progress is visible.

- The item's own `status` stays **manual** — you set it as always.
- A derived **`calc-status`** is auto-maintained from the tasks (e.g. all tasks
  `done` → `calc-status: done`; any `in-progress` → `in-progress`). It's
  informational; `done`/`archive`/hiding still key on the manual `status`, so you
  still flip the item to `done` yourself once it's verified.
- Notes still exist alongside tasks — notes are the journal, tasks are tracked
  units.
```

Add the task commands to the `## Commands` block, after the `unnote` line:

```
todo tasks  <query>              # list an item's child tasks with indices
todo task add <query> "<title>"  # add a child task (status: todo)
todo task start  <query> <i>     # task → in-progress (triage/review/block/defer/done/reopen too)
todo task status <query> <i> <S> # set a task's status explicitly
todo task rm <query> <i>         # remove task #i
```

**Step 2: Update `README.md`** — mirror the same command additions in whatever
command-reference section it has (read the file first; match its format). Add a
short note that `calc-status` is derived and that individual-status visualization
lives in the web drawer.

**Step 3: Verify the packaged skill still loads** (sanity — the file is shipped
as package data):

Run: `python -c "import importlib.resources as r; print('SKILL.md' )"` and
`python -m pytest -q` (full suite still green).

**Step 4: Commit.**

```bash
git add todo/skill/SKILL.md README.md
git commit -m "docs: document child tasks + calc-status (skill + README)"
```

---

## Task 9: end-to-end smoke + final verification

**Files:** none (manual verification).

**Step 1: Drive the real CLI against a scratch file.**

```bash
cd ~/git/todo
cp TODO.yaml /tmp/todo-smoke.yaml
todo --file /tmp/todo-smoke.yaml task add sub-tasks "verify e2e"
todo --file /tmp/todo-smoke.yaml task start sub-tasks 0
todo --file /tmp/todo-smoke.yaml tasks sub-tasks
todo --file /tmp/todo-smoke.yaml get sub-tasks
todo --file /tmp/todo-smoke.yaml task done sub-tasks 0
todo --file /tmp/todo-smoke.yaml get sub-tasks   # calc-status should read done
```

Expected: task appears, `calc-status` tracks `todo → in-progress → done`, the
manual `status` of `sub-tasks` is unchanged, and `created`/comments in the file
are preserved. Clean up: `rm /tmp/todo-smoke.yaml`.

**Step 2: Full suite + a diff review.**

Run: `python -m pytest -q` (all green) and `git diff --stat HEAD~9..HEAD` to
review the full change set.

**Step 3: Update the TODO item.**

```bash
todo done sub-tasks
todo note sub-tasks "shipped child tasks + calc-status; CLI tasks/task subcommands; pytest suite; web drawer render is a tracked follow-up"
```

(Only after Step 1–2 pass.)

---

## Out of scope — tracked follow-up (do NOT implement here)

The web TODO drawer (`claude-tmux-manager` → `manager/sources/todos.ts`) shares
this YAML contract and must be updated separately to (a) read/render the `tasks`
array as colored dots and (b) read `calc-status`. Note this in the `sub-tasks`
item so it isn't lost.
