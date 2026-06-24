# Sub-tasks design

**Item:** `sub-tasks` (TODO.yaml) · **Date:** 2026-06-24 · **Status:** approved

## Problem

Agents working a tracked item often break it into pieces and either (a) spawn
sibling top-level items that pollute the list, or (b) abuse the freeform `notes`
list to record sub-tasks. Neither carries an independent, machine-readable status
per piece, so you can't see the *fine-grained* progress of an item as the agent
runs.

## Goal

Let a TODO item own a list of child **tasks**, each with its own status, so the
item's progress is visible at a glance — without polluting the top-level list and
without overloading `notes`. Notes stay as the freeform journal.

## Decisions (settled during brainstorming)

1. **Notes and tasks coexist.** `notes` remains a chronological journal; `tasks`
   is a separate list of discrete, status-bearing units. A note isn't trackable;
   a task isn't a log entry.
2. **Tasks use the full 7-status lifecycle** (`todo`, `in-triage`, `in-progress`,
   `review`, `blocked`, `deferred`, `done`). The everyday path is
   `todo → in-progress → done`; the rest are edge cases but available.
3. **The parent gets an auto-maintained `calc-status` scalar**, recomputed and
   written back on every task mutation. It is *separate from* the manual
   `status` field — which keeps the manual lifecycle untouched and sidesteps any
   "manual vs derived" conflict. (An earlier `flags` idea was dropped once the
   two fields made it unnecessary.)
4. **Individual-status display (e.g. colored dots) is UI scope, not CLI.** The
   CLI just keeps the data honest; the web drawer decides how to visualize the
   spread of task statuses.

## Schema

Items gain an optional `tasks` list and an auto-maintained `calc-status`, beside
the unchanged `status` and `notes`:

```yaml
- id: sub-tasks
  title: SUB-TASKS
  status: in-progress        # MANUAL — agent/human sets it, lifecycle unchanged
  calc-status: in-progress   # DERIVED — auto-recomputed on every task change
  notes: [...]               # freeform journal, unchanged
  tasks:
    - { title: split status.py, status: done }
    - { title: rollup render,   status: in-progress }
    - { title: skill docs,      status: todo }
```

- A task is `{title, status}` — no per-task ids, notes, or timestamps (YAGNI;
  revisit if a need appears). Tasks are leaf nodes: one level deep, no nesting.
- Items with **no** `tasks` behave exactly as today; `calc-status` is omitted
  entirely (not written as null).
- `status` stays manual. `calc-status` is never set directly by a user — only
  derived.

## `calc-status` derivation

Recomputed and written on any task add / status-change / remove:

- `done` — iff there is ≥1 non-deferred task and **all** non-deferred tasks are
  `done`.
- else the **highest present** among, in order:
  `in-progress → blocked → review → in-triage → todo`
  (considering all tasks; `deferred` is excluded from this scan).
- `deferred` — if every task is `deferred`.
- **omitted** — if there are no tasks.

Rationale: the common axis is `todo → in-progress → done`, and active work
dominates, so a single `in-progress` task reads the item as in-progress. The rare
states (`blocked`/`review`/`in-triage`) still surface when nothing is actively
moving.

## CLI surface

```
todo tasks <item>                      # list tasks: [i] <status> title
todo task add <item> "<title>"         # append a task (status: todo)
todo task <verb> <item> <i>            # verb ∈ triage|start|review|block|defer|done|reopen
todo task status <item> <i> <status>   # set any of the 7 explicitly
todo task rm <item> <i>                # remove a task
```

- Child addressed by **0-based index** (matching `notes` / `unnote`); the index
  is what `todo tasks` prints.
- The `task <verb>` shortcuts mirror the top-level verbs, applied to a child.
- Every task mutation recomputes + rewrites the parent's `calc-status`.
- Top-level `status` commands (`start`, `done`, …) are **unchanged** — they set
  the manual `status` whether or not the item has tasks. No rejection logic.
- `get` shows the `tasks` block and `calc-status`; `list` marks items that have
  tasks.

## What stays keyed on manual `status` (not `calc-status`)

`archive`, `list --status`, and done-hiding continue to key on the **manual
`status`**. Checking off every task surfaces `calc-status: done` but does **not**
silently archive/hide the item — the agent/human still flips `status` to `done`
once the work is verified. Keeps the honest-status principle intact;
`calc-status` is informational.

## Out of scope (documented follow-up)

The web TODO drawer shares this YAML contract:
`claude-tmux-manager` → `manager/sources/todos.ts`. It must (a) read/render the
`tasks` array (this is where colored-dot visualization lives) and (b) read
`calc-status`. Not part of this repo's commits; tracked separately.

## Affected modules (this repo)

- `status.py` — task statuses reuse `STATUSES`; add the `calc-status` derivation
  precedence/order as the single source of truth.
- `store.py` — parse `tasks` + `calc-status` in `_to_item`; add `add_task`,
  `set_task_status`, `remove_task`; `derive_calc_status(node)` helper invoked on
  every task mutation to write `calc-status` back.
- `yamlio.py` — a `tasks_node` helper building a `CommentedSeq` of
  `{title, status}` maps (flow style to match the file's compact shape).
- `render.py` — `print_item` shows tasks + `calc-status`; `print_list` marks
  items with tasks. No dot rendering (UI scope).
- `cli.py` — the `task` subcommand group + `tasks` listing.
- `todo/skill/SKILL.md` — document tasks, the lifecycle guidance, and that
  `calc-status` is derived.
- `README.md` — update the command reference.

## Testing

No test suite exists today; add `pytest`.

- YAML round-trip preserves comments and ISO timestamps byte-for-byte after a
  task mutation.
- `calc-status` derivation: all common transitions, plus edge cases
  (all-deferred → `deferred`, roll-to-`done`, no-tasks → omitted).
- Task CRUD: add / status-change / rm; index bounds; ambiguous-item handling
  (reuses `resolve_item`).
- Backward compatibility: files lacking `tasks` / `calc-status` keys keep working
  unchanged.
