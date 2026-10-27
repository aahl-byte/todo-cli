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
   | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | the Jira bridge |
   | `S3_BUCKET`, `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | image paste/drop in requests and comments |
   | `GITHUB_TOKEN` | optional; the server-wide GitHub token, for repos of `TODO_PLUGIN_OWNERS` only: PR link status on private repos (read-only Pull requests, Checks and Commit statuses), git facts and plugins. A project that gives its own token on Settings → Automation uses that for all its repos instead. Only plugins shipped with todo receive either; a custom plugin's `github` goes without it |
   | `GITHUB_WEBHOOK_SECRET` | optional; GitHub webhooks (`push`, `pull_request`, `deployment_status`) at `/api/github/webhook` |
   | `GITHUB_API_URL` | optional; GitHub's REST base, for GitHub Enterprise |
   | `TODO_SECRET_KEY` | 32 bytes (`openssl rand -base64 32`) that encrypt the tokens set on Settings → Automation, repo connection credentials and secret settings; without it the page can't save any of them, and says so |
   | `TODO_PLUGIN_CONNECTIONS`, `TODO_PLUGIN_SECRET_<NAME>` | optional; server-wide default plugin connections as a JSON map, and their secrets. A project's own connection of the same name, set on Settings → Automation, replaces one for that project. Only shipped plugins use them, never a repo's custom plugins, and a repo's config can't take their names |
   | `TODO_PLUGIN_OWNERS` | optional; comma-separated GitHub owners whose repos `GITHUB_TOKEN` reads, and whose repos a member's CLI checkout brings into a project on its own. A repo added under Settings → Automation is the project's whatever its owner, read with the project's own GitHub token when this list leaves it out |
   | `TODO_PLUGIN_ALLOW_HOSTS` | optional; comma-separated hosts plugins may reach on a loopback, private, link-local, CGNAT or unique-local address, which the server otherwise refuses. `host[:port]` opens one to every project's host connections, which shipped plugins use; `owner/name=host[:port]` opens it to the connections that repo's config declares, e.g. `acme/web=leaf-rain:10011`. Without an entry, Settings → Automation asks before it saves a project's connection on a private address, such as Watchtower at `127.0.0.1:10010`, and allows it for that connection alone |
   | `NEXT_BASE_PATH` | optional; serves the dashboard under a path such as `/todo-bishs`, at build and start, with `PORT` set to the server's port. The CLI's `/api` stays at the root |

   A GitHub token is the real limit on what todo can read, the server's or a
   project's: give a fine-grained token, or a GitHub App installation, scoped to
   the team's repos only, with read access to contents, pull requests and checks.

4. **Create the schema, then users and projects**, from your machine with the
   same `DATABASE_URL`:

   ```bash
   cd server && npm install
   DATABASE_URL=... npm run migrate                 # idempotent; run on every deploy
   DATABASE_URL=... npm run user:add -- pat --name "Pat (PM)" [--jira <accountId>]
   DATABASE_URL=... npm run project:add -- web "Web app"
   ```

   `user:add` prints the token that user signs in with in the dashboard.
   Running it again for the same handle issues a new token.

   `todo login <url>` signs a CLI in through the browser: `POST /api/login/start`
   returns a code, a signed-in user approves it at `/login/device`, and
   `POST /api/login/poll` hands the CLI a token of its own (`api_tokens`, one
   per device, revocable under `/devices`). Behind a sign-in gate, leave
   `/api/` open and everything else gated: approval needs the dashboard
   session, and the two login routes allow at most 25 requests waiting.

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

`/display/<project>` shows a project's board, refreshing every minute, for a
screen nobody signs in on. Its cards open the full item page, read-only, and it
shows the pins of whoever set it up. It takes a display key, not a user token,
and a key opens one project's display and nothing else.

**Set one up** on the device itself: sign in, open `/displays` (also under the
user menu) and pick a project. The device keeps its key for a year, in a cookie
sent only to `/display/`. The same page lists every display, when each was last
seen, and removes one.

From a shell, `npm run display -- add <project> <label>` prints a link that sets
up whichever browser opens it; `list` and `remove <project> <label>` match the
page.

Behind a sign-in proxy, let `<base>/display/` and `<base>/_next/static/`
through without sign-in; a display loads everything else, images included,
under its own path.

## Jira bridge

The bridge mirrors the Jira issues a project's items link with `todo jira link`,
from any Jira project. It never imports issues as items.

- **Request:** each linked issue is appended once to its item's request as a
  `## KEY · <summary>` block with the description and images. Appending follows
  the request-version rules: a frozen request gets a new version, which returns
  the item to `requested`.
