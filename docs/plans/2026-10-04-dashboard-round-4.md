# Dashboard round 4

**Date:** 2026-10-04 · **Builds on:** `2026-10-04-dashboard-round-3.md`

## Goal

You can check each of these:

- **QA rejection.** A rejected ticket waits in its own `qa-rejected` state until
  the developer picks it up again or sends it back to triage.
- **Request.** When the current request version has never been triaged, the
  request opens showing its diff against the last triaged version.
- **QA queue.** Tickets show as cards that run left to right and wrap.
- **Inbox.**
  - It reads as a list of what needs you, grouped by ticket.
  - Each group shows what happened and who did it, plus enough of the text to
    act on.
  - Notices can be cleared one at a time, per ticket, or all at once.
- **Opening a ticket clears its notices.** Opening it by any route, from any
  tab, marks its notices read, and the inbox count drops at once.
- **Unread comments.** Comments posted since you last opened the ticket are
  highlighted. So are QA rejections, answers and questions.
- **The `+` glyph** renders at 2× its original size.
- **Filters.** The board and the QA queue filter by entries such as `assigned
  to dana` or `qa by quinn`, shown merged or as tabs.

## 1. `qa-rejected`

**Why a status of its own.** Sending a rejected ticket to `in-progress` hides
the rejection in a busy column. Sending it to `in-triage` decides for the
developer that the scope was wrong. A `qa-rejected` state says what happened,
and leaves the next step to the person who has to fix it.

**Model.**
- **Statuses:** `qa-rejected` joins `STATUSES` on both sides, after `in-qa`. It
  counts as past triage, and it is active.
- **Moves:**
  - `in-qa → qa-rejected` replaces `in-qa → in-progress`. It still needs a
    comment, posted as a `qa-rejection` note.
  - `ready-to-deploy → in-progress` becomes `ready-to-deploy → qa-rejected`, for
    the same reason.
  - From `qa-rejected`, the next step is `in-progress`. `in-triage`,
    `blocked` and `cancelled` are also offered.
  - `blocked` lists `qa-rejected` among the statuses it can return to.
- **Calc status:** `qa-rejected` ranks right after `blocked`.
- **Bounce count:** it counts moves into `qa-rejected`, and still counts the
  older `in-qa → in-progress` moves.
- **Notices:** the developer gets the existing `qa-rejection` notice.
- **Jira:** no default mapping. A project maps it in `jira_status_map` like any
  other status.

**CLI.**
- `todo reject` moves the item to `qa-rejected`.
- `todo status` accepts `qa-rejected`.
- `todo start` from `qa-rejected` is the normal way back to work.
- The skill and README describe the new state, and the skill gets a version
  bump.

**Dashboard.**
- **Board:** `qa-rejected` cards sit at the top of the In progress column. Their
  status light and label are red.
- **QA queue:** Reject moves to `qa-rejected`. `qa-rejected` cards are not
  shown, because the ticket is the developer's again.
- **Item view:** the status menu offers the moves above.

**Existing data.** Nothing migrates. Items already moved from QA to
`in-progress` stay where they are.

## 2. Request diff by default

**When it applies.** The request section opens in diff mode when the item has
an earlier version and the current version has never been triaged. That
covers both a bounce back to `requested` and a skipped triage.

**What it shows.**
- **Diff:** the current version (URL line included) against the last triaged
  version. With no triaged version, it diffs against the version before the
  current one.
- **Header:** "Changes since v2 (triaged)", or "since v2" when that version
  was never triaged.
- **Toggle:** `show as text` / `show changes` switches between the diff and
  the plain current text. The choice lasts until the page reloads.
- **Everything else** (the editor, the version list and the untriaged flag)
  stays as it is.

## 3. QA queue as cards

