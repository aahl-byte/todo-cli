# Round 3b: request fields, link types, phase titles, related tickets

**Date:** 2026-10-04 · **Builds on:** `2026-10-04-dashboard-round-3.md`

## Goal

You can check each of these:

- A request names the app it's about and the section of that app. It can carry
  the URL where the problem shows, and photos pasted or dropped into its
  description. The photos are stored in S3.
- Links can be typed `external-ticket`, `bug-ticket`, `documentation` or
  `design`, as well as the existing types.
- Each phase of an item can have a title, set from the CLI or the dashboard and
  synced between them.
- An item can be linked to other items as related work. The link shows on both
  items, with each one's live status.

## 1. App and section

**Model.** Every item gets two new fields, `app` and `section`. Both are plain
text and optional, and they belong to the item, so a new request version
doesn't change them.
- **Server:** new `app` and `section` columns on `items`. Both are settable and
  versioned per field, like `priority`.
- **CLI:** new keys `app` and `section` in `TODO.yaml`. Sync carries them, and
  `todo get` shows them.
- **Commands:** `todo add … --app A --section S`, and `todo set <q> app|section
  <value>` (`none` clears the value).

**Choices.** A project can keep a catalog of apps and their sections in
`projects.apps` (jsonb, `{"web": ["checkout", "login"], "admin": []}`). It is
set with `npm run project:apps -- <key> <json>`. Pickers offer the catalog plus
every value already in use, and a typed value is always accepted. There's no
settings UI this round.

**Dashboard.**
- The request form gains app and section pickers. The section picker narrows to
  the chosen app's sections.
- The rail's Details section shows both fields, editable with the same pickers.
- Board cards show `app · section` faintly under the title.

## 2. Request URL and photos

**URL.** The request form gets an optional URL field, labelled "where it
happens". The URL belongs to the request version as `meta.url`. A new version
starts from the previous version's URL, and the URL is part of the diff. The
request view shows it as a link above the text. The server accepts only
`http(s)` URLs.

**Photos.**
- **Adding:** paste or drop an image into the request editor, in either the
  form or the new-version popup. The editor uploads it and inserts
  `![name](/api/files/<key>)` at the cursor. A placeholder line shows while the
  upload runs.
- **Upload path:** `POST /api/files` (signed in) returns a presigned S3 `PUT`
  URL and the key. The browser uploads straight to S3, so the photo never
  passes through Vercel's 4.5 MB request limit.
  - **Allowed:** png, jpeg, gif and webp, up to 10 MB each.
  - **Key:** `<project>/<item uid or "new">/<ulid>.<ext>`.
- **Reading:** `GET /api/files/<key>` checks the session and redirects to a
  presigned `GET` that lives 5 minutes, so the bucket stays private.
- **Config:** `S3_BUCKET`, `S3_REGION`, and the standard AWS credential
  variables.
- **Without S3:** when `S3_BUCKET` is unset, both routes fall back to a local
  directory (`TODO_FILES_DIR`, default `.files/`), so dev and the demo work.
- **Markdown:** the renderer also allows images whose `src` starts with
  `/api/files/`.
- **CLI:** shows the markdown as it is. `todo get` turns `/api/files/` paths
  into absolute URLs from the linked server, so they can be opened.

## 3. Link types

- **New types:** `external-ticket`, `bug-ticket`, `documentation` and `design`
  join `LINK_TYPES` on both sides. `todo url --type` accepts them.
- **Rail tags:** `ticket`, `bug`, `docs` and `design`.
- **Add-link popup:** lists every type.

## 4. Phase titles

**Model.** A phase title is a property of the item: `phases: {"1": "Schema",
"2": "UI"}`. A phase with no tasks can still have a title, so a plan can be
laid out ahead of its tasks.
- **Server:** `items.phases` jsonb is synced field by field as `phases.<n>`,
  like `extra.<k>`. A `null` value clears a title.
- **CLI store:** each title is stored as a top-level `title:` key in
  `phase-N/TASKS.yaml`. A phase holding only a title gets a `TASKS.yaml` with
  `tasks: []`. The store maps the titles to and from `phases.<n>`.
- **CLI:** new `todo phase <q> <N> "<title>"` sets a title, and an empty title
  clears it. `todo tasks` and `todo get` print `phase 1 · Schema`.
- **Dashboard:** the Tasks group header reads `phase 1 · Schema`. Clicking the
  title edits it in place. A phase without a title shows a faint `name` affordance
  on hover.
