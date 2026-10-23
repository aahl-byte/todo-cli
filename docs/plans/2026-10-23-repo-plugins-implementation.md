# Repo plugins, git facts and the docs store — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Build everything in `2026-10-23-repo-plugins-git-facts-docs-design.md`
so its seven acceptance checks pass, with tests on both the CLI and the server.

**Architecture:** The CLI (Python, `todo/`) and the server (Next.js +
Postgres, `server/`) each gain branches, the docs store, git facts and a
plugin runner. Plugins run in one TypeScript host (`server/lib/plugins/`),
which the server imports and the CLI runs as a bundled Node script. Results
come back as attachments that each side writes into its own store; the sync
protocol carries them like hand-made notes.

**Tech Stack:** Python 3.9+, ruamel.yaml, pytest; Next.js 16, React 19,
Postgres/PGlite, vitest; new: `jmespath`, `yaml`, `@modelcontextprotocol/sdk`,
`quickjs-emscripten` (asyncify variant), `esbuild` (dev, bundles the host for
the CLI).

---

## Ground rules for every task

- Work in the worktree `/mnt/rain/git/todo-plugins` (branch
  `feat/repo-plugins`), or in a sub-worktree branched from it when told. Never
  edit `/mnt/rain/git/todo`: the machine's `todo` CLI and the bishs server run
  from it.
- Python tests: `cd /mnt/rain/git/todo-plugins && python -m pytest -q`
  (baseline: 334 passed, 7 skipped). Server tests:
  `cd /mnt/rain/git/todo-plugins/server && npx vitest run` (baseline: 265
  passed, 1 skipped) and `npx tsc --noEmit`.
- TDD: write the failing test first, run it, implement, run everything, commit.
  Small commits with `feat:`/`fix:`/`test:`/`docs:` subjects, matching
  `git log`.
- Match the surrounding code: its naming, comment density (sparse, one-line
  intent comments), file layout and test style. No comments that narrate
  history or reference tickets.
- CLI and server mirror each other's vocabulary (`todo/store.py` ↔
  `server/lib/model.ts`). A constant added on one side is added on the other.
- Deterministic uids use the existing scheme: `sync._hash_uid(*parts)` in
  Python (`"Z" + base32(sha1(parts joined by "\x1f"))[:25]`); add the same
  function to the server as `hashUid(...parts)` in `server/lib/ulid.ts`.
- Do not touch the running services, the bishs database, or `~/.todo` outside
  tests. Tests use temp dirs, PGlite and `tests/fake_server.py`.

## Contracts shared across tasks

These are fixed so tasks can run in parallel.

**C1 · Branches.** `TODO.yaml` holds `branches: [feat/x, …]` (omitted when
empty). Reading an item with a legacy `branch:` and no `branches:` yields
`[branch]`; the first write rewrites it as `branches`. Items carry
`"branches": list[str]` in Python and `extra.branches` on the server (synced
through `extra.*` like every non-core key). `{{item.branch}}` in Action
templates is the first branch.

**C2 · Plugin attachments.** A run returns
`{attached: Attachment[], wouldSend: Call[], log: string[], skipped?: string, error?: string}`.

```ts
type Attachment =
  | { kind: "link"; key: string; type: string; url: string; label?: string }
  | { kind: "edge"; key: string; needs: string; in?: string; because: string }   // needs: "item:<id>" | "branch:<name>" | a PR URL
  | { kind: "doc"; key: string; name: string; content?: string; url?: string }  // url: fetched through the connection
  | { kind: "log"; key: string; text: string }
  | { kind: "request"; key: string; text: string };                              // needs the post-request grant
```

Each side writes them as: `link` → note kind `link` (meta `url`, `type`,
`label`); `edge` → note kind `dependency` (meta `needs`, `in`, `because`);
`log` → dev-log entry; `doc` → a doc (task 4); `request` → a new request
version. Every written entity carries meta `plugin: <instance id>` and
`plugin_key: <key>`, and its uid is
`hashUid("plugin", instanceId, itemUid, key)`. A run replaces the instance's
previous set by key: add new, update changed, remove missing. A `link` whose
URL is already on the item from any other source is skipped and logged.

**C3 · Plugin definitions.** `.todo-plugins/plugins.yaml` in the repo, read
from the default branch:

