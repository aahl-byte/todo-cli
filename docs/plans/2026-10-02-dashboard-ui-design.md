# Team dashboard UI design

**Date:** 2026-10-02 · **Status:** proposed, awaiting user review ·
**Data model:** `docs/plans/2026-10-02-team-store-design.md`

## Who uses it, and for what

- **PMs** file requests, answer clarifications, and follow a ticket to deploy.
- **Devs** see their queue and work an item. The item page carries what the CLI
  is loved for: phased tasks with progress, context notes, and the dev log.
- **QA** pick up `ready-for-qa` items, open the preview, and approve or reject.
- **Deployers** see what the next deploy needs and mark items `deployed`.

## Shell

Every page shares a top bar:

- a project switcher
- **Board**, **QA**, **Deploy**
- **Inbox** with an unread count
- a **New request** button
- the signed-in handle
- a live dot: green while polling succeeds, grey with "offline — retrying" when
  it fails

Polling hits `changes?since=` every 3 s while the tab is visible. When anything
has changed it refreshes the page data, and cards or rows that changed flash
for a second.

Status is always shown as a text pill, never color alone. Colors follow the CLI
palette:

| status | color |
|---|---|
| `requested` | slate |
| `todo` | grey |
| `in-triage` | yellow |
| `in-progress` | cyan |
| `review` | purple |
| `ready-for-qa` | orange |
| `in-qa` | amber |
| `ready-to-deploy` | teal |
| `deployed` | green |
| `done` | green |
| `blocked` | red |
| `deferred` | dim grey |
| `cancelled` | dim red |

Light and dark themes come from CSS variables. There is no component library.

Anything an agent wrote (`via: agent`) carries a small **AI** badge.

## Edits and conflicts

Every action is one or more ops sent to `apply.ts`, the same path the CLI's sync
uses.

- **Versions:** each form carries the field versions from the moment it was
  opened. A live refresh never changes the versions under an open composer, so
  a stale tab can't quietly overwrite a newer change.
