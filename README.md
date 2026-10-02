# todo

A CLI tool for managing a project's structured todo store — a **`.TODO/`**
directory — from the command line: pull an item, move it through its lifecycle,
or add notes, while keeping its files' comments and structure intact.

It defaults to `./.TODO` in the current working directory, so it works in any
project. Each item lives in its own directory, and each note, dev-log entry and
task phase in its own file, so a command reads and rewrites only what it
touches, however large the project grows. Every write is atomic (temp file +
rename), and comments are preserved via `ruamel.yaml`'s round-trip API.

A project still on the older single-file `TODO.yaml` is converted on the first
`todo` command — see [Migration](#migration-from-todoyaml).

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

`done` and `cancelled` are the terminal pair: both drop out of `todo list`.
Only `done` stamps `completed`.

Each status files the item into a folder of `.TODO/`: `DEFERRED/` for
`deferred`, `CANCELLED/` for `cancelled`, and `OPEN/` for everything else.
`done` items stay in `OPEN/` until `todo archive` moves them to `ARCHIVED/`.
`todo list` reads only `OPEN/`, so parked and finished work costs nothing;
`--all` and `--status` read every folder.

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
todo add    "<title>" [--request TEXT]   # add an item (--request: file it as requested)
todo comment|ask <query> <text...>        # comment (@mentions) | clarification question
todo answer <query> <id> <text...>        # answer a clarification
todo url    <query> <url> [--type T] [--label L]   # attach a PR/preview/QA-handoff link
todo assign <query> [--dev H] [--qa H]    # people fields ("none" clears)
todo history <query>                      # status transitions
todo check add <query> <kind> "<title>" [--payload P] [--post]   # deployment check
todo check done|reopen|rm <query> <id>    # and `todo checks <query>` to list
todo deploy-plan                          # every check the next deploy needs
todo request|ready-qa|qa|approve|deploy <query>   # team statuses
todo reject <query> <text...>             # QA → in-progress with a required comment
todo list --mine                          # where I'm developer or QA
todo login <url> <token> | whoami | sync | inbox   # team server
todo link --remote <url> [--project KEY]  # sync this store with a team server
todo archive                     # move done items to .TODO/ARCHIVED/
todo link   [--name <key>]       # move todos to the global store (~/.todo), via a symlink
todo unlink                      # move the global store back into ./.TODO
todo projects                    # list all global-stored projects
todo init                        # install the todo skill on this machine
```

`--dir <path>` (on either side of the command) overrides the default `./.TODO`.
It takes the `.TODO` directory itself or a project directory holding one.

### Global store (opt-in)

`./.TODO` committed in-repo is the default. `todo link` instead moves the store
to `~/.todo/projects/<key>/.TODO` and leaves a **symlink** at `./.TODO`
(gitignored). Because reads and writes follow the symlink, the CLI and web
drawer keep working unchanged. It's handy for repos that can't host a committed
store, and it lets **git worktrees share one list** — a worktree without a local
`.TODO` resolves to the primary checkout's linked store. `todo unlink` moves the
store back into a real directory. There is no pointer-file fallback: if the OS
can't create a symlink (e.g. Windows without Developer Mode), `link` reports the
error and changes nothing.

Once you've linked a few repos, **`todo list -g`** (`--all-projects`) gives one
cross-project view: every linked project's active items (`in-progress`,
`blocked`, `review`), grouped by project. It only sees linked projects — an
in-repo `.TODO` that was never `todo link`ed won't appear. `--status S`
narrows to one status across all projects; `--all` widens to every item
(including `done`).

## Team workflow

A store synced with a team server (see [Syncing](#syncing-with-a-team-server))
follows the full ticket lifecycle:

```
requested → in-triage → todo → in-progress ⇄ review → ready-for-qa → in-qa
          → ready-to-deploy → deployed
```

QA sends work back with `todo reject <q> "<what failed>"`, which needs the
comment. An agent parks finished work in `review`; only a person moves it to
`ready-for-qa`. `--agent`/`--human` override the detection (`$CLAUDECODE`,
`$TODO_VIA`).

```bash
todo add "Safari login fails" --request "PM's original description"   # → requested
todo assign safari --dev dana --qa quinn
todo ask safari "Does this affect Safari 17?"     # open until answered
todo answer safari 2 "Only 16"
todo url safari https://github.com/x/y/pull/9 --type pr
todo check add safari db-script "add sessions index" --payload db/0042.sql
todo check add safari env-var "SESSION_TTL" --post
todo ready-qa safari && todo qa safari && todo approve safari
todo deploy-plan                                  # what the next deploy needs
todo deploy safari                                # refused while pre-deploy checks are pending
```

Notes carry a kind: `context` (default), `ticket-request`, `comment` (with
`@mentions`), `qa-rejection`, `link`, `clarification`. Every note, log entry
and status change records who made it and whether a person or an agent did.

## Syncing with a team server

The server in [`server/`](server/README.md) is the source of truth, and each
developer's `.TODO/` is a cache. It works offline.

```bash
todo login https://todo.example.com <token>       # from `npm run user:add`
todo link --remote https://todo.example.com --project web
```

After that, every command syncs before it runs and pushes after. A round
compares the files with the last-synced snapshot, so edits from the web drawer
or by hand sync too. A write that lost to a newer change from someone else is
rejected; the CLI takes the server's value and records it in the dev log
(`sync: offline status → review not applied; quinn set in-qa at 14:02`).

- `todo sync` runs a round now and lists anything still unpushed.
- `todo inbox` shows your mentions, rejections, questions and hand-offs.
- `TODO_OFFLINE=1` skips syncing for a command.

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

## .TODO layout

```
.TODO/
  OPEN/                       # every status not filed below (done/deployed until archived)
    skill-todo/               # one directory per item, named by its id
      TODO.yaml               # the item's own fields
      phase-1/TASKS.yaml      # child tasks per phase, in order
      unphased/TASKS.yaml
      notes/2026-06-23T18-02-11.114Z-1.md      # one note per file: {timestamp}-{id}.md
      devlogs/2026-06-23T18-05-40.902Z-1.md    # one dev-log entry per file
      history/2026-06-23T18-06-00.000Z-1.yaml  # one status transition per file
      checks/CHECKS.yaml                       # deployment checks
  .sync/                      # only in a synced store: config, snapshot, outbox
  DEFERRED/
  CANCELLED/
  ARCHIVED/                   # done/deployed items, after `todo archive`
```

An item's `TODO.yaml`:

```yaml
id: skill-todo            # stable short slug (kebab-case); matches the directory
title: a one-line summary
type: feature             # bug | feature | refactor | question
status: in-progress       # see lifecycle above; decides the folder
priority: medium          # high | medium | low
super-phase: null         # optional cross-item grouping (passive)
created: 2026-06-23T17:41:40.683Z
completed: null           # ISO timestamp once done, else null
calc-status: in-progress  # DERIVED from tasks; omitted when there are none
uid: 01K...               # stable identity for sync
creator: pat              # people fields
developer: dana
qa_assignee: quinn
```

A `TASKS.yaml` holds one flow map per task; the phase comes from the directory:

```yaml
tasks:
  - {id: 1, uid: 01K..., title: split status.py, status: done}
  - {id: 2, uid: 01K..., title: rollup render, status: in-progress}
```

Notes and dev-log entries are Markdown files with YAML front matter
(`uid`, `kind`, `author`, `via`, plus kind-specific keys such as `url` or
`state`). A file without front matter is a plain context note. The filename
carries the timestamp (`:` written as `-`) and the constant per-item id.

Other keys in an item's `TODO.yaml` (`description`, `acceptance`, `depends_on`,
…) are preserved untouched on round-trip — the CLI only manages the fields
above.

### Migration from TODO.yaml

The first `todo` command in a project with a `TODO.yaml` and no `.TODO/`
converts it:

- Each item goes to the folder its status selects. Items from `ARCHIVE/TODO/`
  go to `ARCHIVED/` or `CANCELLED/`; a colliding id gets a `-2` suffix.
- Legacy notes have no timestamp, so their filenames take the item's `created`.
- The old files are deleted if git tracks them, otherwise kept in
  `.TODO/.migrated/`.
- A gitignored `TODO.yaml` gets `.TODO` gitignored too.
- A linked `./TODO.yaml` symlink becomes a `./.TODO` symlink into the converted
  global store.

## Gotchas

- The CLI re-reads each file fresh on every mutation and writes atomically, so
  it's safe to run alongside another writer (e.g. a web UI editing the same
  store). Worst case under a true simultaneous write is one clobbered edit, not
  corruption.
- `done` stamps `completed` with the current ISO time; moving off `done` clears
  it. Don't mark `done` until the work is actually verified. `cancelled` stamps
  nothing — nothing was completed.