```yaml
track: [staging, main]
connections:
  <name>: {http: {url: …, auth: bearer|basic|"header:X-Api-Key"}} | {mcp: {url: …} | {command: …, args: […]}}
plugins:
  <name>:
    connections: [<name>, …]
    on: [push, pr, deployment, manual, {status: {from: …, to: …}}]
    every: 15m
    exclusive: false
    capabilities: [post-request]            # shipped plugins only
    settings: {<key>: {label, type, default?, optional?, options?, options_from?, scope?}}
    per: branch | jira                      # YAML body
    when: <jmespath>
    steps: [{name?, when?, connection?, tool?, input?, http?: {method, path, query?, body?}, value?}]
    attach: [{each?, when?, link|edge|doc|log|request: {…}}]
    code: <file>.js                          # code body instead of per/steps/attach
instances:
  <plugin>: [{id, name, enabled?, on?, button?, dry_run?, settings: {…}}]
```

Shipped plugins live in `server/lib/plugins/shipped/` and are enabled by name
from a repo file (`plugins: {vercel-preview: {use: shipped}}`), except
`pr-link`, which every repo gets.

**C4 · Host entry point.** `runInstance(input): Promise<RunResult>` in
`server/lib/plugins/host.ts`, where `input` is
`{plugin: PluginDef, code?: string, instance, item, event, connections: Record<string, ResolvedConnection>, dryRun: boolean, limits?}`.
The CLI calls the bundled host as `node todo/plugin_host.mjs` with that JSON
on stdin and reads the `RunResult` JSON from stdout.

**C5 · Item JSON given to plugins.** `{id, uid, title, type, status, priority,
repo, repo_owner, repo_name, branches, jira, app, section, developer,
qa_assignee, dir}` plus `links: [{type, url}]`.

## Waves

Tasks in a wave run in parallel, each in its own sub-worktree branched from
`feat/repo-plugins`; the orchestrator merges them before the next wave.

- **Wave 1:** Task 1 (branches + handoff force), Task 2 (plugin host),
  Task 4 (docs store).
- **Wave 2:** Task 3 (git facts), Task 5 (CLI plugin runner),
  Task 6 (server plugin runner).
- **Wave 3:** Task 7 (Plugins dashboard), Task 8 (shipped plugins and ports),
  Task 9 (retire Jira import mode).
- **Wave 4:** Task 10 (skill, README, version, full verification).

---

### Task 1: Branches list and the agent-handoff `--force`

**Files:**
- Modify: `todo/store.py` (`_to_item`, `update_todo`), `todo/cli.py`
  (`TRACKED_FIELDS`, `set`, new `branch add|rm`, `_check_transition`),
  `todo/render.py:91`, `todo/actions.py:46`, `todo/sync.py` (only if the
  `extra.branches` round trip needs it)
- Modify: `server/lib/views.ts:114-121`, `server/lib/apply.ts:269,630`,
  `server/lib/actions/model.ts` (template `item.branch`), any dashboard code
  reading `extra.branch` (`grep -rn "extra?.branch\|extra.branch" server`)
- Test: `tests/test_branches.py`, `tests/test_team_lifecycle.py`,
  `server/tests/apply.test.ts`, `server/tests/dashboard.test.ts`

**Behaviour:**
1. `todo branch add <q> <name>` appends (no duplicates); `todo branch rm <q> <name>`
   removes; both print the resulting list. `todo set <q> branch <v|none>`
   replaces the list with `[v]` or clears it.
2. `todo get` prints `branches:  owner/repo · feat/x, feat/y` (`—` when empty).
3. Legacy `branch:` reads as `branches: [branch]` and is rewritten on the next
   write (C1). Search and the board read every branch.
4. An agent moving an item to `ready-for-qa` is refused unless `--force`;
   with it, the CLI sends the op with `force: true`, the server accepts it, and
   the history row has `forced: true`. A person never needs `--force`.

**Tests first:** legacy read; add/rm idempotence; `set branch none`; sync round
trip of `extra.branches` through `tests/fake_server.py`; server apply accepting
`ready-for-qa` from an agent only with `force`; views search matching a second
branch.

**Commit:** `feat: items list several branches (todo branch add|rm)` and
`feat: --force lets an agent hand an item to QA`.

---

### Task 2: Plugin host (TypeScript)

**Files:**
- Create: `server/lib/plugins/{types.ts,template.ts,expr.ts,yaml-runner.ts,code-runner.ts,connections.ts,host.ts,cli-entry.ts}`
- Create: `server/scripts/build-plugin-host.mjs` (esbuild →
  `todo/plugin_host.mjs`, single file, QuickJS wasm inlined)
- Modify: `server/package.json` (deps + `build:plugin-host` script),
  `pyproject.toml` (package data `plugin_host.mjs`)
