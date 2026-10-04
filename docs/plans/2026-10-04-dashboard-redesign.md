# Dashboard redesign

**Date:** 2026-10-04 · **Replaces:** the item page, board and shell sections of
`2026-10-02-dashboard-ui-design.md` (the data model, ops and conflict rules there
still hold)

## Goal

Make the dashboard calm, quiet and dense: every pixel either shows state or
invites an action the user is about to take. The look matches watchtower's TODO
drawer, so the two tools read as one product.

How to check it:

- The item page shows only the title, the status and the request until you open
  a tab or click to edit.
- There are no input boxes until you click an add or edit control.
- Nothing on the page repeats something shown elsewhere on it.
- Tasks, notes and dev log look and behave like the watchtower drawer.

## Principles

1. **Show, then edit.** Values render as plain text or a status light. A click
   turns one into an editor; Enter or blur saves, Esc cancels. Nothing has a
   permanent Save button.
2. **Inputs on demand.** Composers open from a `+` control and close after
   adding or on Esc. Bigger forms (a link, a check) open in a small popup.
3. **One place per fact.** The header carries status and title only. Everything
   else about the item lives in the right rail or a tab.
4. **No narration.** Cut helper sentences, verbose empty states ("None open."),
   labels that restate the obvious, and names where position or color already
   says it. Details sit in instant tooltips.
5. **Done work folds away.** Finished tasks, answered questions and old entries
   collapse by default.

## Visual system (every page)

- **Palette:** watchtower's console tokens, dark only.

  | token | value | token | value |
  |---|---|---|---|
  | `--ink` | `#0a0c10` | `--line` | `#232a33` |
  | `--panel` | `#11151b` | `--line-2` | `#2d3742` |
  | `--panel-2` | `#171c24` | `--text` | `#c4ccd6` |
  | `--raise` | `#1c222b` | `--dim` | `#737e8b` |
  | | | `--faint` | `#4a535e` |

  Markdown emphasis uses watchtower's ramp: bold near-white, italic darker
  gray.
- **Type:**
  - Body: JetBrains Mono, 13px/1.45; entry text 12.5px.
  - Labels and section heads: Space Grotesk, 9px, uppercase, letter-spacing
    .14em, weight 600, `--faint`.
  - Both fonts load through `next/font/google`.
- **Status light (`Led`):** a 6px dot. Live statuses glow with
  `box-shadow: 0 0 7px <color>`. Item statuses show the light plus an uppercase
  label; task statuses show the light only.

  | status | color | status | color |
  |---|---|---|---|
  | `requested` | `#8a97a6` | `in-qa` | `#e668b3` |
  | `todo` | `#59636f` | `ready-to-deploy` | `#7fd88f` |
  | `in-triage` | `#4d8df6` | `deployed` | `#5ad1c4` |
  | `in-progress` | `#ffb454` | `done` | `#5ad1c4` |
  | `review` | `#b083f0` | `blocked` | `#e5534b` |
  | `ready-for-qa` | `#ff8c42` | `deferred` | `#2d3742` |
  | | | `cancelled` | `#8a4a46` |

- **Menus:** one popover listbox component for every pick (status, task status,
  person, type, priority). Each option shows its light or label, with ✓ on the
  current one. The menu is keyboard-navigable and closes on Esc or a click
  outside.
- **Popups:** a small modal for multi-field adds (link, check). The first field
  is focused, Enter submits, Esc closes.
- **Tooltips:** instant, custom (`data-tip`), never the slow native `title`.
- **Times:** relative ("3h", "Sep 26"), with the full local time in the tooltip.
- **One chevron glyph** (`›`, rotated when open) for every collapse.

## Item page

```
┌────────────────────────────────────────────────┬───────────────────────┐
│ ● IN-PROGRESS ▾  Export invoices as CSV        │ PEOPLE                │
│                                                │ dev   dana ▾          │
│ Finance wants a CSV export of the invoice …    │ qa    quinn ▾         │
│                                                │ DETAILS               │
│ COMMENTS 2  QUESTIONS 1  TASKS 2/4  NOTES 1  LOG 1 │ feature · medium ▾ │
│ ─────────────────────────────────────────  +   │ export-invoices… ⧉    │
│ (active tab content)                           │ LINKS              +  │
│                                                │ PR  PR #42            │
│                                                │ CHECKS             +  │
│                                                │ ☐ db-script convert … │
│                                                │ HISTORY               │
│                                                │ ● requested     2d    │
│                                                │ ● in-progress   3h    │
└────────────────────────────────────────────────┴───────────────────────┘
```

