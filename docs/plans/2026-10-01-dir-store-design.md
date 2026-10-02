# Directory store (`.TODO/`) design

**Date:** 2026-10-01 · **Status:** implemented (`todo/store.py`, `todo/migrate.py`)

## Problem

One `TODO.yaml` holds every item, note, log entry and task, so every reader parses
the whole file and every writer rewrites it. Large projects make the CLI and the
web drawer lag.

## Layout

```
.TODO/
  OPEN/{item-id}/          # every status not listed below, plus done/deployed
  DEFERRED/{item-id}/      # deferred
  CANCELLED/{item-id}/     # cancelled
  ARCHIVED/{item-id}/      # done/deployed, after `todo archive`
```

Each item directory:

```
{item-id}/
  TODO.yaml                # the item's own fields (below)
  phase-1/TASKS.yaml       # tasks in phase 1, in display order
  phase-2/TASKS.yaml
  unphased/TASKS.yaml      # tasks with no phase
  notes/{ts}-{id}.md       # one note per file: front matter + Markdown
  devlogs/{ts}-{id}.md     # one dev-log entry per file: front matter + text
  history/{ts}-{id}.yaml   # one status transition per file
  checks/CHECKS.yaml       # deployment checks, in order
```

- **Item `TODO.yaml`** is a flat map: `id`, `title`, `type`, `status`,
  `priority`, `super-phase`, `created`, `completed`, and `calc-status` (present
  only when the item has tasks). Unknown keys (`description`, `acceptance`, …)
  are preserved.
- **`TASKS.yaml`** is `tasks:` followed by flow maps `{id, title, status}`. The
  phase comes from the directory name, never from the task. A phase directory
  exists only while it holds tasks.
- **Note and log filenames** are `{ts}-{id}.md`. `ts` is the ISO timestamp with
  `:` replaced by `-` (`2026-10-01T14-03-22.118Z`); replacing the two dashes
  after the hour restores it. `id` is the trailing integer — a constant per-item
  serial, separate for notes and logs. The file body is the text, with one
  trailing newline added on write and stripped on read.
- **Ids**: task ids are unique across all of an item's phase files; a new
  task/note/log takes max existing + 1.

## Status and folder

`status:` in the item's `TODO.yaml` is the source of truth; the folder follows
it. A status change writes `TODO.yaml`, then renames the item directory into
its folder. A complete item (`done` or `deployed`) lives in `OPEN/` until
`todo archive` moves it to `ARCHIVED/`, and stays there once archived. Unknown statuses
go to `OPEN/`. A reader that finds an item in the wrong folder moves it.

## Writes

Every file write is atomic (temp sibling + rename). A task mutation rewrites only
the phase files whose content changed; files that gained a task are written
before files that lost one, so a crash duplicates a task rather than losing it.

## Ordering

`todo list` sorts items by `created`, then id.

## Global store

A linked project's store lives at `~/.todo/projects/<key>/`:

```
~/.todo/projects/<key>/
  meta.yaml                # linked_from, key, linked_at
  .TODO/                   # the store; ./.TODO in the repo symlinks here
```

`todo link` moves `./.TODO` there, leaves a `./.TODO` symlink, and gitignores
`.TODO`. A git worktree with no `./.TODO` uses the primary worktree's.

## Migration

Any command that finds a legacy `TODO.yaml` and no `.TODO/` converts it first:

- Items go to the folder their status selects; items in `ARCHIVE/TODO/*.yaml`
  go to `ARCHIVED/` (done) or `CANCELLED/`. A colliding id gets a `-2` suffix.
- Legacy notes have no timestamp, so they take the item's `created`.
- The new tree is built in `.TODO.migrating/` and renamed into place.
- The old `TODO.yaml` and `ARCHIVE/TODO/` files are deleted when git tracks them,
  otherwise moved to `.TODO/.migrated/` (or, for a linked store,
  `~/.todo/projects/<key>/.migrated/`).
- A linked `./TODO.yaml` symlink becomes a `./.TODO` symlink into the store.