- **Comments** mirror onto every item linking the issue, edits included.
- **Status:** a linked issue's status shows next to its key and never moves the
  item.
- **Triggers** on the settings page run the other way: a todo move transitions
  every issue the item links. They reach Jira only once the project switches
  writes on, on a server without `JIRA_READ_ONLY`; until then the page lists
  what they would have sent. No comments go to Jira.

**Poll Jira**, read-only, from a timer every few minutes:

```bash
DATABASE_URL=... JIRA_BASE_URL=... JIRA_EMAIL=... JIRA_API_TOKEN=... npm run jira:sync -- --all
```

`jira:sync -- --all` runs one pass over every project and exits non-zero if any
failed. `jira:sync -- <project>` polls one project, `--every SECONDS` keeps
polling, and `--create-users` makes a user for each Jira person it meets.
Polling always runs with `JIRA_READ_ONLY=1`.

**Link people:** `npm run user:jira -- <handle> <accountId>` for an existing user
(their token is kept), or `user:add -- <handle> --jira <accountId>` when creating
one. Unmatched Jira users show up as `jira:<Display Name>`.

The outbox flushes after every request. The cron in `vercel.json` retries
daily, which Hobby plans allow; on Pro, set it to `*/5 * * * *`.

## Plugins and git facts

Both need a GitHub token for the repo: the project's own, given on Settings →
Automation, or `GITHUB_TOKEN` for a repo of `TODO_PLUGIN_OWNERS`.

- **Connect the services** on the project's Settings → Automation. A row that
  needs one asks for it in place: GitHub, Vercel, Jira, Watchtower and
  db-request start with their usual address and auth, and link to where their
  token is made. A web-request button's connection can be added from its own
  settings. todo keeps each in `project_connections`, its token encrypted for
  the address it was given for, so pointing it elsewhere drops the token. A
  private address saves only once someone allows it there, which records who
  and when. Only shipped plugins use these connections; the CLI never receives
  their tokens, so an instance that needs one runs on the server.

- **Set each repo up** on the project's Settings → Automation: its deploy
  branches, the shipped plugins switched on, custom plugins (YAML, with an
  optional sandboxed JavaScript `code:`) and the connections they call, and
  each plugin's instances. The server stores all of it per project and repo
  (`plugin_configs`, `plugin_custom`, `plugin_instances`) and reads nothing of
  the repo but its branches, commits and pull requests. The CLI gets the same
  config through `GET /api/projects/<key>/plugins?repo=owner/name`. Design:
  `docs/plans/2026-10-27-server-owned-plugins-design.md`.

- **Hear GitHub:** add a webhook on each repo (or the organization) to
  `<server>/api/github/webhook`, content type JSON, secret
  `GITHUB_WEBHOOK_SECRET`, with the `push`, `pull_request` and
  `deployment_status` events. Repos without one are polled.
- **Run the tick** every 5 minutes: `/api/plugins/tick` delivers queued runs,
  polls repos with no recent webhook and runs due `every:` plugins, and
  `/api/git-facts/tick` recomputes facts. Both take
  `Authorization: Bearer $CRON_SECRET`. The daily entries in `vercel.json` suit
  Hobby; on Pro set them to `*/5 * * * *`. Off Vercel, a systemd timer can
  `curl` both.
- **Port Actions and Jira triggers** to plugin instances:
  `npx tsx scripts/plugins-port.ts <project> [--repo owner/name]` prints the
  instances, and the connections, tokens and private addresses to set up on
  Settings → Automation; `--write` switches
  their plugins on in each repo and stores them. Every ported instance is
  stored in dry-run, so nothing sends twice while Actions and the Jira bridge
  still run.
- **Check parity before the cutover:**
  `npx tsx scripts/plugins-parity.ts <project> [--since 7d]` replays recent
  status moves through Actions, the Jira outbox and the ported instances, all
  in dry-run, and prints every difference. The cutover is turning Actions and
  Jira triggers off, then clearing each instance's dry-run switch.

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
on plain-http hosts. Its plugin steps need the demo repo `acme/web` allowed and
a secret key, so start that server with
`TODO_PLUGIN_OWNERS=acme GITHUB_TOKEN=demo TODO_SECRET_KEY=$(openssl rand -base64 32) TODO_PLUGIN_ALLOW_HOSTS=acme/web=hooks.example.com`,
and no plugin connection in its environment: the smoke connects Vercel, a
web-request endpoint and a private address on the page.
