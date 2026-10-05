# Live Jira data, read-only

**Date:** 2026-10-05 · **Builds on:** the Jira bridge (`server/lib/jira/`)

## Goal

You can check each of these at `http://leaf-rain:3940`:

- The board shows SR's active issues, each in the column its Jira status maps
  to. "Active" means:
  - not Done, and either past Open or updated in the last 30 days
  - plus anything resolved in the last 14 days
- Each card shows its Jira key and its epic. The item page links to the issue,
  and holds its description as the request and its Jira comments as comments.
- Sub-tasks show as the item's tasks, so the progress glance works.
- Within about a minute of a change in Jira, the board reflects it: a status
  move, a new assignee, an edited description (as a new request version), a new
  comment, a new issue.
- Everyone assigned or reporting in SR can sign in as `<handle>` with password
  `<handle>-test`, so the role filters work on real people.
- Nothing is ever written to Jira. The top bar says "Jira read-only".
- The demo on :3917 is untouched.

## 1. Local Postgres

- **Cluster:** a user-owned Postgres 17 cluster at `~/.local/share/todo/pg` on
  port 5442, started with `pg_ctl`, with a database `todo_jira`.
- **Server:** a second `next start` on :3940 with
  `DATABASE_URL=postgres://localhost:5442/todo_jira`, the Jira variables from
  the repo's `.env`, and `JIRA_READ_ONLY=1`.
- **Project:** `npm run project:add` creates `sr` (name "Dev Work"), with
  `jira_project = 'SR'` and this status map:

  | todo | Jira |
  |---|---|
  | requested | Open |
  | todo | Ready |
  | in-progress | In Development |
  | blocked | Blocked |
  | in-qa | QA |
  | ready-to-deploy | Ready to Deploy |
  | done | Done |

## 2. Config (`lib/jira/config.ts`, webhook route)

- `jiraConfig()` needs only the base URL, email and token. The webhook route
  refuses requests itself when `JIRA_WEBHOOK_SECRET` is unset.
- **New `JIRA_READ_ONLY=1`:**
  - `queueJira` and `enqueue` write no outbox rows
  - `flushJira` sends nothing
  - `jiraReadOnly()` lets the UI show the state

## 3. Sync (`lib/jira/sync.ts`, `scripts/jira-sync.ts`, `app/api/jira/sync/route.ts`)

`syncJira(db, projectKey, { createUsers?, fetchImpl? })` runs one pass:

1. **Find work.** Search with `POST /rest/api/3/search/jql`, paging with
   `nextPageToken`.
   - **Scope:** the project's active JQL, from `projects.jira_jql` or the default
     above, excluding Epics.
   - **After the first pass:** narrowed to `updated >= -<N>m`, where N covers
     the time since `projects.jira_synced_at` plus 2 minutes of overlap.
     Relative minutes avoid Jira's user-timezone date parsing.
   - **Fields:** summary, description, status, assignee, reporter, issuetype,
     priority, parent, created, updated, comment.
2. **New issue (no `jira_links` row), not a sub-task:** import it as it is now.
   - **Item:**
     - `status`: the mapped status; unmapped falls back to `requested`
     - `type`: `bug` for Bug and Defect, `feature` otherwise
     - `priority`: CRITICAL and Highest → urgent, High → high, Medium → medium,
       Low and Lowest → low
     - `developer` and `creator` from the assignee and reporter, `created` from
       Jira
     - `extra.epic` holds the parent epic's summary
   - **Request:** v1 is summary plus description.
   - **Comments:** every existing comment, each with op id
     `jira:comment:<id>`, as the webhook path uses.
   - **`jira_links`:** `last_event_at` is set to the issue's `updated`, so
     history from before the import is never replayed.
3. **Linked issue:** replay its changelog entries newer than
   `jira_links.last_event_at` through `handleWebhook` as `jira:issue_updated`
   events, oldest first. Each event carries the entry's id, author, timestamp
   and items, so status, assignee and request versions take the existing,
   idempotent path. Then pass comments with no matching note through
   `handleWebhook` as `comment_created`.
   - The changelog comes from `GET /issue/<key>/changelog`, and comments from
     the search's `comment` field. That field caps at 20, so the sync falls back
     to `GET /issue/<key>/comment` when the total is higher.
   - Linked issues that have since left the active JQL are left as they are.
4. **Sub-task with a linked parent:** upsert a task on the parent.
   - **Identity:** uid `jiraUid("task", key)`.
   - **Fields:** the title and a task status:
     - Open, Ready → todo
     - In Development → in-progress
     - Blocked → blocked
     - QA, Ready to Deploy → review
     - Done → done
   - Sub-tasks are searched with their own JQL, `parent in (<linked keys>)`, in
     batches.
5. **Cursor:** `projects.jira_synced_at` is set to the pass's start time, and
   only after the pass succeeds.

**Imported requests are triaged.** Jira's own workflow is where SR triages.
- **Import:** when the bridge creates a request on an item past `requested`, the
  request is frozen with `frozen_via: "jira"` and `triaged: true`.
- **Later moves:** a bridge move out of `requested` stamps the same.

Otherwise every imported card would show "untriaged".

**People.** With `createUsers`, the sync creates a user the first time it meets
an account:
- handle: the display name slugged (`andrew-ahlstrom`), or with `-2` added on a
  clash
- password: `<handle>-test`
- `jira_account_id`: set

It runs before any op, so `handleFor` maps the account to the new user.

