# Jira settings page: event rules both ways

**Date:** 2026-10-05 · **Builds on:** `2026-10-05-jira-live-read-only.md`

## Goal

A project's Jira behaviour is set on one page, `/p/<key>/settings`, and you can
check each of these on the mirror at `http://leaf-rain:3940/p/sr/settings`:

- **Jira → todo:** the status sets (each Jira status and the todo statuses it
  covers, the first being where an item lands) and the transition rules (a
  specific Jira move, such as `QA → In Development`, meaning a todo status) are
  shown and editable. A save takes effect on the next sync pass.
- **todo → Jira:** a list of triggers, each "todo `from → to` moves the Jira
  issue to `<Jira status>`", a switch for posting comments, and a list of Jira
  statuses never moved to (`Open` for SR).
- **Writes are off** and the page says why. A per-project switch turns writes
  on, but only where the server allows writes at all; the mirror runs with
  `JIRA_READ_ONLY=1`, so the switch shows as locked there.
- **"Would send" log:** with writes off, every trigger that fires is recorded as
  the Jira call it would have made, and the page lists the latest ones. You
  can test the rules on the mirror without anything reaching Jira.
- **Rule tester:** pick a todo move (`from → to`) and the page shows what each
  direction would do: the Jira call it triggers, or none and why. On the
  mirror, status moves that change the Jira status are refused locally, so the
  tester is how status triggers get tried there; comments reach the log.
- **Jira's own statuses** fill the pickers, read from Jira, so a rule naming a
  status the project doesn't have (such as `Deployed` in SR) is flagged.

## 1. Stored rules (`projects`)

- **Keeping** `jira_inbound` (status sets and transitions) as it is.
- **New** `jira_outbound jsonb`:
  ```json
  {
    "writes": false,
    "comments": true,
    "never": ["Open"],
    "triggers": [
      { "from": "in-triage", "to": "in-progress", "jira": "In Development" },
      { "from": "review", "to": "ready-for-qa", "jira": "QA" },
      { "from": "in-qa", "to": "ready-to-deploy", "jira": "Ready to Deploy" },
      { "from": "ready-to-deploy", "to": "deployed", "jira": "Deployed" }
    ]
  }
  ```
  - `from` may be `*` for any status.
  - The first matching trigger wins.
  - A trigger whose `jira` is listed in `never` never fires; the page refuses
    to save one.
- **SR's starting triggers** are the user's list above. The `qa > ready-to-deploy`
  rule reads as `in-qa → ready-to-deploy`; `shipped` as `deployed`. `Deployed`
  isn't an SR status, which the page flags (SR ends at `Done`).
- **Legacy `jira_status_map`** stays as the fallback for a project with no
  `jira_outbound`, so the existing bridge tests and behaviour hold.
- **New** `jira_settings_by text`, `jira_settings_at timestamptz` stamped on
  each save.

## 2. Rules engine (`lib/jira/rules.ts`)

- **New** `OutboundRules` type, `outboundRules(raw)` (null when absent) and
  `outboundTarget(rules, from, to)` → the Jira status or null.
- **New** `validateRules(inbound, outbound, statuses?)` → a list of problems,
  used by the save action and shown on the page:
  - every todo status is a real status (`STATUSES`)
  - a todo status sits in at most one Jira status set
  - transition rules name statuses that have sets
  - no trigger targets a `never` status
  - with Jira's status list available, every named Jira status exists
    (a warning, not a refusal, so an offline Jira doesn't block a save)

## 3. Outbound path

- **`queueJira` status events carry `from`.** `statusChanged` passes
  `item.status`; `bounceToRequested` passes the old status too.
- **Target choice:** with `jira_outbound`, `outboundTarget(from, to)`; nothing
  matches → no call. Without it, the legacy map as now.
- **Comments:** queued only when `comments` is on (default on for the legacy
  path). Links (remote links) follow the same switch.
- **Writes gate — new `jiraWrites(project)`**: true only when `JIRA_READ_ONLY`
  is unset *and* the project's `writes` is true (a project with only the
  legacy map counts as on, as now).
  - **On:** rows go to `jira_outbox` as now.
  - **Off:** the row is still inserted, with `done_at = now()` and
    `result = {"dry_run": true}`, so `flushJira` never picks it up and the page
    can list it.
- **`flushJira` refuses `never` targets** at delivery too, recording
  `{"refused": "never"}`, so an older queued row can't slip through.
- **Dedup of our own comments:** a delivered comment's Jira id is already in
  `jira_outbox.result.comment_id`; inbound `commented` skips a comment whose id
  is there. The `(via todo)` marker check stays as a second guard.

## 4. Read-only behaviour per project

The read-only rules from the live mirror (local status moves refused when they
would change the Jira status; Jira request edits frozen without a bounce) key
on "writes off for this project" (`!jiraWrites(project)`) instead of the
environment flag alone. On the mirror nothing changes, since the environment
keeps writes off.

`syncJira`'s "needs `JIRA_READ_ONLY=1`" guard becomes "needs writes off for
this project". Polling with writes on is left for the step that turns writes
on.

## 5. Settings page (`/p/[key]/settings`)

- **Nav:** a `Settings` link after Deploy.
- **Header:** Jira project key, link to it, the read/write state in one line:
  "Writes off: the server is read-only (`JIRA_READ_ONLY`)" or "Writes off for
  this project" or "Writes on", plus who saved last and when.
