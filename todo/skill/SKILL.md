---
name: todo
version: 0.2.0
description: Use when reading, updating, or tracking work in a project's structured TODO.yaml — pull a specific item, change its status through the lifecycle (todo → in-triage → in-progress → done / deferred), or add/edit notes. Use whenever you start, plan, or finish a tracked task so the file stays the source of truth.
---

# TODO

## Overview

Some projects track work in a structured `TODO.yaml` at the repo root, managed by
the **`todo`** CLI (a real command on PATH). The file is a precious, comment-rich
planning artifact — **edit it through the CLI, not by hand**, so comments and
structure are preserved and writes stay atomic.

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
| `review`      | finished, awaiting user sign-off          | **your default when work lands** |
| `blocked`     | can't proceed                             | something blocks you / you stop |
| `done`        | complete + accepted (stamps `completed`)  | review is redundant (see below) |
| `deferred`    | parked off the main path                  | you decide not to do it now     |

**When you finish an item, prefer `review` over `done`.** `done` asserts the
work is verified *and accepted* — that's the user's call, so park finished work
in `review` and let them sign off. Go straight to `done` only when review would
be redundant:

- **The user already saw and approved it** — reviewed the diff, approved the PR,
  or said "mark it done" this session.
- **The user explicitly asked for `done`** — honor the instruction over the default.
- **Trivial / mechanical / self-verifying** — version bump, typo or formatting
  fix, a doc tweak made verbatim to spec; nothing for a human to judge.
- **Non-deliverable bookkeeping** — the item *is* housekeeping (archiving,
  reorganizing the list) with no artifact for anyone to look at.

`blocked` is a special state an item enters on demand — use it when you couldn't
continue.

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
- **Tasks vs. notes — keep them separate.** A unit of work goes in the **task
  section**, never in a note. Notes are for **context** — the why, the decision,
  the gotcha, a pointer to the design doc — not a to-do list or a log of what you
  did. If you catch yourself writing "did X, did Y" in a note, those are tasks;
  add them as child tasks (mark them `done`) and keep the note for the reasoning.
- **Write notes in legible Markdown — never a wall of text.** Notes render as
  Markdown, so a note longer than one line should be *structured*, not a single
  run-on paragraph. Lead with a **bold takeaway**, break reasoning into bullets,
  put `` `inline code` `` around identifiers/paths/commands, link with
  `[text](url)`, and separate distinct thoughts with a blank line. Multi-line
  notes are stored as a YAML `|` block literal, so this structure survives
  round-trips verbatim. For example, prefer:

  ```markdown
  **Auth must stay backward-compatible** — old tokens lack the `scope` claim.

  - `verify_token()` falls back to `scope: "*"` when the claim is missing.
  - Drop the fallback only once [PR #412](https://example/412) ships.
  ```

  over cramming all of that into one undifferentiated sentence.
- Tasks can carry a **`phase`** number (`--phase N` on add, or `task phase`).
  Tasks auto-sort by phase (phase 1, 2, … then unphased), so you can stage an
  item's work — phase 1 first, then phase 2 — and read it back in order.
- **Reference tasks and notes by their `[id]`, not their position.** Each task
  and note carries a **constant per-item id** (a serial that's unique within the
  item — two different items can both have a task `[2]`). The id shown in
  `todo tasks` / `todo notes` is what every `task …`/`unnote` command takes, and
  it **never changes** as siblings are removed or the phase re-sort reorders the
  list — so `todo task done FOO 2` always hits the same task. `task add` /
  `note` echo the new id.
- **Treat unphased tasks as triage — always phase them.** An unphased task is
  unsorted inbox work: captured but not yet thought through. Whenever you touch
  an item, sweep its unphased tasks into phases so the list always reads as an
  ordered plan, not a pile. Phasing is itself the act of organizing — it forces
  you to decide *what depends on what* and *what comes first*. As part of that
  sweep, also **clean** the tasks: merge duplicates, split a task that's secretly
  two, drop ones that are obsolete, and sharpen vague titles. The goal is that
  `todo tasks <query>` never shows a trailing clump of unphased items — if it
  does, that clump is your next bit of triage work.

## Commands

Run `todo` from the project root (the one with `TODO.yaml`); it defaults to
`./TODO.yaml`. `<query>` matches an id or part of a title, **case-insensitively**
— `SKILL-TODO`, `skill-todo`, and `skill` all resolve the same item; an ambiguous
query lists the candidates.

