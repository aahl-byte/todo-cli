# Team store implementation plan

**Date:** 2026-10-02 · **Spec:** `docs/plans/2026-10-02-team-store-design.md` ·
**UI:** `docs/plans/2026-10-02-dashboard-ui-design.md`

Each phase ends with its acceptance checks passing and an independent audit of
the code against the spec. Phases 1–2 change the Python CLI in `todo/`; phases
2–4 add a Next.js app in `server/`.

## Done when

- `pytest` passes and covers every check marked **(py)**.
- `cd server && npm test` passes and covers every check marked **(js)**.
  - Server tests run on PGlite (Postgres compiled to WASM), so no Postgres
    service is needed.
  - Production uses `pg` with `DATABASE_URL`.
- `cd server && npm run build` (`next build`) succeeds.
- `tests/test_e2e_sync.py` passes. It starts the built Next.js server on PGlite,
  and two CLI stores sync through it **(e2e)**. The scenario:
  1. A item is `review`. QA B sets `in-qa` and comments.
  2. Meanwhile dev A, offline, adds a note and sets `in-progress`.
  3. A reconnects:
     - A's note lands.
     - A's status write is rejected and logged.
     - A ends with `in-qa` and B's comment.
- `README.md`, `todo/skill/SKILL.md` (version bumped) and `server/README.md`
  describe the new commands and deployment.

## Phase 1 — local model (Python)

### 1.1 Statuses and history

- **Adding** `requested`, `ready-for-qa`, `in-qa`, `ready-to-deploy`,
  `deployed`. The ring order is: `requested`, `todo`, `in-triage`,
  `in-progress`, `review`, `ready-for-qa`, `in-qa`, `ready-to-deploy`,
  `deployed`, `blocked`, `deferred`, `cancelled`, `done`.
- **New status groups:**
  - `COMPLETE` = `done`, `deployed`. Both stamp `completed`, sit in `OPEN/`
    until `todo archive`, and stay in `ARCHIVED/` once there. `folder_for`,
    `archive_todos` and `update_todo` all switch to `COMPLETE`, and the
    dir-store design doc's folder rules get updated to match.
  - `TERMINAL` = `COMPLETE` + `cancelled`, hidden from `todo list`.
  - `ACTIVE` (`list -g`) adds `ready-for-qa` and `in-qa`.
- **New shortcuts:**
  - `request` → `requested`
  - `ready-qa` → `ready-for-qa`
  - `qa` → `in-qa`
  - `approve` → `ready-to-deploy`
  - `deploy` → `deployed`, behind the check gate
  - `reject <q> <text…>` → `in-progress`, with a `qa-rejection` note; the text
    is required
  - Task shortcuts leave out `deploy` and `reject`.
- **Agents can't hand to QA.** Moving to `ready-for-qa` while `via` is
  `agent` fails: "an agent parks finished work in review; a person hands it to
  QA". The server enforces the same rule.
- **calc-status:** `deployed` counts as complete. If every live task is
  `deployed`, the result is `deployed`; if they are a mix of `done` and
  `deployed`, it is `done`. Precedence: `in-progress`, `blocked`, `in-qa`,
  `ready-for-qa`, `review`, `ready-to-deploy`, `in-triage`, `requested`, `todo`.
- **History:** a real status change appends `history/{ts}-{n}.yaml` with
  `{uid, from, to, by, via}`, plus `forced: true` for a forced deploy.
  `todo history <q>` lists every entry; `todo get` shows the last 3. In a
  synced store these local entries are provisional — see 2.5.

### 1.2 Identity

`identity.user()` resolves in this order: `$TODO_USER`, then `user:` in
`~/.todo/config.yaml`, then the OS login.

`identity.via()` resolves in this order:

1. `--agent` or `--human` on the command line
2. `$TODO_VIA` (`agent` or `human`)
3. `agent` when `$CLAUDECODE` is set
4. `human` otherwise

