# Jira rich text and images, on a local S3

**Date:** 2026-10-05 · **Builds on:** `2026-10-05-jira-live-read-only.md`

## Goal

You can check each of these on the mirror at `http://leaf-rain:3940`:

- **Rich text:** a mirrored request or comment keeps Jira's links (clickable),
  inline code, bold, italics, headings, lists, code blocks and tables.
- **Images:** images pasted into a Jira description or comment show inline,
  served from a local S3 (MinIO) on this server.
- **Other files:** a non-image file referenced in the text shows as a link to
  the file in Jira.
- **Pasting:** an image pasted into a request on the mirror uploads to the same
  S3 and shows, which proves the browser path to the bucket.

## 1. ADF → Markdown (`lib/jira/adf.ts`)

`adfToMarkdown(doc, media?)` replaces `adfToText` on the way in (webhook and
sync). `adfToText` stays for outbound. The new converter's output, node by
node:

| ADF | Markdown |
|---|---|
| `text` + `link` mark | `[text](href)` (`<href>` when text = href) |
| `text` + `code` / `strong` / `em` / `strike` marks | `` `t` `` / `**t**` / `*t*` / `~~t~~` |
| `heading` (level n) | `#`×n + text |
| `bulletList` / `orderedList` | `- ` / `1. ` with nesting indented 2 spaces per level |
| `codeBlock` (language) | fenced block with the language |
| `blockquote` | `> ` prefixed lines |
| `rule` | `---` |
| `table` | GFM table; the first row is the header; cell pipes and newlines escaped |
| `inlineCard` / `blockCard` / `embedCard` | `<url>` |
| `mention` | `@Name`, as now |
| `media` (in `mediaSingle`/`mediaGroup`/`mediaInline`) | `![alt](url)` from the `media` map, keyed by the media `alt` filename; a file with no image copy becomes `[📎 name](jira attachment url)`; unknown becomes `[📎 name]` |
| `textColor`, `date`, `status`, `emoji` | text only, as now |

- **Code is literal:** text inside a `code` mark or a code block isn't
  Markdown-escaped.
- **Plain text is escaped,** so it isn't read as Markdown: leading `#`, `-`,
  `>` or `1.` at the start of a line, and stray `*`, `_` or backticks.

## 2. Local S3: MinIO (docker)

- **Container:** `todo-minio`, `minio/minio`, restart unless-stopped, data in a
  named volume.
- **Ports:** API 9000 is bound to `127.0.0.1` and the Tailscale address
  (`100.85.84.68`), so the browser reaches it as `http://leaf-rain:9000` and
  nothing else on the LAN does. Console 9001 on `127.0.0.1` only.
- **Bucket:** `todo-files`, private, created with `mc` in a one-off container.
  Root credentials are generated and kept in the gitignored root `.env`
  (`S3_*` and `AWS_*`).
- **App config, new to `lib/files.ts`:**
  - `S3_ENDPOINT`: the server's own calls, `http://localhost:9000`
  - `S3_PUBLIC_ENDPOINT`: the endpoint for presigned URLs the browser follows,
    `http://leaf-rain:9000`. It defaults to `S3_ENDPOINT`.
  - `S3_FORCE_PATH_STYLE=1`, which MinIO needs
  - With none set, behaviour is unchanged (AWS).
- **New `putObject(key, bytes, contentType)`:** server-side saves, to S3 or
  local.
- **CORS:** MinIO allows browser POSTs from any origin by default, so it needs
  no bucket rule. The smoke paste step proves it.

## 3. Jira attachments → our store (`lib/jira/media.ts`)

- **New table `jira_files`:** `(project, attachment_id primary key, issue_key,
  filename, file_key, mime)`. `file_key` is null for files we don't copy.
