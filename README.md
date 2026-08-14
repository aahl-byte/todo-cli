# todo

A CLI tool for managing a project's structured **`TODO.yaml`** from the command
line — pull an item, move it through its lifecycle, or add notes — while keeping
the file's comments and structure intact.

It defaults to `./TODO.yaml` in the current working directory, so it works in any
project. Every mutation re-reads the file fresh and writes atomically (temp file
+ rename), so a crash mid-write can never truncate `TODO.yaml`, and comments are
preserved via `ruamel.yaml`'s round-trip API.

## Installation

Requires Python 3.9+.

```bash
pip install git+https://github.com/aahl-byte/todo-cli.git
```

Or for local development, an editable install from a clone:

```bash
pip install -e ~/git/todo   # `pyenv rehash` if using pyenv
```

Either way puts a `todo` command on your PATH. Then install the companion agent
skill:

```bash
todo init   # copies the skill to ~/.agents/skills/todo and symlinks ~/.claude/skills/todo
```

`todo init` is idempotent and won't clobber an existing real file/dir at the
symlink path without `--force`.

## Lifecycle

Move an item along as your relationship to it changes:

| status        | meaning                              | set it with        |
|---------------|--------------------------------------|--------------------|
| `todo`        | not started (default for new items)  | `todo reopen <q>`  |
| `in-triage`   | you're writing a plan / scoping it   | `todo triage <q>`  |
| `in-progress` | you're actively building it          | `todo start <q>`   |
| `review`      | awaiting user review (purple)        | `todo review <q>`  |
| `blocked`     | can't proceed (red)                  | `todo block <q>`   |
| `done`        | complete (stamps `completed`)        | `todo done <q>`    |
| `deferred`    | parked off the main path             | `todo defer <q>`   |
| `cancelled`   | never going to happen (dim red)      | `todo cancel <q>`  |

`review` and `blocked` are special states an item enters on demand — not every
item passes through them. In a TTY the list/get views colorize each status
(purple for `review`, red for `blocked`).

`done` and `cancelled` are the terminal pair: both drop out of `todo list` and
both get swept up by `todo archive`. Only `done` stamps `completed`.

## Child tasks

An item can own a list of **child tasks**, each with its own status from the same
eight above — for breaking an item into trackable pieces without spawning extra
top-level items or overloading notes:

```bash
todo task add sub-tasks "split status.py"   # echoes the new task's id, e.g. [1]
todo task start sub-tasks 1      # move task 1 → in-progress
todo tasks sub-tasks             # list tasks with their [id]s
```

Each task and note carries a **constant per-item id** (a serial that's unique
within the item — two items can both have a task `[2]`). References are by id,
not list position, so an id never shifts when a sibling is removed or the phase
re-sort reorders the list.

The item's own `status` stays manual. A derived **`calc-status`** field is
auto-maintained from the tasks (all `done` → `done`; any `in-progress` →
`in-progress`; etc.) and is purely informational — `archive`, `--status`
filtering, and done-hiding still key on the manual `status`. How the individual
task statuses are visualized (e.g. colored dots) is left to the web TODO drawer.

Tasks can also carry an optional **`phase`** number (`--phase N` on add, or
`todo task phase <item> <id> <N>`). Tasks auto-sort by phase — phase 1, 2, … then
unphased — so you can stage an item's work and read it back in order; a task's
`[id]` stays constant no matter where the sort places it. Re-phasing a task drops
it to the bottom of its new phase. (The item-level `super-phase` field is a
separate, passive cross-item grouping; phasing the *work* lives in child tasks.)

Within a phase, order is yours to set with `todo task move`:

```bash
todo task move sub-tasks 3 --top       # first among its phase-mates
todo task move sub-tasks 3 --bottom    # last among them
todo task move sub-tasks 3 --after 7   # next to task 7 — adopting task 7's phase
```

`--before`/`--after` re-phase the moved task to match its new neighbour, since
the phase sort would otherwise put it straight back.

## Notes vs. dev log

Two separate sequences hang off an item, each with its own id space:

- **`notes`** hold context — the why, the decision, the gotcha, a pointer to the
  design doc. Written as Markdown, and worth re-reading later.
- **`log`** holds the dated development trail — what you tried, what broke, what
  you swapped for what. It keeps the running commentary from crowding out the
  notes.

```bash
todo log  sub-tasks "swapped the regex for a real parser"
todo logs sub-tasks -n 5     # last 5 entries, oldest first
todo unlog sub-tasks 3
```

`todo get` prints every note but only the last 3 log entries, with a `… N
earlier` marker; `todo get <q> --log` shows the whole trail.

## Usage

`<query>` matches an id or part of a title, **case-insensitively** (exact id →
exact title → substring); an ambiguous query lists the candidates.