### 1.3 Note kinds and authorship

- **Front matter:** a note, log or history file starts with YAML front matter
  between `---` lines, followed by the body.
  - A file counts as having front matter only if the block parses to a map
    containing `uid` or `kind`. Otherwise the whole file is a legacy body, and
    a legacy note reads as `{kind: context}`.
  - Every new note and log entry is written with `uid`, `author` and `via`,
    plus `kind` for notes.
- **Kinds:** `context`, `ticket-request`, `comment`, `qa-rejection`, `link`,
  `clarification`. Kind-specific keys:
  - `comment`, `qa-rejection`: `mentions` (handles parsed from `@handle`)
  - `link`: `url`, `label`, `type` (`pr`, `preview`, `qa-handoff`, `other`)
  - `clarification`: `state` (`open`/`answered`), and once answered
    `answer`, `answered_by`, `answered_at`
- **Commands:**
  - `note <q> [--kind K] <text…>`
  - `comment <q> <text…>`
  - `url <q> <url> [--type T] [--label L]`
  - `ask <q> <text…>`
  - `answer <q> <id> <text…>`
  - `notes <q> [--kind K]`
  - `add "<title>" [--request <text>]` creates the item as `requested` with a
    `ticket-request` note
- **`todo get`** lists open clarifications first, then notes, each tagged
  `(kind · author)` when it isn't a plain context note.
- **Tests that change:** `tests/test_constant_ids.py` and
  `tests/test_log.py` assert raw file bodies, so they get updated to read
  through the store.

### 1.4 People fields

- **Fields:** `creator`, `developer`, `qa_assignee` in `TODO.yaml`. `add`
  sets `creator` from identity.
- **Command:** `assign <q> [--dev H] [--qa H]`; the value `none` clears a field.
- **Display:** `get` prints all three.
- **Filter:** `list --mine` keeps items where I am `developer` or
  `qa_assignee`.

### 1.5 Deployment checks

- **Storage:** `checks/CHECKS.yaml` holds `checks:` as flow maps
  `{id, uid, kind, title, payload, timing, status}`. `title` and `payload`
  use the `_PLAIN_TITLE` quoting rule.
  - Kinds: `db-script`, `env-var`, `prereq-branch`, `feature-flag`,
    `manual-step`, `other`.
  - Timing: `pre-deploy` (default) or `post-deploy`.
  - Status: `pending` or `done`.
- **Commands:**
  - `check add <q> <kind> "<title>" [--payload P] [--post]`
  - `check done <q> <id>`
  - `check reopen <q> <id>`
  - `check rm <q> <id>`
  - `checks <q>`
- **Gate:** moving to `deployed` fails while a `pre-deploy` check is
  `pending`, unless `--force` is passed. This applies through `deploy`,
  `status` and the legacy alias.
- **Deploy plan:** `deploy-plan` takes every `ready-to-deploy` item in `OPEN/`,
  ordered by created then id.
  - It prints `pre-deploy`, then `post-deploy`. Inside each, checks are grouped
    by kind in the order `prereq-branch`, `db-script`, `env-var`,
    `feature-flag`, `manual-step`, `other`.
  - Each line shows status, item, check id, title and payload.
  - A `prereq-branch` check whose payload names an item id that isn't complete
    gets `⚠ not deployed`.
  - A last section lists `deployed` items that still have pending
    post-deploy checks.

### 1.6 ULIDs

- **Generator:** `todo/ulid.py`, no dependency.
- **Written back:** a uid, once assigned, is stored in the entity's file — front
  matter, the flow map, or `TODO.yaml` — and never recomputed.
- **What carries one:** every new item, task, note, log, check and history
  entry gets a `uid`. `TASKS.yaml` flow maps become `{id, uid, title, status}`,
  and `_read_tasks`/`tasks_doc` carry `uid` through every rewrite.