- **Jira statuses:** fetched on render with
  `GET /rest/api/3/project/<KEY>/statuses` (allowed read-only); on failure the
  pickers fall back to free text and the page says Jira couldn't be reached.
- **Jira → todo** section:
  - one row per Jira status set: the Jira status, then its todo statuses as
    ordered chips (the first marked "lands here"), with add, remove and
    move-first controls
  - Jira statuses with no set are listed as "ignored (not mirrored)"
  - a transition-rule table: Jira from, Jira to, todo status; add and remove
- **todo → Jira** section:
  - writes switch (disabled with the reason when the server is read-only)
  - comments switch
  - "never move to" chips
  - trigger table: todo from (or any), todo to, Jira status; add, remove,
    reorder
- **Save:** one button saves both sections through a server action. Problems
  from `validateRules` show inline and block the save; warnings show but
  don't.
- **Rule tester:** a from/to picker under the trigger table, evaluated in the
  browser against the unsaved rules with the same `outboundTarget`, showing
  "moves Jira to QA", "nothing: no trigger" or "nothing: Open is never
  targeted".
- **Would send:** the latest 20 `dry_run` rows: time, item, the call
  ("move SR-5651 to QA", "comment on SR-5651").
- **Built as** one client component holding the edited rules, saved as JSON
  by the server action, which validates again server-side.
- **Who can edit:** any signed-in user, like the rest of the app (it has no
  roles).

## 6. Seed and scripts

- `jira-project.ts` takes an optional outbound JSON as a sixth argument.
- The mirror's SR project gets the user's triggers with `writes: false`,
  `never: ["Open"]`.

## Out of scope

- Turning writes on for SR, and polling with writes on.
- Multi-hop transitions: a trigger moves Jira one hop, chosen by target
  status, as the `jira` CLI does; with no direct transition, the row fails
  and the dev log says so.
- Comment header wording: kept as `<name> (via todo):` until the user decides.

## Acceptance

- **(js) rules:** `outboundTarget` for exact, `*` and unmatched moves;
  `validateRules` for each problem above.
- **(js) outbound with writes off:** a matching move records one `dry_run`
  row and `flushJira` sends nothing; an unmatched move records none; a
  `never` target records none.
- **(js) outbound with writes on** (env unset, `writes: true`): the same move
  queues a real row and the fake Jira receives the transition; a queued row
  whose target is in `never` is refused at flush.
- **(js) legacy:** existing `jira.test.ts` passes unchanged.
- **(js) dedup:** an inbound comment whose id is in an outbox result is
  skipped.
- **(js) settings action:** a valid save stores both JSON columns and the
  stamp; an invalid one stores nothing and returns the problems.
- **(live)** `/p/sr/settings` on :3940 shows SR's sets, the transition rule
  and the four triggers, with `Deployed` flagged; the writes switch is locked
  with the server reason; the tester shows `review → ready-for-qa` moving Jira
  to QA; a comment added on a mirror item appears under Would send and nothing
  reaches Jira (the client refuses non-GET calls regardless).
- **(smoke)** the smoke run stays clean, with a settings-page step.

## Revisions after the plan audit

These override the sections above where they differ.

- **Dropping section 4.** The read-only rules, the sync guard and own-account
  echo detection stay keyed on `JIRA_READ_ONLY`. Keying them per project has
  no consumer while polling with writes on is out of scope, and it would drop
  the user's own Jira changes as echoes (their token is their own account).
- **The writes gate lives in `enqueue`**, so every path goes through it,
  including inbound's `gated()` "Not moved" comment.
  - `enqueue` looks up the project's writes: off (env read-only, or
    `writes: false`) → the dry-run row.
  - `flushJira` skips rows of projects whose writes are off, so a row queued
    while writes were on doesn't deliver after they're switched off.
  - `superseded()` ignores dry-run rows, so one never cancels a real queued
    move.
- **Remote links aren't sent** for a project with `jira_outbound`; the user's
  events are comments and the four moves.
- **Triggers are exact** `from → to` pairs, with no `*`, no ordering, and
  duplicates refused.
- **Comment dedup by id already exists**; that bullet and its test are dropped.
- **The tester is outbound only,** and also names the Jira status set on each
  side, e.g. "in-triage → in-progress: both under In Development; no trigger
  needed" or "requested → in-triage: Ready → In Development; no trigger, Jira
  stays in Ready". That shows where the triggers and sets disagree.
- **Nav:** Settings is always the last link.
- **Deliberate test changes:** `jira-sync.test.ts` asserts no outbox rows
  under `JIRA_READ_ONLY=1`; those become "no undelivered rows", and the local
  comment there leaves one dry-run row.
- **Added acceptance:**
  - `gated()` under writes off leaves a dry-run row and sends nothing
  - flush skips a project whose writes are off, with a row queued before
  - a dry-run row doesn't supersede an older real one
  - `bounceToRequested` passes `from`
- **For the user** (in the report, not blocking the build):
  - `in-triage → in-progress` stays inside In Development under the sets they
    gave, and `requested → in-triage` crosses Ready → In Development with no
    trigger. Which one is meant?
  - `qa` read as `in-qa`, `shipped` as `deployed`; SR has no `Deployed`.
  - With comment-id dedup in place, the `(via todo)` header is optional.