```bash
todo list [--status S] [--all]   # list items (hides done/cancelled by default)
todo list -g                     # active items across every linked project (grouped)
todo get <query> [--log]         # show one item in full (--log: whole dev log)
todo triage <query>              # → in-triage  (planning)
todo start  <query>              # → in-progress (developing)
todo review <query>              # → review     (awaiting user review)
todo block  <query>              # → blocked    (can't proceed)
todo done   <query>              # → done       (stamps completed)
todo defer  <query>              # → deferred
todo cancel <query>              # → cancelled  (terminal, like done)
todo reopen <query>              # → todo
todo status <query> <status>     # set any status explicitly
todo note   <query> <text...>    # append a note
todo notes  <query>              # list notes with their [id]s
todo unnote <query> <id>         # remove note by id
todo log    <query> <text...>    # append a dated dev-log entry
todo logs   <query> [-n N]       # show the dev log, oldest first
todo unlog  <query> <id>         # remove a log entry by id
todo tasks  <query>              # list an item's child tasks with their [id]s
todo task add <query> "<title>" [--phase N]   # add a child task (status: todo)
todo task start  <query> <id>    # task → in-progress (triage/review/block/defer/done/reopen too)
todo task status <query> <id> <S> # set a task's status explicitly
todo task phase  <query> <id> <N> # set/clear a task's phase (N, or "none")
todo task move   <query> <id> [--top|--bottom|--before ID|--after ID]  # reorder within a phase
todo task rm <query> <id>        # remove task by id
todo add    "<title>"            # add a new item
todo archive                     # move done/cancelled items to ARCHIVE/TODO/
todo link   [--name <key>]       # move todos to the global store (~/.todo), via a symlink
todo unlink                      # inline the global store back into ./TODO.yaml
todo projects                    # list all global-stored projects
todo init                        # install the todo skill on this machine
```

`--file <path>` (on either side of the command) overrides the default
`./TODO.yaml`.

### Global store (opt-in)

`./TODO.yaml` committed in-repo is the default. `todo link` instead moves the
todos to `~/.todo/projects/<key>/TODO.yaml` and leaves a **symlink** at
`./TODO.yaml` (gitignored). Because reads and writes follow the symlink, the CLI
and web drawer keep working unchanged. It's handy for repos that can't host a
committed `TODO.yaml`, and it lets **git worktrees share one list** — a worktree
without a local `TODO.yaml` resolves to the primary checkout's linked store.
`todo unlink` inlines the store back into a real file. There is no pointer-file
fallback: if the OS can't create a symlink (e.g. Windows without Developer Mode),
`link` reports the error and changes nothing.

Once you've linked a few repos, **`todo list -g`** (`--all-projects`) gives one
cross-project view: every linked project's active items (`in-progress`,
`blocked`, `review`), grouped by project. It only sees linked projects — an
in-repo `TODO.yaml` that was never `todo link`ed won't appear. `--status S`
narrows to one status across all projects; `--all` widens to every item
(including `done`).

### Typical flow

```bash
todo get skill-todo                       # read what it asks for
todo triage skill-todo                    # I'm writing the plan
todo note skill-todo "plan in docs/plans/2026-06-23-foo.md"
todo start skill-todo                     # I'm building it
todo log skill-todo "ruamel re-folds long scalars; rstrip per line"
# …work…
todo note skill-todo "shipped in <commit>; covered by tests"
todo done skill-todo                      # finished + verified
```

## TODO.yaml shape

Each item is a map under a top-level `todos:` sequence:

```yaml
todos:
  - id: skill-todo            # stable short slug (kebab-case)
    title: a one-line summary
    type: feature             # bug | feature | refactor | question
    status: in-progress       # see lifecycle above
    priority: medium          # high | medium | low
    super-phase: null         # optional cross-item grouping (passive)
    created: 2026-06-23T17:41:40.683Z
    completed: null           # ISO timestamp once done, else null
    notes:                    # context; each has a constant per-item id
      - id: 1
        text: first finding
      - id: 2
        text: |-             # multi-line text stays a `|` block literal
          a longer
          multi-line note
    log:                      # dated dev trail, own id space
      - id: 1
        ts: 2026-06-23T18:02:11.114Z
        text: swapped the regex for a real parser
    calc-status: in-progress  # DERIVED from tasks; omitted when there are none
    tasks:                    # child tasks, each with its own id + status (+ optional phase)
      - {id: 1, title: split status.py, status: done, phase: 1}
      - {id: 2, title: rollup render, status: in-progress, phase: 2}
```

Other keys (`description`, `acceptance`, `subtasks`, `depends_on`, …) are
preserved untouched on round-trip — the CLI only manages the fields above.

## Gotchas

- The CLI re-reads `TODO.yaml` fresh on every mutation and writes atomically, so
  it's safe to run alongside another writer (e.g. a web UI editing the same
  file). Worst case under a true simultaneous write is one clobbered edit, not
  corruption.
- `done` stamps `completed` with the current ISO time; moving off `done` clears
  it. Don't mark `done` until the work is actually verified. `cancelled` stamps
  nothing — nothing was completed.