- **Entities without a uid** (older files, drawer or hand edits) get a
  deterministic uid when sync first sees them, which is then written back:
  - items: from project key, item id and `created`
  - children: from item uid, entity, `ts` (or title) and a hash of the text

  Two clones of one committed store therefore agree on uids.

Acceptance **(py)**:

- Every shortcut, including `reject` with and without text.
- An agent can't run `ready-qa`, and `--human` overrides `$CLAUDECODE`.
- `deployed` hides from `list`, archives, and stays archived.
- History is appended once per real change, with `forced` on a forced deploy.
- Front matter round-trips; a legacy body starting with `---` stays a body.
- An answer closes a clarification.
- `assign` and `list --mine`.
- The gate and `--force`.
- `deploy-plan` grouping, order, the prereq warning and the post-deploy section.
- ULIDs are unique and ordered.
- A task uid survives move, phase and status edits.

## Phase 2 — server and sync

### 2.1 App scaffold

- **`server/`** is Next.js 16 (App Router, TypeScript). It deploys to Vercel
  with the root directory set to `server`.
- **DB adapter:** `lib/db.ts` exports `query`, `exec` and `tx`. It uses
  `pg.Pool(DATABASE_URL)` in production, and PGlite when
  `TODO_PGLITE=memory|<dir>` is set.
- **Migrations:** `npm run migrate` applies `db/schema.sql`, which is
  idempotent.

### 2.2 Schema

- **`users`:** `handle`, `name`, `email`, `token_hash`, `jira_account_id`.
- **`projects`:** `key`, `name`, `seq` (bigint counter), `deploy_step` (bool,
  default true), `jira_project`, `jira_status_map` jsonb.
- **`items`:**
  - `uid`, `project`, `id` (unique per project), `title`, `type`, `status`,
    `priority`, `super_phase`
  - `creator`, `developer`, `qa_assignee`, `created`, `completed`,
    `calc_status`
  - `extra` jsonb for the item's unknown keys, synced as fields `extra.<key>`
  - `versions` jsonb, mapping field → seq
- **`tasks`:** `uid`, `item_uid`, `n`, `title`, `status`, `phase`,
  `position`, `versions`.
- **`notes`:** `uid`, `item_uid`, `n`, `kind`, `author`, `via`, `ts`,
  `text`, `meta` jsonb, `source`, `versions`.
- **`logs`:** `uid`, `item_uid`, `n`, `author`, `via`, `ts`, `text`.
- **`checks`:** `uid`, `item_uid`, `n`, `kind`, `title`, `payload`,
  `timing`, `status`, `versions`.
- **`status_history`:** `uid`, `item_uid`, `n`, `from_status`, `to_status`,
  `by`, `via`, `forced`, `ts`.
- **`changes`:** `(project, seq)` pk, `entity` (`item`, `task`, `note`,
  `log`, `check`, `history`), `uid`, `item_uid`, `deleted`, `author`,
  `ts`.
- **`applied_ops`:** `op_id` pk, `result`.
- **`jira_links`:** `item_uid`, `jira_key`.
- **`jira_outbox`:** `id`, `item_uid`, `action`, `payload`, `attempts`,
  `error`, `done_at`.
- **`notifications`:** `id`, `handle`, `kind`, `note_uid`, `item_uid`,
  `created`, `read_at`. These are written in phase 2 and read by the phase 4
  inbox.

### 2.3 Operations and `lib/apply.ts`

**Wire format.** An op is `{op_id, op: create|set|remove, entity, uid,
item_uid, data, base?, via, force?, group?}`, where `entity` is one of
`item|task|note|log|check`. `author` is never read from the op; it always comes
from the bearer token.

**Locking and sequence numbers.** One function applies every write, whether it
comes from the API, a dashboard action, or the Jira bridge.

- Each op runs in a transaction that starts with
  `SELECT … FROM projects WHERE key=$1 FOR UPDATE`.
- Every entity row the op changes takes the next `projects.seq` and its own
  `changes` row. The op's own write and a derived item, history or
  calc-status change therefore each get their own seq.