- **Rejections:** a rejected write shows an inline banner ("QA set `in-qa` at
  14:02 — reload"), and the draft text is kept.
- **Groups:** an action that writes more than one thing, such as Reject (status
  plus `qa-rejection` note), sends its ops as a group, so either all apply or
  none do.

Item ids are slugs derived from the title; a linked Jira key shows beside the
slug. The watchtower drawer stays a separate local viewer.

## Board — `/p/[key]`

The columns follow the lifecycle:

| column | statuses |
|---|---|
| Requested | `requested` |
| Triage | `in-triage` |
| Ready | `todo` |
| In progress | `in-progress`, `review`, `blocked` |
| QA | `ready-for-qa`, `in-qa` |
| Ready to deploy | `ready-to-deploy` |
| Shipped | `deployed`, `done` (last 14 days) |

`blocked` cards sit in In progress with a red edge. `deferred` and `cancelled`
are hidden unless the "show parked" filter is on.

A card shows:

- the id and a type icon (bug or feature)
- the title
- the priority
- the developer and QA initials
- a **segmented task bar**, one segment per task colored by its status
- `? n` for open clarifications
- `⛔ n` for pending pre-deploy checks

Filters: **Mine** (developer, QA or creator is me), **Needs my review**
(`review`, last moved there by an agent, developer is me), developer, QA, type,
and show parked. Filters live in the URL query, so a filtered board can be shared.

Status changes happen on the item page and the queues. The board has no
drag-and-drop, so every move goes through a named action.

## Item — `/p/[key]/i/[id]`

**Header.** The title, id, type, priority and Jira key (linked when present),
then the status pill and calc-status. Next to them are the **next-step
buttons** for the current status:

| status | buttons |
|---|---|
| `requested` | Start triage |
| `in-triage` | Mark refined (→ `todo`) |
| `todo` | Start |
| `in-progress` | Send to review |
| `review` | Back to work (optional comment) · Ready for QA |
| `ready-for-qa` | Pick up (→ `in-qa`) |
| `in-qa` | Approve · Reject |
| `ready-to-deploy` | Mark deployed |

For a project with no deploy step (`projects.deploy_step` off), Approve goes
to `done`, and the Deploy nav and the Ready to deploy column are hidden.

Reject opens a required comment box. Mark deployed is disabled while
pre-deploy checks are pending, and a "deploy anyway" link sends `force`, which
history records as forced.

A "Set status" menu offers every status, including `blocked`, `deferred` and
`cancelled`. Two moves go through their dedicated flows:

- `in-qa` → `in-progress` opens the Reject dialog.
- → `deployed` behaves like Mark deployed.

The title, type and priority are editable in place.

**People row.** Creator (read-only), plus Developer and QA as selects of known
users.

**Main column**, top to bottom:

1. **Ticket request.** The PM's text in a muted card labeled "original request
   — external context", collapsed after the first 6 lines.
2. **Open clarifications.** A yellow callout per question with an inline
   Answer box. Answered ones fold into a "resolved questions" list. An "Ask a
   question" composer adds a clarification, which notifies the creator.
3. **Tasks by phase.** One section per phase, headed "Phase N", with a
   done/total progress bar. Each task row shows a status dot, `[n]` and the
   title, plus a status menu, a phase menu and remove. An add-task row appears at
   the bottom of every phase and in Unphased.
4. **Context notes.** Rendered Markdown, newest last, with an add-note box.
5. **Dev log.** The last 5 entries with timestamps, and "show all n".
6. **Comments.** A thread with a composer. Typing `@` autocompletes users, and
   a mention notifies that user. `qa-rejection` comments show a red "QA
   rejected" tag. Pasting or dropping an image into any composer uploads it and
   inserts a Markdown image, when a Blob store is configured.

**Side column:**

- **Links**, grouped by type (PR, preview, QA handoff, other), with an add-link
  form and remove.
- **Deployment checks**, split into pre and post. Each has a checkbox for
  done/pending, a kind tag, a payload in mono, and remove. An add-check form sits
  below.
- **History**, a status timeline of from → to, who and when, with a bounce
  count ("returned from QA ×2").

## New request — `/p/[key]/new`

The form asks for a title, type (feature or bug), priority, a description
(Markdown, which becomes the `ticket-request` note), and an optional developer
and QA. Submitting creates a `requested` item with the signed-in user as
creator, then opens the item page.

## QA queue — `/p/[key]/qa`

- **Ready for QA**, oldest first. Each row has a **Pick up** button that moves
  the item to `in-qa` and sets QA to me if it was empty.
- **In QA**, with my items first.

Each row shows the preview and QA-handoff links up front, the bounce count, the
developer, and inline **Approve** and **Reject** (Reject needs a comment).

## Deploy board — `/p/[key]/deploy`

This is the same plan as `todo deploy-plan`:

- **Pre-deploy**, grouped by kind in the order prereq-branch, db-script,
  env-var, feature-flag, manual-step, other. Each check row has a checkbox, the
  item, `[n]`, the title and the payload.
- **Prereq warnings**, highlighted.
- **Post-deploy**, in the same grouping.
- **The ready-to-deploy items**:
  - Each has **Mark deployed**, disabled while that item has pending
    pre-deploy checks, plus a "deploy anyway" force link.
  - **Mark all deployed** runs the gate per item and lists the items it held
    back.
- **Deployed — post-deploy pending**: deployed items whose post-deploy checks
  are still open.

## Inbox — `/inbox`

Notifications for me across projects, unread first:

- @mentions
- QA rejections of my items
- questions on items I created
- answers to my questions
- items handed to me for QA
- my requests getting deployed

Opening one marks it read and jumps to the note or item. The unread badge
polls `GET /api/inbox`.

## Sign-in — `/login`

The form takes a handle and token (the same token the CLI uses) and sets an
httpOnly cookie. Every other page redirects here when signed out.

## Layout on narrow screens

- Board columns scroll horizontally.
- The item page stacks the side column under the main one.
- The top bar collapses the nav into a menu.

## Out of scope

- Drag-and-drop on the board.
- Rich-text editing; Markdown textareas are enough.
- SSO; tokens are enough to start.
- Editing or removing other people's comments.
