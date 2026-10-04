# Dashboard round 5: board columns, filter defaults, deploy and QA polish

**Date:** 2026-10-04 · **Builds on:** `2026-10-04-dashboard-round-4.md`

## Goal

You can check each of these on the demo:

- The board's first column is **Open**. It holds `qa-rejected`, `blocked`,
  `in-triage` and `requested` cards, in that order. There's no separate Triage
  column.
- **Ready** holds `todo` and `review` cards. **In progress** holds only
  `in-progress`.
- **QA** lists `in-qa` cards above `ready-for-qa` cards.
- Within each column, cards are grouped by status in the column's order, then by
  type (bugs before features), then in their current order.
- The filter menu's role and person dropdowns are wide enough to read, in the
  normal 12px font.
- A filter with more than one entry opens in tabs. Merged is the opt-in view
  (`view=merged`).
- Board, QA and Deploy carry the active filter between them, through the nav
  links.
- The Deploy page has the role filter. Its tickets, both ready and deployed with
  checks still to do, follow the active filter and tab.
- The Deploy page has no "Deploy all" button.
- The "Deployed · still to do" header is larger and brighter.
- The QA page shows In QA above Ready for QA.
- All text is a little lighter: `--text`, `--dim`, `--faint` and `--md-em` each
  move up a step.
- The seeded QA rejections carry their repro steps inline, instead of pointing
  at a "screenshot thread" that doesn't exist.

## 1. Board columns (`lib/views.ts`, `app/p/[key]/page.tsx`)

- `COLUMNS`:
  - `open` "Open": `["qa-rejected", "blocked", "in-triage", "requested"]`
  - `ready` "Ready": `["todo", "review"]`
  - `progress` "In progress": `["in-progress"]`
  - `qa` "QA": `["in-qa", "ready-for-qa"]`
  - deploy, shipped and parked unchanged.
- `columns()` sorts each column by the status's index in `col.statuses`, then
  by type (`bug` first), keeping the incoming order for ties (stable sort). This
  replaces the qa-rejected-first sort.
- Card status label: shown whenever the column holds more than one status, so
  every card in a mixed column names its status.
- Card avatar: the creator for a `requested` card without a developer (keyed on
  the card's status, now that the column is shared).

## 2. Filters (`components/RoleFilter.tsx`, `lib/filters.ts`, pages, `globals.css`)

- **View default:** `view` is `"merged"` only when the URL says `view=merged`,
  otherwise `"tabs"`. This applies in `RoleFilter`, the board, QA and deploy
  pages, and `filterCards`/`matchEntries` callers that default the view. The
  tabs button clears the param, and the merged button sets it.
- **Sizing:** inside `.role-filter`, the selects use `font: 12px var(--mono)`.
  The role select is a fixed ~9em, and the person select fills the rest. The menu
  gets a min-width of 280px. The type select gets the same font.
- **Carried across pages:** `Nav` appends the current `f`, `view`, `tab` and
  `type` to the Board, QA and Deploy links. `review` and `parked` stay
  board-only.

## 3. Deploy page (`app/p/[key]/deploy/page.tsx`, `lib/views.ts`, `app/actions.ts`)

- Removing the Deploy all button and `deployAllAction`.
- New role filter on the page. `deployPlan` takes the filters, applies
  `matchEntries` (and type) to the ready tickets and to the deployed tickets with
  checks still to do, and returns tab counts over both. "Mark deployed" and the
  check boxes then act only on what's shown.
- The empty state keeps the filter bar, so a filter that hides everything can be
  cleared.
- The "Deployed · still to do" header uses a new `.label.section` style: about
  11px and `--text` colour.

## 4. QA page (`app/p/[key]/qa/page.tsx`)

- In QA section first, Ready for QA second, Awaiting fix last.

## 5. Text colours (`globals.css`)

- `--text #c4ccd6 → #d2d9e2`, `--dim #737e8b → #858f9c`, `--faint #4a535e →
  #5d6772`, `--md-em #8b95a2 → #9aa4b1`.

## 6. Seed (`scripts/seed-demo.ts`)

- New QA-rejection text: the problem plus two or three numbered repro steps,
  then the developer mention.

## Acceptance

- **(js)** `board()`: the Open column holds the four statuses in order; Ready
  holds review; QA lists in-qa first; a bug sorts above a feature of the same
  status.
- **(js)** `deployPlan` with a `dev:x` entry returns only x's tickets, both
  sections, and its counts.
- **(js)** `matchEntries` default view is tabs where callers omit it.
- **(smoke)**
  - board regions Open, Ready, In progress, QA, Ready to deploy
  - filter dropdowns at least 80px wide each
  - `f` with two entries shows tabs without `view=tabs`; `view=merged` shows chips
  - the nav's QA link keeps `f`
  - deploy: no Deploy all button; a filter hides another developer's ticket
  - QA page: In QA label above Ready for QA
- Server tests, CLI tests and the smoke run all pass; the demo is rebuilt and
  reseeded.

## Revisions after the plan audit

These override the sections above where they differ.

- **Mine stays merged.** The Mine button sets `view=merged`, and `legacyQuery`
  adds `view=merged` when it rewrites `mine=1`, so "my work" still shows all
  three roles at once.
- **Ready lists review first**, then todo: the column reads furthest-along
  first, like QA.
- **Open keeps blocked above in-triage.** The request fixes only the ends
  (qa-rejected top, requested bottom); stuck work leads the middle.
- **Deploy empty state:** decided from the filtered ticket lists, with the
  filter bar still shown.
- **Tests:** the default-view test targets `filterCards`/`board()` with entries
  and no `view`; `tests/dashboard.test.ts:100` and the legacy-query string test
  are updated.
- **Smoke:** the column-region step and the filter step (`smoke.cjs:69`, `:373`)
  are rewritten for Open and the tabs default.
- **Known gap:** item pages don't carry `f`, so the Board link from an item page
  drops the filter.