- That row lock serializes a project's writers. Sequence numbers therefore
  commit in order, and a pull can never skip one.

**Idempotency.** A known `op_id` returns its stored `result`. The check happens
under the project lock, so two concurrent pushes of the same op cannot both
apply it.

**Groups.** Ops sharing a `group` run in one transaction. If any field in the
group is rejected, the whole group rolls back.

**Creates.**

- A known uid with identical data is a no-op that reports `applied`. A known
  uid with different data is `rejected` with reason `uid-exists`.
- `n` is kept if free, otherwise reassigned as max + 1 and reported as
  `assigned_n`.
- A taken item `id` gets `-2`, `-3`, … and is reported as `assigned_id`.

**Field writes.**

- **Accepted when** `base[field]` equals `versions[field]`, the field has
  no version yet, or the value already equals the current one (a no-op).
- **Rejected otherwise**, with `{field, server_value, by, at}`. `by` and
  `at` come from the `changes` row of that version.
- **Partial ops** apply their fresh fields and reject the stale ones.
- **Exempt fields:** `position` and writes made inside the bridge
  (`unconditional`) skip the version check. Reordering a phase is a set of
  `position` writes. `position` is the integer index within the phase, and
  ties break by `n`.
- **Results:** every applied field reports its new version in
  `versions: {field: seq}`.
- **Removes** carry `base` for every field and are rejected if any field is
  newer. A `set` or `remove` on an entity that is already removed is rejected
  with reason `removed` and `by`/`at`.

**Status side effects.**

- **Stamping:** `completed` is stamped or cleared using `COMPLETE`.
- **History:** a `status_history` row is written from the applied change,
  carrying the op's `via` and `forced`.
- **Gate:** `deployed` is rejected while pre-deploy checks are pending,
  unless `force`.
- **Agent rule:** `ready-for-qa` from `via: agent` is rejected.
- **Recomputing:** every task op recomputes `calc_status` (same rules as the
  CLI) and records an item change.

**Notifications.**

- each `@mention` in a `comment`/`qa-rejection` → the mentioned user
- a `qa-rejection` → `developer`
- a new `clarification` → `creator`
- an answered clarification → its author
- → `ready-for-qa` → `qa_assignee`
- → `deployed` → `creator`

Nobody is notified about their own action.

**Jira outbox.** For a linked item, `apply.ts` also queues Jira outbox rows
(phase 3). Ops authored by `jira-bridge` never queue any.

### 2.4 API

- **Auth:** `Authorization: Bearer <token>`, checked by sha256 against
  `users.token_hash`. The dashboard keeps the same token in an httpOnly
  cookie set by `/login`.
- **Endpoints:**
  - `POST /api/projects` with `{key, name}` creates the project if it is
    missing.
  - `POST /api/projects/[key]/ops` takes `{ops}` and returns `{results}`.
  - `GET /api/projects/[key]/changes?since=N&limit=500` returns
    `{changes: [{seq, entity, uid, item_uid, deleted, data}], cursor, more}`.
    `data` is the entity's current row with its `versions`. When a uid changes
    more than once in a page, only its latest change is returned.
  - `GET /api/inbox?since=` and `POST /api/inbox/read` are direct
    `notifications` reads and writes outside the op model, since read marks are
    per-user and not synced.
- **Admin tooling:** `npm run user:add -- <handle> [--name N]` prints a new
  token. `npm run project:add -- <key>` creates a project.

### 2.5 CLI sync (`todo/sync.py`, `todo/remote.py`)

**Config and setup.**

- `~/.todo/config.yaml` holds `user:` and `tokens: {<url>: <token>}`.
- `todo login <url> <token>` asks `GET /api/me` for the handle the token
  belongs to and stores both.
- `todo whoami` prints the identity.
- `todo inbox [--all]` lists my notifications from `GET /api/inbox` and marks
  the shown ones read. CLI-only devs see mentions and rejections there.
