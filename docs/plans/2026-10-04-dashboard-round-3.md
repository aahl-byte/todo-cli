# Dashboard round 3

**Date:** 2026-10-04 · **Builds on:** `2026-10-04-dashboard-redesign.md`

## Goal

You can check each of these:

- A request's history is a list of frozen versions. Anyone can see what
  changed between them, which version was triaged, and when the version being
  worked on was never triaged.
- Developers and QA each get their own queue from filter entries such as
  `assigned-to dana` or `qa-by quinn`, shown merged or in tabs. A seeded
  example with many users and lots of work in every phase shows how it reads.
- Anyone can move an item outside the normal flow, with a recorded reason. A
  project can also change its default flow.
- Every deploy check is visibly attached to its ticket.
- The right panel opens with watchtower's at-a-glance task view, and its labels
  are right-aligned.
- The `+` controls are easy to see.

## 1. Request versions

**Model.** Each version is a `ticket-request` note. Its `meta.version` is 1, 2,
3…, and the highest number is the current version.

**Freezing.** Moving an item into `in-triage` freezes the current version. The
server sets `meta.frozen = true`, `frozen_at` and `frozen_by` as part of that
status change. A frozen version can't be changed or removed: the server refuses
with `request-frozen`.

**Editing.**
- **Not frozen:** the edit changes the current version in place, so a PM can
  keep refining a request still in `requested`.
- **Frozen:** saving opens version n+1 and moves the item back to `requested`,
  as a single group. If the item is already `requested`, the status is left
  alone.
- **Server rule:** a new version created outside `requested` (from the CLI, for
  example) also moves the item back to `requested`. The server does this as a
  side effect and records it in history, so the rule holds on every path.

**Triage record.** When an item leaves `in-triage` going forward (to `todo` or
later), the server marks the current version `meta.triaged = true` with
`triaged_at` and `triaged_by`.

**Discrepancy.** An item past triage whose current version was never triaged
gets a flag. The CLI's free moves can produce this. The flag reads: "v3 not
triaged · last triaged v2", shown in amber beside the request with a link to
the diff.

**Display.**
- The request shows the current version. Beside it, a faint `v3 ·
  versions ▾` opens the version list.
- Each version row shows its number, when it was frozen, and `triaged by dana`
  when triaged. Expanding a row shows a line diff from the previous version:
  added lines green, removed lines struck through and red.
