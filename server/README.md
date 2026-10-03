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
   | `BLOB_READ_WRITE_TOKEN` | image paste/drop in the dashboard (a Vercel Blob store) |

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

Every signed-in user can read and write every project. Access is team-wide by
design; there are no per-project roles.

## Jira bridge

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
Playwright against a seeded server.