### Header

The status selector sits on the same line as the title.

- **Status selector:** the light, the label and a caret. It opens a menu of the
  transitions allowed from the current status (see Transitions), with the
  current status ✓ at the top.
  - **→ `in-progress` from `in-qa`** opens a small popup that requires a
    comment, posted as a `qa-rejection` note in the same group.
  - **→ `deployed` with pending pre-deploy checks** shows the option as "deployed
    · 2 checks pending". Choosing it opens a confirm popup with a
    "Deploy anyway" button that sends `force`.
  - **→ `in-qa` with no QA assignee** also assigns the current user.
- **Title:** plain text; clicking it turns it into an input. Enter or blur
  saves, Esc cancels.
- **Removed from the header:** the id, type and priority line; calc-status (it
  moves to the Tasks tab header); every progress button.

### Request

The `ticket-request` note renders as Markdown under the title, collapsed after
6 lines with a `more` chevron, and labelled only by its position.

- **Editing:** while the item is `requested`, hovering shows ✎ and a click turns
  it into a textarea with Save and Esc. An item with no request shows
  `+ request`.
- **Locking:** the server rejects edits to a `ticket-request` note unless the
  item is `requested` (`request-locked`). Changing a request therefore means
  sending the item back to `requested`, so every change goes through triage.

### Tabs

The tabs are Comments, Questions, Tasks, Notes and Log. Each label is a
display-font word plus a count: Questions counts open questions, Tasks shows
done/total. The active tab gets a 1px underline. A `+` sits at the right end of
the tab bar for the active tab.

- **Default tab:** Questions when any are open, otherwise the user's last tab
  (kept in localStorage), otherwise Comments.
- **Entry order:** newest first everywhere.
- **Composer:** the `+` opens a one-line, autogrowing textarea above the list.
  Ctrl/Cmd+Enter adds, Esc closes, and the draft survives a live refresh.

**Comments**
- Each row shows the author and relative time in faint text, then the Markdown
  text. A `qa-rejection` comment gets a small red `QA REJECTED` label.
- `@` autocompletes users, and pasting an image uploads it when Blob is set
  up.

**Questions**
- Open questions are listed first. Each has an `answer` control that opens an
  inline answer box.
- Answered questions fold under `› answered n`. Each one shows the question, then
  the answer, then who answered.

**Tasks** (watchtower)
- **Header:** the done/total count, the rolled-up status light, and `show done`
  when any task is finished.
- **Phases:** tasks are grouped by phase under `› phase N` or `› no phase`
  headers, in small uppercase. Finished tasks fold away. A fully finished phase
  collapses to its header plus a count; a partly finished one shows its open
  tasks plus `+N done`. A header click pins that phase open or shut.
- **Row:** a status light button, a mono `[n]`, the title, and a phase chip
  (`P2`, or `P–` with no phase). Hovering shows ✕.
  - The light opens the task-status menu. Shift-click sets `todo`, and
    Ctrl/Cmd-click sets `done`.
  - The title is click-to-edit, and so is the phase chip.
  - Finished titles are dim, and `done`/`cancelled` ones are struck through.
- **Adding:** `+` opens a title input plus a small phase input.

**Notes and Log** (watchtower)
- **Collapsed entries:** every entry starts collapsed to its first line: the
  chevron, then that line as inline Markdown, cut to one row with an ellipsis.
  A click expands it to full Markdown. `expand all` sits at the right of the
  list header.
- **Log stamps:** log rows show a stamp like `Sep 26 14:03` before the text,
  10px mono in faint, with the ISO time in the tooltip.
- **Actions:** hovering shows ✎ (notes only) and ✕. Editing a note is the same
  inline textarea; removing one takes a second click to confirm (`✕` →
  `delete?`).
- **Adding:** `+` adds a note or a log entry.

### Right rail

Sections are small uppercase labels with no boxes, separated by space.

- **People:** developer and QA as values (`—` when unset). A click opens a
  menu of users with `—` at the top. The creator shows as a faint line
  underneath.
- **Details:** type and priority are click-to-pick. The id is mono, and a click
  copies it. Below them: the created date (relative), and the Jira key as a link
  when linked.
- **Links:**
  - one row per link: a type tag (`PR`, `PREVIEW`, `QA`, `OTHER`) and the label as
    a link; ✕ on hover
  - `+` opens a popup with URL, label and type
  - only http(s) URLs render as links
