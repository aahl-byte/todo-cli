# Global store (symlink) design

**Item:** `global-todo` (TODO.yaml) · **Date:** 2026-06-26 (rev 2026-06-27) ·
**Status:** implemented (`todo/link.py`, resolution in `cli.py`, tests in
`tests/test_link.py`)

## Problem

`TODO.yaml` lives at the repo root and is committed with the code. That
committed-artifact model is the tool's main strength — history, blame,
branch-coupling, PR review — but it doesn't fit every case:

1. **Worktrees fragment visibility.** `git worktree add` gives the worktree its
   own working copy of `TODO.yaml`. `todo` run from the worktree resolves to
   *that* file, not the primary repo's, so edits diverge and you can't see one
   honest list across the primary + its worktrees. This is the sharpest pain.
2. **Repos you can't commit into.** Work / OSS / shared repos where an in-tree
   `TODO.yaml` is unwelcome.
3. **No cross-project overview.** Todos are scattered one-per-repo; there's no
   single pane showing every project's work.
4. **Non-git scratch dirs.** Sometimes you want to track todos in a folder that
   isn't a repo at all.

## Goal

Let a project **opt in** to storing its todos in a global location
(`~/.todo/projects/<key>/TODO.yaml`) while keeping the committed-artifact model
as the **default**. Opting in must:

- unify visibility across a repo's primary checkout and all its worktrees,
- never force a file into version control,
- enable a cross-project overview,
- leave non-opted-in projects behaving exactly as today.

## Decisions (settled with the user)

1. **Opt-in, not global-by-default.** `./TODO.yaml` stays the default and stays a
   committed artifact. Flipping the default would contradict the whole
   "precious, version-controlled planning artifact" premise the skill is built
   on. Global is a mode a project *chooses*.
2. **The opt-in mechanism is a symlink** — `todo link` replaces the repo-root
   `./TODO.yaml` with a symlink to `~/.todo/projects/<key>/TODO.yaml`. Chosen
   over a redirect-pointer YAML because the OS follows it for free: the CLI, the
   web drawer, `cat`, and any third-party reader all open `./TODO.yaml` and
   transparently hit the global store — **no per-reader redirect-following code**.
3. **The symlink is gitignored, not committed.** `todo link` adds `TODO.yaml` to
   `.gitignore`, so the global store is private by default and the "can't commit"
   case is handled with no extra flag. (Committing it was rejected: a committed
   symlink/redirect would point teammates at their own empty `~/.todo`.)
4. **No pointer fallback.** We do **not** implement the redirect-pointer
   mechanism as a portability fallback. If `os.symlink` fails (Windows without
   Developer Mode, missing permissions, cross-device, etc.), `todo link`
   **surfaces the actual OS error followed by a guidance message** and aborts —
   leaving `./TODO.yaml` untouched. See *Failure handling*.
5. **Worktree sharing comes from a resolution fallback.** A worktree with no
   local `TODO.yaml` walks to the primary worktree's `TODO.yaml` and `resolve()`
   follows its symlink, so all worktrees of a linked repo resolve to the one
   global store. See *Resolution*.
6. **`ARCHIVE/` follows the resolved store.** `archive_todos` keys off
   `file.parent` (store.py:237), and resolution returns the *real* resolved path
   (global dir), so a linked project archives into
   `~/.todo/projects/<key>/ARCHIVE/` with no change.

## Why a symlink needs almost no new code

The existing resolver already follows symlinks for free:

- `_resolve_file()` ends in `Path(raw).resolve()` (cli.py:351). `resolve()`
  follows symlinks, so a linked `./TODO.yaml` becomes the real global path.
- The atomic write is `tmp = file.with_name(file.name + ".tmp"); os.replace(tmp,
  file)` (yamlio.py:77-79). Because `file` is the *resolved* real path, temp +
  rename lands in the global dir and never clobbers the symlink.
- `ARCHIVE/` keys on `file.parent` (store.py:237) = the resolved global dir.

So single-repo linking works today with **zero changes to resolution**. The only
new resolution code is the worktree fallback (step 3 below).

## Self-documentation lives in the store header

Because reads follow the link, anything at the top of the global `TODO.yaml`
shows up at the repo root (`cat ./TODO.yaml`). `todo link` writes a header
comment + a `meta:` block into the store:

```yaml
# Linked store — todos for <repo> live here so every git worktree shares one
# list and nothing is committed. Managed by `todo`; run `todo unlink` to inline
# back. Do not hand-edit.
meta:
  linked_from: /home/mrleaf/git/todo   # originating repo
  key: todo
  linked_at: 2026-06-27
todos:
  ...
```

- The header comment is the human-readable flag (visible through the symlink).
- `meta:` is the machine flag powering `todo projects` (origin path, key) and
  "is this linked?" checks — no `os.readlink` parsing needed.
- **Schema touch:** the loader / round-trip must preserve an unknown top-level
  `meta:` key (the store centers on `todos:`). In practice ruamel's round-trip
  preserves it for free — `update_todo`/task edits rewrite only the `todos:`
  node and re-dump the whole document — so this needed no loader change, just a
  test (`test_link_then_mutation_preserves_meta`).

## Resolution

`_resolve_file()` (cli.py:345) keeps its trailing `.resolve()` (which already
follows symlinks) and gains only a worktree fallback. Precedence:

1. **Explicit `--file PATH`** — used as-is (directory-slip handling unchanged);
   `resolve()` follows it if it's a symlink.
2. **`./TODO.yaml` exists** — `resolve()` follows the symlink to the global store
   (or uses a real file directly — today's behavior).
3. **No `./TODO.yaml`, but inside a git work tree** — derive the primary worktree
   root as `dirname(git rev-parse --git-common-dir)` and look for its
   `TODO.yaml`. If present, `resolve()` follows it. This is what makes a fresh
   worktree share the primary's linked store without any committed file.
4. **Otherwise** — fall through to `<cwd>/TODO.yaml` so the existing
   "No TODO.yaml found" error fires.

Edge: a **broken symlink** (target deleted) resolves to a non-existent path and
hits the normal "No TODO.yaml found" message. Optionally improve it with an
`is_symlink()` check that reports the dangling target. Minor; not required.

## New commands

```
todo link [--name <key>]     # migrate ./TODO.yaml -> global store, leave symlink
todo unlink                  # inline the global store back to ./TODO.yaml
todo projects                # list all global-stored projects (~/.todo/projects/*)
```

**`todo link`**
1. Resolve the global dir `~/.todo/projects/<key>/` (`<key>` defaults to the repo
   basename; on collision with a *different* existing store, append a short
   path-hash suffix and report the chosen key).
2. If `./TODO.yaml` exists and is a real file, move its content to the target
   (preserving comments/structure via the yamlio round-trip) and inject the
   header comment + `meta:` block. If the target already exists, refuse unless
   the user resolves it.
3. `os.symlink(target, ./TODO.yaml)`. **On `OSError`: print the actual error,
   then a guidance message, and abort without modifying `./TODO.yaml`** (restore
   the moved content if step 2 already moved it). See *Failure handling*.
4. Ensure `TODO.yaml` is in `.gitignore` (append if missing; create the file if
   absent). If `./TODO.yaml` was already tracked, print a one-line hint to
   `git rm --cached TODO.yaml`.
5. Print where the store now lives.

**`todo unlink`** — the inverse: move the global store's content back to a real
`./TODO.yaml` (dropping the `meta:` block / header), remove the symlink, leave
the now-empty global dir (or remove it if empty). Leaves the `.gitignore` line
(harmless) but notes it.

**`todo projects`** — scan `~/.todo/projects/*/TODO.yaml`, print key, item count,
and `meta.linked_from` if recorded. Cheap cross-project overview.

## Failure handling

`os.symlink` can fail on Windows without Developer Mode, on missing permissions,
or across devices. We do **not** fall back to a pointer file. Instead `todo link`:

1. Catches the `OSError`, restores any content it moved in step 2 (so the repo is
   left exactly as found), and
2. Prints the raw error followed by a short guidance message, e.g.:

   ```
   error: could not create symlink ./TODO.yaml -> ~/.todo/projects/todo/TODO.yaml
     OSError: [WinError 1314] A required privilege is not held by the client

   todo link needs symlink support. On Windows, enable Developer Mode (or run as
   admin); otherwise check filesystem permissions. Nothing was changed.
   ```

The exact guidance text can be tuned, but the contract is: **real error first,
then a human hint, then a clean abort.**

## Out of scope

- **Multi-machine sync** of `~/.todo/`. It's a plain dir the user can sync
  however they like.
- **Per-worktree override** (a worktree wanting its *own* list). Default is
  shared; revisit only if a real need appears (YAGNI).

Note: the web TODO drawer needs **no change** — it opens repo-root `TODO.yaml`
and the OS follows the symlink to the linked store for free. (This was the
biggest scope item under the redirect-pointer design and disappears entirely.)

## Test plan (methods, not cases)

- **Resolution**: real file → itself; symlink → resolved target; broken symlink →
  sensible error; `--file` at a symlink → followed.
- **Worktree fallback**: a tmp git repo + `git worktree add`; link the primary;
  assert `todo` from the worktree resolves to the same global store. (Uses real
  `git` — gate/skip if unavailable, like other git-touching tests.)
- **link/unlink round-trip**: content + comments survive `link` then `unlink`
  byte-for-byte (reuse the round-trip harness); the injected `meta:`/header is
  added on link and cleanly removed on unlink.
- **meta preservation**: a store with a top-level `meta:` round-trips without
  loss through ordinary mutations (note/status/task edits).
- **symlink failure**: simulate `os.symlink` raising `OSError`; assert the raw
  error + guidance is printed and `./TODO.yaml` is left untouched.
- **.gitignore handling**: created when absent, appended when present, not
  duplicated when already listed.
- **archive under a link**: `done` items land in
  `~/.todo/projects/<key>/ARCHIVE/TODO/`.

## Open questions — resolved in implementation

1. **`<key>` collision policy** → basename, with a `sha1(repo_path)[:6]` suffix
   only when a *different* repo already owns that key. An explicit `--name` is
   used verbatim but **refuses to hijack** another repo's store (errors out).
   Re-linking the same repo reuses its key (idempotent).
2. **`todo init` / docs** → added a "Global store (opt-in)" section to both
   `SKILL.md` and the README; the lifecycle section is unchanged.
3. **`todo list --global`?** → no. Shipped `todo projects` (key, open-item count,
   originating repo) as the cross-project overview; a `--global` aggregator can
   come later if a real need appears.