- **`mirrorAttachments(db, jira, project, itemUid, issue)`:** for each entry in
  `issue.fields.attachment` with no `jira_files` row:
  - **Images** (png, jpeg, gif, webp, ≤ 10 MB) are downloaded with
    `GET /rest/api/3/attachment/content/<id>` (redirects followed) and saved
    with `putObject` under `newKey(project, itemUid, mime)`.
  - **Everything else** records a row with no `file_key`.
  - Afterwards it returns the media map for the converter:
    - each image filename → `/api/files/<key>`
    - each other file → its Jira URL, `<base>/rest/api/3/attachment/content/<id>`
      (opens with the viewer's own Jira session)
- **Sync:** `attachment` joins the search fields. The sync mirrors an issue's
  attachments before its request and comments are written, and on later passes
  for linked issues that changed.
- **Inbound (webhook and replay):** `created`, `changedRequest` and `commented`
  build the media map from `jira_files` for the issue. In the poll path, sync
  has already filled `jira_files`.
- **Read-only:** downloads are GETs, which the client allows read-only.

## 4. Re-import

Recreate the mirror database and run the first pass again, so every existing
request and comment is converted. Comment op ids are unchanged, so later passes
stay idempotent.

## Acceptance

- **(js) `adfToMarkdown`:**
  - links, marks, headings, nested lists, code block, table and media,
    including a media alt with no map entry
  - escaping of plain text versus literal code
- **(js) sync with a fake Jira:**
  - an image attachment is downloaded once and its request shows
    `![name](/api/files/...)`
  - a PDF becomes a Jira link
  - a second pass downloads nothing
- **(js) `files.ts`:** `S3_PUBLIC_ENDPOINT` changes the presigned host.
- **(live)**
  - SR-5651's GitHub link and SR-5654's image render on the mirror, the image
    through `leaf-rain:9000`
  - an image pasted into a new request on the mirror shows after submit
  - every `media` node in the 191 issues resolves to an image or a link,
    checked by a script over the database
- **(smoke)** the existing smoke run stays clean on the demo build, which uses
  local files.

## Revisions after the plan audit

These override the sections above where they differ.

- **Renderer:** `components/Markdown.tsx` moves to `react-markdown` +
  `remark-gfm`, for headings, GFM tables, nested lists, blockquotes, strike and
  fences with blank lines.
  - No raw HTML.
  - Links: only `http(s)` and `mailto`, opening in a new tab.
  - Images: only `http(s)` or `/api/files/<KEY_RE>`.
  - `oneLine` keeps inline elements only.
- **Converter output:** no backslash escaping of plain text. Bare URLs instead
  of `<url>` autolinks. Hrefs get `)` and spaces percent-encoded, `]` is
  stripped from link text, and a code span containing a backtick uses double
  backticks.
- **Images keyed by Jira media id.** The converter always emits
  `![alt](/api/files/<project>/<itemUid>/<jiraUid("media", id)>.<ext>)` for
  image media, so a note never freezes as a placeholder. A failed download is
  retried on the next pass.
  - The extension comes from `alt`, with png when unknown.
  - `type: "external"` media use their `attrs.url`.
  - Non-image media link to `<base>/secure/attachment/<attId>/<name>`, using
    the attachment id learned from the redirect; otherwise they show as
    `📎 name`.
- **Attachment discovery:** `JiraClient.download(path)` sends `accept: */*`
  with `redirect: "manual"`. The `Location` holds the media UUID, which ties
  each attachment to its media id. The bytes are then fetched from `Location`,
  whose URL carries its own token.
  - `jira_files(project, attachment_id pk, media_id, filename, mime, file_key)`
    records what has been fetched.
  - An image whose object is missing is fetched again.
- **Local S3 is SeaweedFS** (`chrislusf/seaweedfs`, container `todo-s3`).
  MinIO no longer publishes public images.
  - The credentials are scoped to the `todo-files` bucket.
  - The API is on `127.0.0.1:9000` and `100.85.84.68:9000` (tailnet). If
    tailscaled isn't up when docker starts, the tailnet bind fails until the
    container restarts.
  - Presigning uses a second client on `S3_PUBLIC_ENDPOINT`.
- **Known limits:** comments edited in Jira after import don't update, which
  is already true. Files attached but not referenced in the text don't show.