```
todo list [--status S] [--all]   # list (hides done by default; --all includes done)
todo list -g                     # active items across all linked projects (grouped)
todo get <query>                 # show one item in full
todo triage <query>              # → in-triage  (planning)
todo start  <query>              # → in-progress (developing)
todo review <query>              # → review     (awaiting user review)
todo block  <query>              # → blocked    (can't proceed)
todo done   <query>              # → done       (stamps completed)
todo defer  <query>              # → deferred
todo reopen <query>              # → todo
todo status <query> <status>     # set any status explicitly
todo note   <query> <text...>    # append a note (write it as legible Markdown)
todo notes  <query>              # list notes with their [id]s
todo unnote <query> <id>         # remove note by id
todo tasks  <query>              # list an item's child tasks with their [id]s
todo task add <query> "<title>" [--phase N]   # add a child task (status: todo)
todo task start  <query> <id>    # task → in-progress (triage/review/block/defer/done/reopen too)
todo task status <query> <id> <S> # set a task's status explicitly
todo task phase  <query> <id> <N> # set/clear a task's phase (N, or "none")
todo task rm <query> <id>        # remove task by id
todo add    "<title>"            # add a new item
todo archive                     # move done items to ARCHIVE/TODO/
todo link   [--name <key>]       # move todos to the global store (~/.todo), via a symlink
todo unlink                      # inline the global store back into ./TODO.yaml
todo projects                    # list all global-stored projects
todo init                        # install this skill on a fresh machine
```

### Global store (opt-in)

By default `./TODO.yaml` is a committed, in-repo artifact — that's the norm and
usually what you want. `todo link` instead moves an item's todos to
`~/.todo/projects/<key>/TODO.yaml` and replaces `./TODO.yaml` with a **symlink**
to it (and gitignores it). Reads and writes follow the link transparently, so the
CLI works unchanged. Use it when a repo can't host a committed
`TODO.yaml`, or when **git worktrees** should share one list instead of each
checkout carrying its own — a worktree with no local `TODO.yaml` resolves to the
primary checkout's linked store automatically. `todo unlink` reverses it (inlines
the content back into a real file). If `os.symlink` isn't supported (e.g. Windows
without Developer Mode), `link` prints the OS error and aborts without changing
anything.

`todo list -g` (`--all-projects`) gives a cross-project view: every linked
project's **active** items (`in-progress`, `blocked`, `review`), grouped by
project. It only sees linked projects — an unlinked in-repo `TODO.yaml` won't
appear. `--status S` narrows to one status across all projects; `--all` widens
to every item including `done`.

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
todo review skill-todo                     # finished — hand it to the user to sign off
# …user approves…
todo done skill-todo                       # accepted (or skip review per the rules above)
```

## Notes & gotchas

- The CLI re-reads `TODO.yaml` fresh on every mutation and writes atomically, so
  it's safe to run alongside another writer editing the same file (e.g. a web UI).
  Worst case under a true simultaneous write is one clobbered edit, not
  corruption.
- `todo list` shows every item **except** `done` (so finished work drops out of
  the everyday view); `todo list --all` adds the `done` items back in for the
  full picture. `--status S` narrows to a single status. (The *active-only*
  filter — `in-progress`/`blocked`/`review` — applies only to the cross-project
  `-g` view, not to plain local `list`.)
- `done` stamps `completed` with the current ISO time; moving off `done` clears
  it. Don't set `done` until the work is verified *and accepted* — by default
  finished work goes to `review` first and the user moves it to `done` (see the
  lifecycle section for the cases where going straight to `done` is fine).
- Notes accept **multi-line Markdown** — pass a note containing newlines (lists,
  `inline code`, fenced blocks, links) and the CLI stores it as a YAML `|` block
  literal, kept readable and byte-stable on round-trip. Single-line notes stay
  plain scalars. Reach for the multi-line form whenever a note carries more than
  one idea — a structured note is worth re-reading; a wall of text isn't.
- Status values are free-form in the file, but stick to the seven above so any UI
  that colors or cycles them stays meaningful.
- If `todo` isn't found on PATH, install the package from its source checkout:
  `pip install -e <path-to-checkout>` (run `pyenv rehash` afterward if you use
  pyenv). Then `todo init` drops this skill into `~/.agents/skills/todo/` and
  symlinks it into `~/.claude/skills/todo`.