**Running it.**
- `npm run jira:sync -- sr [--every 60] [--create-users]` runs one pass, or one
  pass every N seconds until stopped. It logs counts per pass: imported, events
  replayed, comments, tasks.
- **`POST /api/jira/sync?project=sr`**, with `CRON_SECRET`, runs one pass, for
  Vercel later.

## 4. Display

- **Cards** show the Jira key as a small mono tag. The `where` line shows the
  epic when there's no app.
- **Top bar:** a faint "Jira read-only" tag, when set.
- The item rail already links the key.

## Acceptance

- **(js, fake Jira)**
  - first pass imports with mapped status, type, priority, people, epic and
    comments; the request is triaged
  - a second pass with a changelog status change and a new comment applies both
    once; a third identical pass changes nothing
  - a sub-task becomes a task and follows its status
  - read-only: a board move queues no outbox row
  - `jiraConfig` works without a webhook secret
- **(live)**
  - after the first pass, the item count equals Jira's count for the same JQL
  - three spot-checked issues match Jira for status, assignee, epic, comment
    count and sub-tasks
  - a second pass right after imports nothing and replays nothing new
- **(smoke)** the existing smoke run stays clean on the demo build.

## Revisions after the plan audit

These override the sections above where they differ.

- **Read-only changes how the bridge reads Jira**, for every process:
  - `syncJira` refuses to run unless `JIRA_READ_ONLY=1`, and the sync script
    sets it.
  - Read-only, no Jira change counts as our own echo. The token is the user's
    personal account, so their edits and comments would otherwise be dropped.
- **No bounce in read-only.** A bridge-posted request version on an item past
  `requested` is stored frozen and triaged (`frozen_via: "jira"`), and the item
  stays where Jira has it. The same read-only scope applies to marking imported
  and bridge-moved requests triaged; webhook-mode projects keep today's
  behaviour.
- **Local status moves are refused on linked items** when read-only (new reason
  `jira-read-only`), so the board can't drift from Jira. Comments, notes, links
  and tasks stay editable locally.
- **Changelog cursor:** a new `jira_links.replayed_through` (ms) per link,
  separate from `last_event_at`. Each event's `timestamp` is the entry's
  `created` in ms. `/changelog` is read through to its last page.
- **Comments carry Jira's `created` as `ts`**, in the webhook path too.
- **Summary edits update the item title**; priority edits update priority. Epic
  and type changes after import are out of scope.
- **Sub-tasks:** a full `parent in (...)` fetch for parents imported in this
  pass, plus an `updated`-window search for sub-tasks on every later pass.
- **Users:** the handle-clash check runs before `addUser`, so no existing token
  is overwritten.
- **Setup:** new `npm run jira:project -- <key> <JIRA_KEY> '<status map json>'`
  sets `jira_project` and the map. Schema gains `projects.jira_synced_at` and
  `jira_links.replayed_through`.
- **Dropped:** `POST /api/jira/sync` and `projects.jira_jql`. The active JQL is
  the built-in default.
- **Running:** the Postgres container restarts on its own. The :3940 server and
  the `--every 60` sync run as session background jobs; making them survive a
  session restart (systemd user units) is a separate ask.

## Revision: Jira statuses map to sets of todo statuses

The user's workflow: Jira `Open` is the backlog, `Ready` is todo's `requested`,
and `In Development` holds all accepted work, which todo splits into
`in-triage`, `todo`, `in-progress`, `review` and `qa-rejected`.

- **New `projects.jira_inbound` (jsonb):**
  ```json
  { "statuses": { "Ready": ["requested"],
                  "In Development": ["in-progress", "in-triage", "todo", "review", "qa-rejected"],
                  "Blocked": ["blocked"], "QA": ["ready-for-qa", "in-qa"],
                  "Ready to Deploy": ["ready-to-deploy"], "Done": ["done", "deployed"] },
    "transitions": [ { "from": "QA", "to": "In Development", "status": "qa-rejected" } ] }
  ```
  - Each Jira status names its set of todo statuses. The first one is the
    default for an item arriving from outside the set.
  - Matching is case-insensitive.
  - A Jira status with no entry is ignored.
- **Inbound status change** (webhook or replayed changelog, `from` and `to`
  Jira names):
  1. A matching transition rule wins.
  2. Otherwise, if the item's status is already in `to`'s set, nothing changes.
  3. Otherwise, the item moves to the set's default.
- **Without `jira_inbound`,** the existing reverse lookup of `jira_status_map`
  still applies.
- **Import:** a new item takes the default of its Jira status's set.
- **Active scope (default JQL):** `statusCategory != Done` and status in the
  set's keys. Unmapped statuses such as `Open` (the backlog) stay out.
- **Read-only local moves:** a status move is refused only when the target's
  Jira status differs from the current one's. Moves inside a set are allowed,
  because Jira would not change.
- **Setup:** `npm run jira:project -- sr SR '<status map>' 'Dev Work'
  '<inbound json>'`.
- **Outbound** (todo → Jira transitions, comments) is the separate event-rules
  item, and the read-only mirror doesn't use it.
- **Re-import** into a fresh database, because existing items took the old
  mapping.

**Acceptance (js)**
- An item in `review` stays in `review` when Jira says `In Development`.
- `QA → In Development` makes it `qa-rejected`.
- `Ready` maps to `requested`.
- Import uses each set's default.
- The JQL excludes `Open`.
- Read-only allows `in-triage → in-progress` locally and refuses `in-progress →
  in-qa`.
