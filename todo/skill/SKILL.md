---
name: todo
description: Use when reading, updating, or tracking work in a project's structured TODO.yaml — pull a specific item, change its status through the lifecycle (todo → in-triage → in-progress → done / deferred), or add/edit notes. Use whenever you start, plan, or finish a tracked task so the file stays the source of truth.
---

# TODO

## Overview

Some projects track work in a structured `TODO.yaml` at the repo root, backed by
a web "TODO drawer" and the **`todo`** CLI (a real command on PATH — source at
`~/git/todo`). The file is a precious, comment-rich planning artifact — **edit it
through the CLI, not by hand**, so comments and structure are preserved and
writes stay atomic.

**Core principle:** keep the item's status honest as you work — flip it the
moment you change what you're doing, and leave a note when you learn something.

## When to use

- The user points you at a TODO item (e.g. "todo > FOO", "work on the BAR item").
- You start planning, start coding, or finish a tracked task → update its status.
- You want to look up what an item actually asks for → `get` it.
- You learn something worth recording → add a note.

## The lifecycle

Move an item along as your relationship to it changes:

| status        | meaning                                   | set it when…                    |
|---------------|-------------------------------------------|---------------------------------|
| `todo`        | not started                               | (default for new items)         |
| `in-triage`   | you're writing a plan / scoping it        | you begin planning              |
| `in-progress` | you're actively building it               | you start writing code          |
| `review`      | awaiting user review (purple)             | you specifically want user eyes |
| `blocked`     | can't proceed (red)                       | something blocks you / you stop |
| `done`        | complete (stamps `completed`)             | it's finished and verified      |
| `deferred`    | parked off the main path                  | you decide not to do it now     |

`review` and `blocked` are special states an item enters on demand — not every
item passes through them. Use `review` when you specifically want the user to
look at something, and `blocked` when you couldn't continue.

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

## Commands

Run `todo` from the project root (the one with `TODO.yaml`); it defaults to
`./TODO.yaml`. `<query>` matches an id or part of a title, **case-insensitively**
— `SKILL-TODO`, `skill-todo`, and `skill` all resolve the same item; an ambiguous
query lists the candidates.

```
todo list [--status S] [--all]   # list (hides done by default)
todo get <query>                 # show one item in full
todo triage <query>              # → in-triage  (planning)
todo start  <query>              # → in-progress (developing)
todo review <query>              # → review     (awaiting user review)
todo block  <query>              # → blocked    (can't proceed)
todo done   <query>              # → done       (stamps completed)
todo defer  <query>              # → deferred
todo reopen <query>              # → todo
todo status <query> <status>     # set any status explicitly
todo note   <query> <text...>    # append a note
todo notes  <query>              # list notes with indices
todo unnote <query> <index>      # remove note #index
todo tasks  <query>              # list an item's child tasks with indices
todo task add <query> "<title>"  # add a child task (status: todo)
todo task start  <query> <i>     # task → in-progress (triage/review/block/defer/done/reopen too)
todo task status <query> <i> <S> # set a task's status explicitly
todo task rm <query> <i>         # remove task #i
todo add    "<title>"            # add a new item
todo archive                     # move done items to ARCHIVE/TODO/
todo init                        # install this skill on a fresh machine
```

`--file <path>` (on either side of the command) overrides the default
`./TODO.yaml`.

## Typical flow

```
todo get skill-todo                       # read what it asks for
todo triage skill-todo                    # I'm writing the plan
todo note skill-todo "plan in docs/plans/2026-06-23-foo.md"
todo start skill-todo                     # I'm building it
# …work…
todo note skill-todo "shipped in <commit>; covered by tests"
todo done skill-todo                      # finished + verified
```

## Notes & gotchas

- The CLI re-reads `TODO.yaml` fresh on every mutation and writes atomically, so
  it's safe to run alongside a live server that's also editing the file (the web
  drawer). Worst case under a true simultaneous write is one clobbered edit, not
  corruption.
- `done` stamps `completed` with the current ISO time; moving off `done` clears
  it. Don't set `done` until the work is actually verified.
- Status values are free-form in the file, but stick to the seven above so the
  web drawer colors and the click-to-cycle ring stay meaningful.
- If `todo` isn't found on PATH, install it: `pip install -e ~/git/todo` (then
  `pyenv rehash` if using pyenv). Source lives at `~/git/todo`. After installing,
  `todo init` drops this skill into `~/.agents/skills/todo/` and symlinks it into
  `~/.claude/skills/todo`.