- Test: `server/tests/plugins-host.test.ts`, `server/tests/plugins-conformance.test.ts`,
  `server/tests/fixtures/plugins/*.yaml`

**Behaviour:**
1. **Templates** (`template.ts`): `{{path}}` resolves a dotted path in the
   scope; three fill modes: `json` (keeps types in `input`/`body`), `url`
   (URL-encodes in HTTP paths and query), `expr` (a quoted JMESPath raw-string
   literal with `'` and `\` escaped). Anything other than a path inside `{{ }}`
   is an error at load time.
2. **Expressions** (`expr.ts`): JMESPath via `jmespath`; truthiness follows
   JMESPath (empty list, empty object, `""`, `false`, `null` are false).
3. **YAML runner**: implements C3's `per`, `when`, `steps`, `attach` exactly as
   the design doc §4 describes; empty results never stop a run; a step names its
   `connection` when the plugin declares more than one.
4. **Connections** (`connections.ts`): `http` (fetch with base URL, auth from
   the resolved secret, JSON in and out, a 15 s timeout) and `mcp` (the MCP SDK
   client over stdio or streamable HTTP; `call(tool, input)` returns the tool's
   structured content, else its JSON text content). `isReadOnly(call)`: HTTP
   `GET`/`HEAD`, or an MCP tool annotated `readOnlyHint: true`.
5. **Dry-run**: non-read-only calls return `null` and are recorded in
   `wouldSend`.
6. **Code runner**: QuickJS asyncify context, 32 MB memory, total deadline
   (default 60 s), exposes `item`, `event`, `settings`, one client per declared
   connection (`call`, `get`, `post`, `put`, `patch`, `delete`), `attach.*`,
   `wait.until(fn,{every,timeout})`, `wait.retry(fn,{when,attempts,every})`;
   the module exports `run`.
7. **Exclusive and triggers**: `pickInstances(plugin, instances, event)` returns
   the instances an event fires (status from/to with `*`, push, pr, deployment,
   manual by instance id); with `exclusive`, only the first.
8. **CLI entry** (`cli-entry.ts`): reads C4 JSON from stdin, writes the
   `RunResult` to stdout, exit 0 even when the run errored (the error is in the
   JSON), exit 2 on unreadable input.

**Tests first:** template modes including an injection attempt
(`x' || true || '` stays a string); `per: branch` fan-out; `when` on plugin,
step and attachment; named step results; dry-run recording a POST; an `http`
connection against a local `node:http` server; an MCP connection against an
in-process MCP server from the SDK; the Watchtower code plugin from the design
doc against a fake Watchtower (`live`, `resume`, `start`, `waiting` cases);
a code plugin that loops forever is stopped by the deadline; exclusive picking;
the bundled `todo/plugin_host.mjs` run with `node` on one fixture.

**Commit:** one per numbered behaviour where practical, then
`build: bundle the plugin host for the CLI`.

---

### Task 3: Git facts

**Files:**
- Create: `todo/gitfacts.py`, `server/lib/gitfacts.ts`,
  `server/app/api/projects/[key]/git-facts/route.ts`
- Modify: `todo/cli.py` (`get`, `list`, `stage`/`deploy` guards, new
  `deps [--from-checks]`), `todo/render.py`, `server/lib/schema.ts`
  (`git_facts` table), `server/lib/apply.ts` (stage/deploy guard),
  `server/components/item/Rail.tsx` and the board card (display)
- Test: `tests/test_gitfacts.py` (real git fixture repos in tmp dirs),
  `server/tests/gitfacts.test.ts` (recorded GitHub responses)

**Behaviour** (design §2):
1. **Landed-in** per item branch against the repo's `track:` list
   (from `.todo-plugins/plugins.yaml` on the default branch; none → no
   landed-in). Records head, PR number, base, merge commit.
2. **Depends on** between open item branches of one repo
   (`merge-base(A,B)` not in B's target), resolved through landed-in, stale
   when the dependency is cancelled/deferred or its PR closed unmerged.
   Plugin `dependency` notes (C2) join the same edge list.
3. **Conflicts with** (CLI: `git merge-tree --write-tree`), **overlaps with**
   (shared changed files). Hints only.
4. CLI stores facts in the item folder as `git.yaml` (ignored by sync's
   entity scan) and posts them to `POST /api/projects/:key/git-facts`; the
   server stores `git_facts(project, item_uid, data, computed_by, at)` and
   computes landed-in, depends-on and overlaps itself through the GitHub API
   (`GITHUB_TOKEN`), keeping CLI-only conflict results.
5. `todo stage` and `todo deploy` (and the server's status rule for
   `ready-to-deploy`/`deployed`) refuse while an unresolved edge exists;
   `--force` overrides and is recorded in history.
6. `todo deps <q>` prints needs/needed-by/conflicts/overlaps;
   `todo deps --from-checks` lists `prereq-branch` checks for review.
7. Recompute triggers: the CLI recomputes during a sync round when
   `git ls-remote` shows a moved tip (state in `.TODO/.sync/git-tips.json`, or
   `.TODO/.git-tips.json` for a local-only store) and on `todo refresh`.

**Tests first:** fixture repos for stacked (depends), cut-from-staging (none),
squash-merged dependency (resolves via landed-in), deleted branch after merge
(landed-in survives), conflicting edits (conflict), same-file non-conflicting
edits (overlap only), merge-promotion to main (flips ✓), squash-promotion
(stays ✗); stage refusing and `--force` passing.

---

### Task 4: Docs store

**Files:**
- Create: `todo/docs.py`, `server/lib/docs.ts`,
  `server/app/api/projects/[key]/docs/route.ts`,
  `server/components/item/Docs.tsx`, `server/components/DocView.tsx`
- Modify: `todo/cli.py` (`doc add|rm|path`, `docs`, `get` listing),
  `todo/sync.py` (doc entities + byte upload in the round),
  `server/lib/schema.ts` (`docs` table), `server/lib/files.ts` (doc keys and
  types), `server/components/item/ItemView.tsx`, `server/components/Markdown.tsx`
  (`doc:` references)
- Test: `tests/test_docs.py`, `server/tests/docs.test.ts`,
  `server/tests/markdown.test.tsx`

**Behaviour** (design §6): docs in `<item>/docs/`; `todo doc add` (file or
`-`, `--name`), `todo docs`, `todo doc path`, `todo doc rm`; sync uploads
changed bytes (sha256) and records `docs(project, uid, item_uid, name, size,
sha256, file_key, by, at)`; a stale base hash is a conflict that saves
`<stem>.conflict-<who><ext>` locally; the dashboard Docs section lists docs,
uploads, replaces and deletes, and renders by type (Markdown via the notes
renderer, HTML in `<iframe sandbox="allow-scripts" srcdoc>`, JSON
pretty-printed, code highlighted by extension with `highlight.js`, images,
PDF, audio, video); `doc:name` in notes links the doc. Limit 25 MB per doc.
Bytes use the existing S3/local-files backend (`server/lib/files.ts`).

**Tests first:** add/list/path/rm; edit in place then sync uploads the new
hash; two-writer conflict producing the conflict copy; server route auth and
project scoping; renderer choice per extension; `doc:` link rendering.

---

### Task 5: CLI plugin runner

**Files:**
- Create: `todo/plugins.py`, `todo/connections.py`
- Modify: `todo/cli.py` (`refresh`, `connection add|list|test|auth`,
  `plugin list|add|set|rm|test`), `todo/sync.py` (run due plugins after a
  round), `todo/render.py` (plugin labels, skip notices)
- Test: `tests/test_plugins_cli.py` (stub the host with a fake
  `plugin_host.mjs` that echoes canned results, plus one end-to-end run with
  the real bundle when `node` is present)

**Behaviour:**
1. Load C3 from the item's repo checkout (`checkouts` mapping the CLI already
   reports; else the current repo when its remote matches) via
   `git show origin/<default>:.todo-plugins/plugins.yaml`; `--local` reads the
   working tree for `todo plugin test`.
2. Connections: repo-declared + `~/.todo/connections.yaml`; credentials in
   `~/.todo/credentials.json` (mode 0600) keyed `<repo>/<connection>`;
   `todo connection auth <name> [--server]` prompts hidden input and with
   `--server` posts it to the server (task 6 route).
3. Instances: synced store → fetched from the server and cached in
   `.TODO/.sync/plugins.json`; local-only → `.TODO/.plugins.yaml`.
4. Run: build C5 item JSON, resolve connections (skip with a notice when one
   is missing or unauthorized), call the host (C4), write attachments (C2)
   into the store, so the next round syncs them.
5. Triggers: after each sync round (or each command on a local-only store),
   run instances whose events fired since the last tips check (`push` from
   `ls-remote` tip changes, `status` from the command's own moves) or whose
   `every` elapsed; `todo refresh [<q>]` runs everything due now;
   `todo action`/manual instances run with `todo plugin run <q> <instance>`.
6. No `node` on PATH: plugins skip with one notice per command.

---

### Task 6: Server plugin runner

**Files:**
- Create: `server/lib/plugins/server.ts` (definition loading, instance store,
  credential store, apply attachments), `server/app/api/projects/[key]/plugins/route.ts`
  (instances GET/PUT for CLI and dashboard), `server/app/api/projects/[key]/plugins/credentials/route.ts`,
  `server/app/api/github/webhook/route.ts`, `server/app/api/plugins/tick/route.ts`
- Modify: `server/lib/schema.ts` (`plugin_instances`, `plugin_credentials`,
  `plugin_runs`, `plugin_defs` cache), `server/lib/apply.ts` (status moves
  enqueue `status` events; `post-request` grant check), `server/vercel.json`
  (cron for tick)
- Test: `server/tests/plugins-server.test.ts`

**Behaviour:**
1. Definitions: fetch `.todo-plugins/` from the repo's default branch through
   GitHub (`GITHUB_TOKEN`), cached by commit sha in `plugin_defs`.
2. Credentials encrypted with AES-256-GCM under `TODO_SECRET_KEY`; never
   returned by any route.
3. Runs are queued in `plugin_runs` (like `action_runs`), delivered after the
   request and by the tick, leased, with the run log kept on the row.
4. Attachments are applied with `applyOps` as a `plugin` actor (C2 uids), so
   they reach every CLI.
5. Webhook: verifies `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`, maps
   `push`/`pull_request`/`deployment_status` to items through the
   `(repo, branch)` index, enqueues runs and git-fact recomputes.
6. Tick: polls repos without a webhook (ETag branch list) and runs `every`
   floors.

---

### Task 7: Plugins dashboard

**Files:** `server/app/(app)/p/[key]/settings/plugins/page.tsx`,
`server/components/PluginsSettings.tsx`, `server/app/settings-actions.ts`,
`server/components/item/Rail.tsx`, `server/components/item/ItemView.tsx`.

**Behaviour:** design §4 "Dashboard": per repo, plugins and instances with
on/off, forms generated from `settings:` (all setting types, `options_from`
filled through the connection), connection auth state with a credential form,
run log, dry-run toggle, tester; item page labels plugin attachments, shows a
button per `manual` instance and skip notices. Smoke steps added to
`server/scripts/smoke.cjs`.

---

### Task 8: Shipped plugins and the Action/Jira ports

**Files:** `server/lib/plugins/shipped/{pr-link,vercel-preview,db-request,rest,watchtower-session,jira-transition,jira-issue}.yaml`
(+ `watchtower-session.js`), `server/scripts/plugins-parity.ts`, tests in
`server/tests/plugins-shipped.test.ts`.

**Behaviour:**
- `pr-link` over an `http` `github` connection (`GET
  /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all`).
- `vercel-preview` over `http` (`GET /v6/deployments?projectId&teamId&target=preview`,
  matched on `meta.githubCommitRef`).
- `db-request` against an `http` endpoint
  `GET /submissions?repo=&branch=` returning db-request's `status --json`
  shape; links each `pr_url` and adds an edge on it. It waits on db-request
  shipping that endpoint.
- `rest` reproduces `rest` Actions; `watchtower-session` reproduces
  `deliver.ts`.
- `jira-transition` and `jira-issue` over `http` to Jira's REST API with basic
  auth, matching `server/lib/jira/*` behaviour; `jira-issue` uses
  `post-request`.
- `plugins-parity.ts` converts a project's Actions and `jira_outbound` into
  instances and runs both paths in dry-run over recent moves, printing any
  difference.

Retiring Actions and the links-mode bridge waits on parity against real data
and is not part of this plan.

---

### Task 9: Retire Jira import mode

**Files:** `server/lib/jira/*`, `server/scripts/jira-*.ts`, tests.
Remove import-mode code paths (issue import, status mirroring, inbound status
sets and transition rules) and their tests; `jira_mode` keeps only `links`.
The SR mirror services are stopped at merge time.

---

### Task 10: Skill, README, verification

- `todo/skill/SKILL.md`: branches, docs, plugins, deps, `--force` handoff
  rule; bump `version:` (minor).
- `README.md` and `server/README.md`: the new commands, env vars
  (`TODO_SECRET_KEY`, `GITHUB_WEBHOOK_SECRET`), webhook setup.
- Full Python and server suites, `tsc`, the bundle build, and the smoke suite
  against a seeded PGlite server.
