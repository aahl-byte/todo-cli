# todo server

The team side of `todo`: a Next.js app that holds the shared store in Postgres,
serves the sync API the CLI talks to, bridges Jira, and hosts the dashboard.
Design: `docs/plans/2026-10-02-team-store-design.md` and
`docs/plans/2026-10-02-dashboard-ui-design.md`.

## Deploy to Vercel

1. **Create a Postgres database** on any host Vercel can reach (Neon,
   Supabase, RDS…) and note its connection string.
2. **Import the repo in Vercel** with the root directory set to `server`.
3. **Set the environment variables:**

   | variable | needed for |
   |---|---|
   | `DATABASE_URL` | everything (use the pooled URL on serverless hosts) |
   | `CRON_SECRET` | the Jira retry cron (`/api/jira/flush`) |
   | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_SECRET` | the Jira bridge |
   | `JIRA_ACCOUNT_ID` | optional; the integration's own account, else fetched from `/myself` |
   | `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | image paste/drop in requests and comments |
   | `GITHUB_TOKEN` | optional; PR link status for private repos (read-only Pull requests, Checks and Commit statuses) |
   | `NEXT_BASE_PATH` | optional; serves the dashboard under a path such as `/todo-bishs`, at build and start, with `PORT` set to the server's port. The CLI's `/api` stays at the root |

4. **Create the schema, then users and projects**, from your machine with the
   same `DATABASE_URL`:

   ```bash
   cd server && npm install
   DATABASE_URL=... npm run migrate                 # idempotent; run on every deploy
   DATABASE_URL=... npm run user:add -- pat --name "Pat (PM)" [--jira <accountId>]
   DATABASE_URL=... npm run project:add -- web "Web app"
   ```

   `user:add` prints the token that user signs in with, in the dashboard and in
   `todo login`. Running it again for the same handle issues a new token.

   `migrate` refuses a database built from the pre-release schema (entity rows
   keyed by uid alone); recreate such a database.

**Images.** Pasted images upload from the browser straight to S3 through a
presigned POST, and are read back through `/api/files/…`, which checks the
session and redirects to a URL that expires after five minutes. The bucket stays
private. It needs the IAM rights `s3:PutObject` and `s3:GetObject`, and a CORS
rule that lets the dashboard post to it:

```json
[{ "AllowedOrigins": ["https://todo.example.com"], "AllowedMethods": ["POST"], "AllowedHeaders": ["*"] }]
```

**Jira and `qa-rejected`.** A project that doesn't map `qa-rejected` in its
Jira status map sends rejections to Jira as its `in-progress` status. Jira can't
tell the two apart then, so moving the issue to that status in Jira doesn't take
a ticket out of `qa-rejected`; map `qa-rejected` to its own Jira status for that.

Without `S3_BUCKET`, a local server keeps images under `TODO_FILES_DIR`
(default `.files/`). On Vercel, uploads stay off until S3 is configured.

Every signed-in user can read and write every project. Access is team-wide by
design; there are no per-project roles.

## Wall display

`/display/<project>` shows a project's board with no controls, refreshing every
minute, for a screen nobody signs in on. It takes a display key, not a user
token, and a key opens one project's board and nothing else:

```bash
DATABASE_URL=... NEXT_BASE_PATH=/todo-bishs npm run display -- add web tablet   # prints the link to open on the device
DATABASE_URL=... npm run display -- list
DATABASE_URL=... npm run display -- remove web tablet
```

Opening the link once stores the key in a cookie, scoped to `/display/`, for a
year. Adding the same label again replaces its key.

Behind a sign-in proxy, let `<base>/display/` and `<base>/_next/static/`
through without sign-in; the page needs the app's built assets and nothing else.

## Jira bridge

A project mirrors Jira in one of two modes, `projects.jira_mode`:

- **`import`** (the default) imports the active issues of the project's
  `jira_project` as items and mirrors their status, fields, comments and
  sub-tasks.
- **`links`** imports nothing. It mirrors only the issues its items link with
  `todo jira link`, from any Jira project, and needs no `jira_project`.

In both modes, each issue an item links is appended once to that item's request
as a `## KEY · <summary>` block with the description and images, and its
comments mirror onto every item linking it. Appending follows the request-version
rules: a frozen request gets a new version, which returns the item to
`requested`. A linked issue's status is shown next to its key and never moves
the item.

**Put a project in links mode** and poll it, read-only:

```bash
DATABASE_URL=... npm run project:add -- web "Web app"
DATABASE_URL=... npm run jira:mode -- web links          # or: import
DATABASE_URL=... JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... npm run jira:sync -- --all
```

`jira:sync -- --all` runs one pass over every links-mode project and exits
non-zero if any failed; run it from a timer every few minutes. `jira:sync --
<project>` polls one project in either mode, and `--every SECONDS` keeps
polling. Polling always runs with `JIRA_READ_ONLY=1`.

For import mode:

- **Map a project:** in SQL, set `projects.jira_project` to the Jira project key,
  and `jira_status_map` to `{"<todo status>": "<Jira status name>", ...}`.
- **Register a webhook** in Jira (System → Webhooks) for issue created, issue
  updated and comment created, pointed at
  `https://<host>/api/jira/webhook?secret=<JIRA_WEBHOOK_SECRET>`.
- **Link people:** `npm run user:jira -- <handle> <accountId>` for an existing
  user (their token is kept), or `user:add -- <handle> --jira <accountId>` when
  creating one. Unmatched Jira users show up as `jira:<Display Name>`.

The outbox flushes after every request. The cron in `vercel.json` retries
daily, which Hobby plans allow; on Pro, set it to `*/5 * * * *`.

## Local development

```bash
cd server && npm install
TODO_PGLITE=.pglite npm run seed:demo > tokens.json   # demo users pat/dev/qa + project "web"
TODO_PGLITE=.pglite npm run dev                       # http://localhost:3000, sign in with a token
npm test                                              # vitest on in-memory PGlite
TEST_DATABASE_URL=postgres://... npm test             # also runs the real-Postgres concurrency test
```

`TODO_PGLITE` runs Postgres in-process (WASM), so you don't need a database
server. `scripts/smoke.cjs` drives the dashboard through its main flows with
Playwright against a seeded server. Point `BASE_URL` at a real hostname rather
than localhost: browsers treat localhost as secure, which hides cookie problems
on plain-http hosts.
