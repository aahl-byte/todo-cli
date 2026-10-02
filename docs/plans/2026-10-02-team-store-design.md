# Team store design

**Date:** 2026-10-02 · **Status:** proposed

## Goal

A team runs its tickets in `todo` and stops using Jira. You can check it like this:

- A PM files a bug. It shows up in the assigned dev's `todo list` and in the web
  UI within seconds.
- The dev runs `todo start` and `todo note` offline. On reconnect the server
  holds both changes, and a QA comment added in the meantime appears locally.
- An offline edit never silently overwrites a newer one from someone else.
- `todo deploy-plan` prints everything the next deploy needs across all
  `ready-to-deploy` items.
- Until cutover, the same ticket's status and comments match in Jira.

## Lifecycle

| step | status | moved there by |
|---|---|---|
| PM submits a feature or bug | `requested` | PM |
| dev clarifies with the PM, refines | `in-triage` → `todo` | dev |
| dev or AI works it | `in-progress` | dev / AI |
| dev self-review before QA | `review` | dev / AI |
| waiting for QA | `ready-for-qa` | dev |
| QA testing | `in-qa` | QA |
| QA rejects | `in-progress`, with a required `qa-rejection` comment | QA |
| QA approves | `ready-to-deploy` | QA |
| shipped | `deployed` | deployer |

`blocked`, `deferred` and `cancelled` keep their meaning. `done` remains the
terminal status for projects without a deploy step. Work and review may loop
any number of times before `ready-for-qa`.

An AI parks finished work in `review`. Only a person moves an item to
`ready-for-qa`.

Every status change appends to the item's **status history**: from, to, who,
when. Transitions are recorded, not role-gated.

## Item model additions

- **People:** `creator`, `developer`, `qa_assignee` — user handles.
- **Note kinds:** every note gets a `kind`:
  - `context` — the existing internal notes (default).
  - `ticket-request` — the PM's original text. It comes from outside the
    project, so agents treat it as intent to re-interpret, not instructions.
  - `comment` — authored chat with `@handle` mentions.
  - `qa-rejection` — a comment required on QA reject.
  - `link` — `url`, `label`, `type` (`pr`, `preview`, `qa-handoff`, …).
  - `clarification` — a question that needs a human answer, typically raised
    by an AI. It stays `open` until answered; `todo get` lists open ones first.
- **Authorship:** notes, logs and comments carry `author`. Entries an agent
  writes also carry `via: agent`.
- **Deployment checks:** a list per item, stored in `checks/CHECKS.yaml`. Each
  check has a `kind` (`db-script`, `env-var`, `prereq-branch`,
  `feature-flag`, `manual-step`, `other`), a title, an optional payload (script
  path, variable, branch or item id), a timing (`pre-deploy` or `post-deploy`),
  and a status of `pending` or `done`.
  - An item cannot move to `deployed` while a `pre-deploy` check is pending,
    unless `--force`.
  - `todo deploy-plan` gathers checks from every `ready-to-deploy` item,
    grouped by kind in item order, and flags prerequisite items not yet deployed.

On disk, a note's kind, author and fields go in YAML front matter above the
Markdown body; a note without front matter is a `context` note.

## Sync

The server is the source of truth. A local `.TODO/` is a cache plus an outbox,
so every command still works offline.

**Operations.** Each CLI write becomes an operation — set field, add note, add
task, move task, set check — with a ULID. The CLI applies it to the local files
at once and appends it to `.TODO/.sync/outbox/`.

**Push.** The server applies each operation once (keyed by its ULID) and stamps
it with a sequence number from a single counter.

**Pull.** The client asks for every change after its saved sequence number and
writes those changes into the local files.

**Conflicts.** Adds never conflict: notes, logs, comments and history only grow.
A field write carries the field version the client last saw.

- If the server's version still matches, the write applies.
- If someone changed the field since, the server keeps its value and returns a
  rejection. On the next pull the CLI logs it on the item (“offline status →
  `review` not applied; QA set `in-qa` at 14:02”).

This stops an offline dev from silently undoing a QA approval.

**IDs.** A task, note or check is really identified by its ULID. The short `[n]`
that commands take is still allocated locally as max + 1. The server keeps it
unless another client already took that number offline. Then the server
reassigns it, and the CLI prints the change on sync. Item ids collide the same
way and take a `-2` suffix.

**When it runs.** Each command pushes and pulls with a short timeout and falls
back to queueing. `todo sync` forces a round and reports pending operations.

**Setup.** `todo link --remote <url>` turns a linked project at
`~/.todo/projects/<key>/` into a synced cache. Identity and token live in
`~/.todo/config.yaml`.

## Server

A single Next.js app on Vercel serves the dashboard, the sync API, and the Jira
webhooks. The CLI only speaks HTTP to it.

- **Postgres** comes from a managed host Vercel can reach. It has tables for
  projects, users, items, tasks, notes, logs, checks, status history, an
  append-only `changes` table holding the sequence numbers, and `jira_links`.
- **The API** lives in route handlers: `POST /api/ops` for push and
  `GET /api/changes?since=` for pull.
- **Live status** comes from the dashboard polling `changes?since=` every few
  seconds. That is one indexed query. Vercel functions cannot hold a long-lived
  `LISTEN` connection, so true push would need the database host's realtime
  feature.

## Jira bridge

The bridge runs on the server with one integration credential. Each linked item
stores its Jira key.

- **Jira → todo:** new tickets become `requested` items with the description as
  a `ticket-request` note. Comments and assignee changes come over too.
- **todo → Jira:** status changes go back through a configurable mapping to
  Jira workflow transitions, along with comments and `link` notes.
- **Kept in todo only:** context notes, dev logs, tasks, clarifications and
  deployment checks.
- **Trigger:** Jira webhooks drive inbound changes, and the REST API carries
  outbound ones.

With the bridge in place, PMs and QA keep using Jira while devs move to `todo`.
That lets the web UI come after the bridge.

## Phases

1. **Local model:** statuses and status history, note kinds and front matter,
   people fields, deployment checks and `deploy-plan`, ULIDs, and the operation
   outbox format. This is useful before any server exists.
2. **Server and sync:** Next.js app on Vercel, Postgres schema, API route
   handlers, auth, push/pull, conflict
   rejection, `link --remote`, `todo sync`.
3. **Jira bridge:** inbound webhooks, outbound transitions, status mapping
   config.
4. **Dashboard (same Next.js app):** PM submission form, QA queue, deploy board, live status,
   `@mention` notifications. Cut over from Jira when this lands.

## Open questions

- Team item ids: keep slugs, or use prefixed keys like `WEB-142`?
- The watchtower drawer reads `.TODO/` today. Decide whether it becomes the web
  UI or stays a local viewer.