- **Glance:** a phase capsule's tooltip shows the phase's title.

## 5. Related tickets

**Model.** A relation is a `link` note with `meta.type = "related"` and
`meta.item = <other item uid>`, in the same project. Notes already sync, so the
CLI needs no new entity.
- **Showing it:** the item view lists its own related links plus the reverse
  ones, meaning notes on other items whose `meta.item` is this item. The list
  is deduplicated, so linking A→B and B→A shows one row.
- **Rows:** each row shows the other item's status light, its title as a link,
  and its developer.
- **Removing:** a remove control on either side deletes the underlying note.
  The server lets anyone remove a `link` note.
- **Dashboard:** a new rail section, Related, sits above Links. Its `+` opens a
  popup that searches the project's items by title or id.
- **CLI:**
  - new `todo relate <q> <other>`, creating the note
  - new `todo unrelate <q> <other>`, removing it from whichever side holds it
  - `todo get` lists the related items, both directions, from the local store
- **Server validation:** `meta.item` must name an item in the same project,
  other than this one. Otherwise the server refuses with `bad-relation`.

## Acceptance

- **(js) App and section:**
  - the fields are settable and versioned
  - the catalog shows up in the request form's options
- **(js) Requests:**
  - `meta.url` must be `http(s)`
  - a new version's diff includes a URL change
- **(js) Files:**
  - `POST /api/files` refuses a bad type or size
  - local fallback: an upload, then a `GET`, returns the bytes
  - a `GET` without a session gets a 401
- **(js) Phase titles:** `phases.<n>` sets and clears, with per-key versions.
- **(js) Relations:**
  - the reverse lookup works
  - a self-relation or a relation to an unknown item is refused
- **(py):**
  - `todo phase` round-trips through `TASKS.yaml`
  - `todo relate` and `unrelate`
  - `todo add --app/--section` and `todo set`
  - the new link types
  - e2e: phase titles, app/section and relations sync both ways
- **(smoke):**
  - filing a request with app, section, URL and a pasted image, then seeing
    the image render
  - editing a phase title
  - relating two items and seeing the relation on both
  - nothing scrolls sideways at 400px

## Revisions after the plan audit

These override the sections above where they differ.

- **App and section live in `extra`.** They are stored as `TODO.yaml` keys
  `app:` and `section:`, and sync as `extra.app` and `extra.section`, each with
  its own field version. There's no new column and no catalog. Pickers offer
  the values already used in the project, and any typed value is accepted.
- **Phase titles are also in `extra`.** They are stored as `TODO.yaml`
  `phases: {"1": "Schema"}` with string keys, and sync as `extra.phases`, so a
  conflict covers the whole map. The CLI writes nothing into
  `phase-N/TASKS.yaml`.
- **One upload path, S3.** `/api/files` replaces `/api/upload` and Vercel Blob.
  The Composer moves to it, and `@vercel/blob` is dropped.
  - **Upload:** the server issues a presigned POST with a `content-length-range`
    of up to 10 MB and an exact `Content-Type` from the allowlist (png, jpeg,
    gif, webp; no SVG).
  - **Bucket CORS:** the README documents the rule that allows a browser POST
    from the dashboard origin.
  - **Local fallback:** `POST /api/files/<key>` writes under `TODO_FILES_DIR`.
    - Every key must match `^[\w-]+/[\w-]+/[0-9A-Z]{26}\.(png|jpe?g|gif|webp)$`.
    - Responses set `Content-Type` from the extension, plus `nosniff`.
    - The fallback refuses to run when `VERCEL` is set.
    - The read route is a catch-all, `[...key]`.
  - **Markdown:** a `/api/files/` image must match the same key pattern.
- **Request URL.**
  - `http(s)` is checked only on `ticket-request` notes, at create and set.
  - `saveRequest` takes the URL, and the new-version button enables when either
    the text or the URL changed.
  - `todo add --request … --url U` and `todo request … --url U` set it, and
    `todo get` shows it.
- **Relations are a new note kind, `relation`,** with `meta.item`. They are added
  to `NOTE_KINDS` on both sides, so no link consumer sees them.
  - **Reverse rows** carry the note's `versions` and `item_uid`, so the other
    side can remove them.
  - **Deleted items:** items can't be deleted, so a relation never dangles. A
    cancelled target shows its status light.
  - **`bad-relation`:** this reason joins sync's final set.
- **Link tags** show the type names directly.
