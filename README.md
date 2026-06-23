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
pip install -e ~/git/todo   # editable install; `pyenv rehash` if using pyenv
```

This puts a `todo` command on your PATH.

## Lifecycle

Move an item along as your relationship to it changes:

| status        | meaning                              | set it with        |
|---------------|--------------------------------------|--------------------|
| `todo`        | not started (default for new items)  | `todo reopen <q>`  |
| `in-triage`   | you're writing a plan / scoping it   | `todo triage <q>`  |
| `in-progress` | you're actively building it          | `todo start <q>`   |
| `done`        | complete (stamps `completed`)        | `todo done <q>`    |
| `deferred`    | parked off the main path             | `todo defer <q>`   |

## Usage

`<query>` matches an id or part of a title, **case-insensitively** (exact id →
exact title → substring); an ambiguous query lists the candidates.

```bash
todo list [--status S] [--all]   # list items (hides done by default)
todo get <query>                 # show one item in full
todo triage <query>              # → in-triage  (planning)
todo start  <query>              # → in-progress (developing)
todo done   <query>              # → done       (stamps completed)
todo defer  <query>              # → deferred
todo reopen <query>              # → todo
todo status <query> <status>     # set any status explicitly
todo note   <query> <text...>    # append a note
todo notes  <query>              # list notes with indices
todo unnote <query> <index>      # remove note #index
todo add    "<title>"            # add a new item
todo archive                     # move done items to ARCHIVE/TODO/
```

`--file <path>` (on either side of the command) overrides the default
`./TODO.yaml`.

### Typical flow

```bash
todo get skill-todo                       # read what it asks for
todo triage skill-todo                    # I'm writing the plan
todo note skill-todo "plan in docs/plans/2026-06-23-foo.md"
todo start skill-todo                     # I'm building it
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
    phase: null               # optional grouping
    created: 2026-06-23T17:41:40.683Z
    completed: null           # ISO timestamp once done, else null
    notes:                    # running notes; multi-line notes become `|` blocks
      - first finding
      - |-
        a longer
        multi-line note
```

Other keys (`description`, `acceptance`, `subtasks`, `depends_on`, …) are
preserved untouched on round-trip — the CLI only manages the fields above.

## Notes

- The CLI re-reads `TODO.yaml` fresh on every mutation and writes atomically, so
  it's safe to run alongside another writer (e.g. a web UI editing the same
  file). Worst case under a true simultaneous write is one clobbered edit, not
  corruption.
- `done` stamps `completed` with the current ISO time; moving off `done` clears
  it. Don't mark `done` until the work is actually verified.