- **Checks:** shown only when the project has a deploy step.
  - Rows are grouped `pre` / `post`. Each row is a checkbox, a kind tag, and the
    title, with the payload in the tooltip; ✕ on hover.
  - `+` opens a popup with kind, timing, title and payload.
- **History:** one row per transition, a status light and label plus the
  relative time. The tooltip shows who, whether by AI, and `forced`.

On narrow screens the rail stacks under the tabs.

## Transitions

These are the dashboard's allowed moves. The selector offers only these, and the
dashboard's status action checks them on the server. The CLI keeps free
transitions: offline sync collapses several moves into one write, so the server
can't enforce a step-by-step path for CLI pushes.

| from | to |
|---|---|
| `requested` | `in-triage`, `deferred`, `cancelled` |
| `in-triage` | `todo`, `requested`, `blocked`, `deferred`, `cancelled` |
| `todo` | `in-progress`, `in-triage`, `requested`, `blocked`, `deferred`, `cancelled` |
| `in-progress` | `review`, `todo`, `blocked`, `deferred`, `cancelled` |
| `review` | `in-progress`, `ready-for-qa`, `blocked` |
| `ready-for-qa` | `in-qa`, `in-progress`, `blocked` |
| `in-qa` | `ready-to-deploy` (or `done` with no deploy step), `in-progress` (reject), `blocked` |
| `ready-to-deploy` | `deployed`, `in-qa`, `in-progress`, `blocked` |
| `deployed` | `in-progress` (reopen as a regression) |
| `done` | `todo` |
| `blocked` | `in-triage`, `todo`, `in-progress`, `review`, `ready-for-qa`, `in-qa`, `ready-to-deploy` |
| `deferred` | `requested`, `in-triage`, `todo` |
| `cancelled` | `requested`, `in-triage` |

The map lives in `lib/model.ts` as `NEXT_STATUSES`. Unit tests cover it, and
the server-side check in the status action.

## Board

- **Cards:** the title, the status light with its label, and one quiet meta
  row:
  - the developer and QA as 18px initials circles, with the full handle in the
    tooltip
  - watchtower's progress glance: phase capsules over task dots
  - `?n` when there are open questions
  - `checks n` when pre-deploy checks are pending
  - a `BUG` tag for bugs, and the priority only when high or urgent
  - an `AI` badge when an agent made the last move
  - no slug id
- **Columns:** small uppercase headers with counts.
- **Filters:** the `Mine` and `Needs my review` toggle pills, plus `Filter ▾`,
  which opens a popover for developer, QA, type and parked. Filters apply on
  change, with no Apply button. A row of active-filter chips, each with ✕,
  shows only when a popover filter is set.

## Shell and other pages

- **Top bar:** one compact line:
  - the project switcher and the nav (Board, QA, Deploy)
  - `+ request`
  - the inbox count and the live light, with "live"/"offline" moved to its
    tooltip
  - a user menu (handle ▾ → sign out)
- **QA queue and deploy board:** the same row style as the cards. Actions stay
  as compact buttons, because the queue exists to act on. Empty states become a
  single faint word.
- **Inbox:** each row is a light-colored kind label, the actor, the item title
  and a relative time. Unread rows are brighter, with no bullets.
- **New request:** title, type and priority on one line; the description; and
  people as an optional disclosure.
- **Sign-in:** two fields and a button, with no explanatory paragraph.

## Out of scope

- Drag-and-drop task reordering. The phase chip covers re-phasing.
- A light theme.

## Acceptance checks

- **(js) Transitions:** `NEXT_STATUSES` matches the table, and the status action
  refuses a move outside it.
- **(js) Request lock:** an edit to a `ticket-request` is refused unless the item
  is `requested`.
- **(smoke) Item page:**
  - no inputs on load
  - the title is click-to-edit
  - the status menu offers only allowed moves
  - reject asks for a comment
  - forcing a deploy asks for confirmation
  - each tab's `+` opens and closes its composer
  - tasks fold done, and the status light menu works
  - notes and log entries collapse and expand
  - link and check popups add and remove
  - history shows a light and a time per entry
- **(smoke) Board, request and narrow screens:**
  - board filters apply without an Apply button
  - the request edits while `requested` and is locked after
  - the page doesn't scroll sideways at 400px
- **(review) Noise:** an audit pass finds no redundant text left on any page.