- `todo link --remote <url> [--project KEY]`:
  1. links the store into `~/.todo` first if it isn't already linked
  2. writes `.sync/config.json`
  3. creates the server project if it is missing
  4. pulls from 0, adopting the server's state. Every pulled entity goes into
     the snapshot with its data and versions. A local file with the same uid is
     kept as it is, so the next diff pushes its differences on top of the
     server versions. Server entities with no local file are written.
  5. pushes
- `.sync/config.json` also caches the project's `deploy_step`. When it is
  off, `approve` goes to `done`.

**Snapshot.** `.sync/snapshot.json` holds
`{cursor, entities: {uid: {entity, item_uid, data, versions}}}`.

- **Local entities** are read from the files. `data` holds the synced fields:
  - item: `id`, `title`, `type`, `status`, `priority`, `super_phase`, the
    people fields, and `extra.*`
  - task: `n`, `title`, `status`, `phase`, `position`
  - note: `n`, `kind`, `ts`, `text`, `meta`
  - log: `n`, `ts`, `text`
  - check: `n`, `kind`, `title`, `payload`, `timing`, `status`
- **Not pushed:** `calc_status`, `completed`, history and authorship. The
  server derives them, and pull writes them.

**Locking.** In a synced store every command holds an exclusive
`fcntl.flock` on `.sync/lock` for its whole run, rounds included. Synced
commands therefore never interleave. Only the drawer or a hand edit can write
concurrently, which is the existing "one clobbered edit" worst case.

**One round:**

1. **Diff** the local entities against the snapshot, and record the local
   values it read:
   - a new uid → `create`
   - a changed field → `set` with `base` from the snapshot
   - a uid missing locally → `remove` with `base`. Items are never removed,
     and an item directory that couldn't be read completely produces no child
     removes.

   **Order:** item creates, child creates, child sets, item sets, then removes.

   **Status sets** take `via` and `forced` from the newest provisional
   history entry that reached that status.

   **Groups:** a `qa-rejection` note whose front matter records
   `with_status` is sent as a group with that status set.