**Layout.**
- **Sections:** the QA page keeps its two, "Ready for QA" and "In QA".
- **Cards:**
  - Each section is a flex row that wraps, with cards 260–320px wide.
  - Each card uses the board card's look, with its actions in a footer: `Pick
    up` for ready items, and `Approve` / `Reject` for items in QA.
- **Card contents:**
  - the title, linked
  - `app · section`
  - the developer
  - time in the queue
  - a `returned ×N` badge
  - the `vN untriaged` badge
  - the first preview or QA link, as a `↗` chip
- **Narrow screens:** at 400px the cards take the full width.

## 4. Inbox

**The current problem.** It's one line per notice, made of a verb, a title and
an excerpt. Five mentions on one ticket fill five lines, nothing says which
ticket needs you most, and clearing means opening each line.

**Layout.**
- **Tabs:** `Unread · All`, each with a count, plus kind chips that filter:
  `mentions`, `QA`, `questions`, `requests`, `deploys`. The selection is kept
  in the URL.
- **Day groups:** notices are grouped under Today, Yesterday, This week and
  Earlier, by each ticket's newest notice.
- **One block per ticket:**
  - **Header:** the ticket's status light, its title (which opens the ticket),
    `project · id`, and a `✓` that clears all of that ticket's notices.
  - **Rows:** up to three notices, newest first. Each row has:
    - a kind icon with its colour (`@` mention, `✕` QA rejection, `?`
      question, `↩` answer, `→` handed to QA, `✎` request changed, `▲`
      deployed)
    - the actor and the verb
    - a one-line Markdown excerpt
    - the time
    - a per-row `✓` that clears it
  - **Overflow:** "+N more" expands the rest.
  - **Read rows:** shown in the All tab, dimmed.
- **Opening a row** goes through `/inbox/open/<id>` as it does today, so it
  lands on the note.
- **Header actions:** `Mark all read` stays, and gets a confirm if more than
  20 notices are unread.
- **Empty state:** "Nothing needs you." plus a link to the board.
- **Narrow screens:** at 400px, blocks take the full width and long excerpts
  are cut short with an ellipsis.

**Data.** `inbox()` returns the item uid and status, and each note's kind. The
page groups the notices in memory, since the query is capped at 200 rows.

## 5. Opening a ticket clears its notices

- **Trigger:** on mount, the item page calls a `seen(project, itemUid)` server
  action.
  - **Notices:** it marks every unread notice for that user and item as read.
  - **Visit time:** it records the visit in a new `item_seen(handle, project,
    item_uid, seen_at)` table.
  - **Refresh:** afterwards it refreshes the router, so the inbox count in the
    top bar drops.
- **Why an action:** the write is an action, not part of rendering, so a
  prefetch never marks anything read.
- **The `/inbox/open/<id>` route** keeps marking its own notice. The page
  marks the rest.

## 6. Unread highlight

- **Previous visit:** the item page reads the user's `seen_at` for the item
  before recording the new one. It passes the earlier value to the client as
  `lastSeen`. On a first visit, `lastSeen` is null and nothing is highlighted.
- **What gets highlighted:**
  - comments, QA rejections, questions and answers not by you, posted after
    `lastSeen`
  - an answer counts by its `answered_at`
  - new request versions count by their time
- **How it shows:**
  - a left border in the accent colour and a small `new` tag
  - each tab shows a dot when it holds anything new
  - the highlight lasts until the next visit
- **Scope:** the dashboard only. The CLI's `todo inbox` is unchanged.

## 7. `+` size

- **Size:** `.plus` and `.add .pl` drop to 2× the original glyph: 26px and
  18px. The 28px touch target stays.

## 8. Filters by role and person

This is round 3's deferred §2, rebuilt.

**Entries.** The URL carries `f=dev:dana,qa:quinn,by:pat`. Each entry pairs a
role with a person:
- `dev` is assigned-to: the developer
- `qa` is qa-by
- `by` is created-by

The popover lists them as rows of `[assigned to ▾] [person ▾] ✕`, with a
`+ add` below. Type and "show parked" stay in the popover.

**Views.** `view=merged` (the default) or `view=tabs`, set by a two-button
toggle next to the Filter button.
- **Merged:** shows items matching any entry.
- **Tabs:**
  - one tab per entry, labelled with the role, the person and a count
  - `tab=<n>` picks the tab, and the first is the default
  - each tab filters the board or the queue on its own

**Shortcuts.**
- `Mine` sets `dev:me,qa:me,by:me` in merged view. Pressing it again clears
  them.
- `Needs my review` is unchanged.
- **Old links:** `mine=1`, `dev=` and `qa=` URLs still work. They are read as
  entries and rewritten.

**Where.** The board and the QA queue share one `RoleFilter` component and one
`matchEntries()` function.

**Chips.** Each active entry shows as a chip, `assigned to dana ×`, which
removes that one entry.

## 9. Seed

- **QA rejections:** some rejected items wait in `qa-rejected`, and others have
  been picked up again.
- **Visits:** `item_seen` rows for `dev` on a few items, set earlier than some
  of their comments, so the unread highlight shows in the demo.

## Acceptance

- **(js) qa-rejected:**
  - the moves table
  - a rejection posts a `qa-rejection` note and notifies the developer
  - the bounce count includes both forms
  - calc precedence
  - triage marking treats `qa-rejected` as past triage
- **(js) `seen`:** it marks only that user's notices for that item, and returns
  the previous `seen_at`.
- **(js) `matchEntries`:**
  - merged and tabbed results
  - old parameters are read as entries
- **(js) inbox grouping:** by ticket and by day.
- **(py):**
  - `todo reject` moves the item to `qa-rejected`
  - `todo start` from `qa-rejected`
  - `qa-rejected` sync round-trips in e2e
- **(smoke):**
  - QA reject → `qa-rejected`, with the card leaving the QA queue
  - the request shows the diff by default after a bounce
  - the QA cards wrap
  - inbox: groups, clearing one notice, clearing a ticket's notices
  - opening an item lowers the inbox count
  - an unread comment is highlighted for the second user
  - the role filter in merged and tab views on the board and the QA queue
  - nothing scrolls sideways at 400px

## Revisions after the plan audit

These override the sections above where they differ.

- **Unread highlight.**
  - **The baseline:** `seen()` returns the previous `seen_at`. The client keeps it in state, set once on mount, so a live refresh never moves the highlight's baseline.
  - **First visit:** with no `item_seen` row, the baseline falls back to the time of the oldest unread notice for that item.
  - **Inbox count:** `seen()` also returns the new unread count. The page sends it in a window event that `Live` applies at once.
- **`qa-rejected` details.**
  - **Lists:** a single `PAST_TRIAGE` lives in `model.ts` and one in `status.py`, and every copy uses it. `qa-rejected` also joins:
    - the board's In progress column
    - `ACTIVE`
    - both `CALC_PRECEDENCE` lists, ranked first, so a rejected task shows on its parent
    - the CLI's colours
  - **Rank:** `rank()` gives `qa-rejected` the rank of `todo`. From it, `in-progress` is the next step and `in-triage` is a step back. `in-qa → qa-rejected` is a step back and needs a comment, posted as a `qa-rejection` note.
  - **Overrides:** an override into `qa-rejected` also posts its reason as a `qa-rejection` note, so the developer is notified.
  - **Every place that rejects** now moves to `qa-rejected`:
    - `rejectOps`
    - the QA page's Reject button
    - `cmd_reject` (status and `with_status`)
    - `bounceCount`, which counts moves into `qa-rejected` as well as the older `in-qa → in-progress` moves
  - **CLI rejection:** `todo reject` still allows `ready-for-qa`, `in-qa` and `ready-to-deploy`.
  - **CLI alias:** the hidden status-name commands skip `qa-rejected`, so a rejection always carries its comment.
  - **Jira:**
    - **Outbound:** when `qa-rejected` has no mapping, it uses `in-progress`'s.
    - **Inbound:** the echo check uses the same fallback.
    - **Shared Jira status:** if a project maps both statuses to the same Jira status, the reverse lookup picks `in-progress`.
  - **Older CLIs** store `qa-rejected` and file it in OPEN, but `todo list -g` hides it. An old `todo reject` still sends `in-progress`. The team should upgrade; nothing breaks in the meantime.
  - **QA queue:** a collapsed "Awaiting fix" section lists the viewer's own rejections that are still in `qa-rejected`.
- **Inbox, rebuilt around what needs you.**
  - **Two sections:**
    - **Needs you:** QA rejections on your tickets, questions to you, hand-offs to you, mentions
    - **FYI:** deployed, request changed, answers
  - **Grouping:** inside each section, notices are grouped by ticket, newest ticket first.
  - **Settled notices:** a notice the ticket has since moved past is dimmed and marked "settled", such as a hand-off for a ticket that has left `ready-for-qa`.
  - **Clearing:** a `✓` clears a ticket's notices, and opening the ticket also clears them. There are no per-row `✓`s, no kind chips and no day headers.
  - **Mark all read** shows an undo toast instead of asking for confirmation.
  - **Read notices:** the `Unread · All` toggle stays, so they can be shown.
- **Filters.**
  - **Merged view:** it ORs its entries. AND across roles is no longer available; that is accepted.
  - **Old URLs:** `mine`, `dev` and `qa` URLs redirect on the server to the new `f=` form.
- **More tests:**
  - the Jira fallback mapping
  - `lastSeen` staying put across a live refresh
  - the old-URL redirect
  - `moves("qa-rejected")` grouping