- The edit control reads `✎ edit` while the version isn't frozen, and `✎ new
  version` once it is. The new-version popup says "Saving sends it back to
  requested".
- This replaces the `change request` flow.

**Existing data.** A request note with no `meta.version` reads as v1. It reads
as frozen when its item is past `requested`.

## 2. Work queues

**Filter entries.** The URL carries a list of `role:user` entries, such as
`q=dev:dana,qa:quinn,by:pat`. The roles are `assigned-to` (developer), `qa-by`
and `created-by`. They are built in the Filter popover as rows of
`[role ▾] [user ▾]` with ✕ and `+ add`. Type and "show parked" stay in the same
popover.

**Views.** A toggle switches between `merged` and `tabs`, and both the board
and the QA queue honour it.
- **Merged:** shows items matching any entry.
- **Tabs:** one tab per entry, each labelled with the role and user plus a
  count. The active tab filters the page.

**Shortcuts.** `Mine` adds three entries for the current user, one per role,
in merged view. `Needs my review` stays as it is.

**The QA queue** keeps its two sections, filtered by the active entries.

## 3. Example data

`seed:demo` builds a realistic team, still on fixed passwords
(`<handle>-test`):

- **Users:** 3 PMs, 6 developers and 3 QA.
- **Items:** about 70 across every status, with a realistic spread (more in
  progress and in QA than shipped). Some are bugs, and a few are urgent.
- **Contents:** phased tasks in mixed states, comments with mentions, open and
  answered questions, notes, logs and links. Pre- and post-deploy checks sit on
  `ready-to-deploy` items. Some items have several request versions, one with an
  untriaged change, and some have bounced back from QA.
- **History:** status history written in lifecycle order, with times spread
  over the last 30 days.
- **Determinism:** the seed is fixed, so screenshots are reproducible.

## 4. Overriding the status flow

**Per item.**
- **Opening it:** the status menu ends with `other…`. It opens a popup listing
  every status and asks for a required reason.
- **Applying it:** the move skips the transition table. It still respects the
  deploy gate, unless it is also forced.
- **Recording it:** history marks the move `override`, and its tooltip shows the
  reason. The reason is also posted as a comment: "status override: <reason>".
- **Server:** the override travels as `override: true` plus the reason. The
  dashboard action skips the `moves()` check, and the server records the flag on
  the history row in a new `override` column.

**Per project.**
- **Config:** `projects.transitions` is a jsonb map that overrides rows of the
  default table, for example `{"review": ["ready-for-qa", "done", "in-progress"]}`.
  `moves()` takes it as context.
- **Setting it:** `npm run project:flow -- <key> <json|reset>`. A project whose
  flow differs from the default shows a small `custom flow` marker in the
  Filter popover. There's no settings UI this round.

## 5. Deploy board

- **By ticket (the default):** one block per `ready-to-deploy` ticket. The block
  header holds the status light, the title as a link, the assignees and `Mark
  deployed`. Its checks follow, `pre` first then `post`, each with its kind tag
  and payload.
- **By kind:** keeps the operational order (prereq-branch, db-script, env-var,
  …). Each check row starts with a bordered chip holding the ticket's title, so
  the owner is unmistakable.
- **Toggle:** `by ticket | by kind`.
- **Deployed · still to do:** grouped by ticket too.

## 6. Right panel

- **At a glance:** a block opens the panel, copying watchtower's collapsed-row
  viz:
  - the calc-status label as a light plus an uppercase label
  - a centred row of phase capsules, 18×4.5px, coloured by each phase's
    roll-up
  - a centred row of 6px task dots

  Live statuses glow with `box-shadow: 0 0 7px`. A click opens the Tasks tab.
  The block is hidden when the item has no tasks.
- **Board cards:** use the same glow.
- **Labels:** right-aligned, in a fixed 64px column.

## 7. `+` controls

- **Size:** the `+` glyph in every add control, and on the rail's Links and
  Checks, renders at 3× its current size. It's still one glyph, keeps a 28px
  touch target, and the label text keeps its size.

## Acceptance

- **(js) Request versions:**
  - entering triage freezes the current version
  - an edit to a frozen version is refused
  - a new version from outside `requested` moves the item back to `requested`,
    with history
  - leaving triage forward marks the version triaged
  - the discrepancy is detected
- **(js) Overrides:**
  - an override move skips the table and records the flag and reason
  - the project flow changes `moves()`
- **(js) Seed:** `seed:demo` runs on a fresh database and produces at least 60
  items across every status, with 12 users.
- **(smoke) Versions:** editing a frozen request opens v2 and sends the item to
  `requested`, and the versions list shows the diff.
- **(smoke) Queues:** filter entries in merged and tabbed views on the board
  and the QA queue.
- **(smoke) The rest:**
  - the override popup needs a reason, and history marks the move
  - the deploy board's by-ticket and by-kind views
  - the glance block opens Tasks
  - nothing scrolls sideways at 400px

## Revisions after the plan audit

These override the sections above where they differ.

### Request versions

- **Freezing on any exit.** The current version freezes on any status change
  out of `requested`, by any path, not only on entry into triage.
  - A version created on an item outside `requested` is frozen at once, and the
    item moves back to `requested`.
  - In-place editing happens only while the item is `requested` and the version
    has never been frozen.
  - This supersedes the redesign's "editable in `in-triage`" rule:
    `REQUEST_EDITABLE`, the three-step `changeRequest` flow and the
    `request-locked` reason are removed. Their replacement is
    `request-frozen`.
- **Triage record.** The version counts as triaged on the item's first move to
  `todo` or later, but only if it was frozen by entering `in-triage`
  (`meta.frozen_via = "triage"`). That covers `in-triage → blocked → todo`.
  A version frozen any other way, such as a CLI skip, stays untriaged and is
  flagged.
- **Server-owned fields.** The server owns `meta.version`, `frozen*` and
  `triaged*`. A push can't set or clear them: `set` refuses them as
  not-settable, and `create` strips them. The server numbers each new version as
  max + 1 under the project lock.
- **Writes and notifications.**
  - Freezing and triage marks write the note row with its own change seq, so
    the CLI pulls them.
  - A new version notifies the item's developer, QA and creator with a
    `request-changed` notice that links to the diff.
  - Board and QA-queue cards show a `v3 untriaged` badge.
  - The history row for the move back reads "requested · request v3".
- **A refused in-place edit.** If someone pulls the item into triage while a PM
  is editing, the save is refused. The editor keeps the draft and offers "save
  as v3".
- **Jira.** A `description` change in Jira creates a new version through the
  bridge, under the same freeze and move-back rules. The bridge is not exempt.
- **Existing data.** A one-off migration in `migrate()` sets `version: 1` on
  request notes that lack one. It also sets `frozen` when the item is past
  `requested`, and `triaged` when the item is past `in-triage`. Each changed
  note gets its own change row. Views take the highest version.
- **CLI.**
  - New command: `todo request <item> "<text>"` posts a new version.
  - `todo get` shows only the current version, marked "v3 (untriaged)" when it
    hasn't been triaged.
  - `request-frozen` joins sync's `FINAL` set. Its log line says to post a new
    version with `todo request`.
  - The skill is updated and its version bumped.
- **Offline ordering.** An offline new version plus a move into triage lands in
  `requested`: the server's move-back wins, and the stale triage move is logged.
  This is accepted and covered by a test.

### Work queues

The seed comes first, and the existing filter stays as it is. The role-entry
filters with merged or tabbed views wait until the user has judged the current
filter against the large example set. §2 is deferred.

### Overrides

- **Per-item only.** The status menu's `other…` lists the statuses the normal
  menu doesn't already offer, and needs a reason. The server checks the reason
  is there.
- **Server rules still hold.** An override skips only `moves()`, so the deploy
  gate and the agent hand-off rule still apply. The usual side effects still run,
  such as claiming QA on a move into `in-qa`.
- **Recording.** The reason posts as a comment in the same group, and history
  gets an `override` flag.
- **Per-project flow:** a question for the user, not built. If wanted, it would
  use named flags like `deploy_step` (`review_step`, `qa_step`) rather than a raw
  map.

### Deploy board and glance

- **Deploy board.** It's grouped by ticket only, with checks in kind order
  inside each block, and keeps the prereq warning. The by-kind view is dropped.
- **Glance.** The roll-up light leaves the Tasks header, since the glance now
  shows it. The glow applies to the glance only, not to board cards.

### Seed

- **History times.** The seed backdates history with SQL, so times spread over
  30 days.
- **Re-running.** It refuses to seed a project that already holds items.
- **A second project.** It adds `ops`, a project with no deploy step.
- **Mix.** Shipped is the largest pile.