2. **Push** in batches of 200, then handle the results:
   - **Applied:** the snapshot takes the pushed values with the returned
     versions straight away. Push-only rounds do this too.
   - **Renumbered:** `assigned_n`/`assigned_id` rename the local file, phase
     entry or directory, and the change is printed.
   - **Rejected:** the field becomes a local log entry ("offline status →
     review not applied; QA set in-qa at 14:02"), which syncs next round. The
     field is marked to take the server value on pull.
3. **Pull** from the cursor until `more` is false, writing each entity into
   its file. Item `TODO.yaml` goes through the ruamel round trip, so comments
   and unknown keys survive. Phase files are ordered by `position`.
   - **Skipped fields:** a field whose local value differs from the value the
     diff read was edited after the diff. With the lock held, that only happens
     through the drawer or a hand edit. It keeps both its local value and its
     snapshot entry, so the next push still carries the old base. Rejected
     fields always take the server value.
   - **Removed entities:** a removed entity's local file is deleted.
   - **Provisional history:** server history replaces only the provisional
     entries whose status change was pushed and applied.
4. **Save** the snapshot and cursor.

**When rounds run.**

- **Before every command:** a round runs with a 1.5 s HTTP timeout. A command
  waits for the lock rather than skipping it.
- **After a write command:** a push-only round.
- **`list -g`:** runs a round for each synced linked project.
- **Failures:** a network error prints one dim line and leaves local changes
  to be pushed later. `$TODO_OFFLINE=1` skips rounds entirely.
- **`todo sync`:** runs a round and prints pushed, rejected and pulled counts,
  then the unpushed diff when offline.

Acceptance:

- **(js)**
  - Idempotent replay, including two concurrent pushes.
  - Version conflict → rejection with `by`/`at`.
  - Partial op; group rollback.
  - `n`/`id` reassignment.
  - Gate and `force`; the agent rule.
  - Seq order under concurrent transactions.
  - Paging, dedupe, auth 401.
  - Every notification rule.
  - `calc_status` recompute.
- **(py)**, with a scripted fake transport:
  - The diff produces the right ops, including for drawer or hand edits.
  - Offline: the round fails and changes are kept.
  - Rejection → log entry.
  - Renumbering.
  - Pull preserves comments and unknown keys.
  - Pull keeps an in-flight local edit.
  - A second command waits for the lock.
  - Push-only rounds advance the snapshot, so a later round doesn't
    self-reject.
- **(e2e)** The scenario in "Done when".

## Phase 3 — Jira bridge (`server/lib/jira/`)

**Config.**

- Environment: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`,
  `JIRA_WEBHOOK_SECRET`.
- `projects.jira_project` maps a Jira project key to a todo project.
- `projects.jira_status_map` maps a todo status to a Jira status name; inbound
  changes use it in reverse.

**Inbound:** `POST /api/jira/webhook?secret=…`. A bad secret gets 401. The
bridge applies ops through `apply.ts` with `unconditional` set and author
`jira-bridge`.

- `jira:issue_created` creates an item:
  - `status: requested`
  - a `ticket-request` note with the summary and description (ADF flattened to
    text)
  - `creator` from the reporter, `developer` from the assignee
  - a `jira_links` row
- `jira:issue_updated`:
  - an assignee change → `developer`
  - a status change → the reverse-mapped todo status. It is skipped when the
    item's current status already maps to the incoming Jira status, which
    covers the echo of our own transition. The reverse map takes the first
    todo status listed for a Jira status.
- `comment_created` → a `comment` note with `source: jira`.
- Users map through `users.jira_account_id`. An unmatched user is recorded as
  `jira:<displayName>`.

**Outbound:** `apply.ts` queues outbox rows for a linked item.

- A status change becomes a transition to the mapped Jira status, found through
  `GET /transitions`. Unmapped statuses are skipped, and so is a transition to
  the status the issue already has.
- A `comment`/`qa-rejection` note without `source: jira` becomes a Jira
  comment.
- A `link` note becomes a remote link.

**Delivery.** Routes flush the outbox in `after()` from `next/server`.
`GET /api/jira/flush` runs as a Vercel cron (`vercel.json`) and retries.
Failures record `error` and increment `attempts`, giving up after 5.

Acceptance **(js)**:

- Fixtures for create, assignee, status and comment.
- A bad secret → 401.
- Outbound URLs and bodies, checked through a mocked `fetch`.
- No echo of Jira comments or of our own transitions.
- Bounded retries.

## Phase 4 — dashboard

This phase is built from the UI design doc.

- **Reads:** server components read through `lib/views.ts` loaders, which
  return entities with their `versions`.
- **Writes:** server actions build ops, carrying the versions the form was
  opened with, and call `apply.ts`.
- **Rejections:** a rejected field returns a banner and keeps the draft.
- **Live updates:** the client polls `changes?since=` and the inbox every 3 s
  while visible, and calls `router.refresh()`. An open composer keeps its
  `base`.
- **Attachments:** pasted or dropped images upload through `POST /api/upload`
  to Vercel Blob when `BLOB_READ_WRITE_TOKEN` is set; the control is hidden
  otherwise.

Acceptance **(js)**:

- Every action produces the right ops, groups and bases.
- The loaders return what each view needs.
- `next build` succeeds.

## External work — cannot be finished from this repo

- **Vercel and Postgres:** deploying to Vercel, and provisioning managed
  Postgres and a Blob store. These need the user's accounts.
- **Jira:** registering the webhook and creating an API token. These need Jira
  admin access.
- **Watchtower drawer:** stripping and preserving front matter on notes,
  preserving `uid` in task flow maps, and learning the new statuses and colors.
  It lives in the watchtower repo.
