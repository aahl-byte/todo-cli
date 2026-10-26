# Repo plugins, git facts and the docs store

**Date:** 2026-10-23 · **Status:** proposed · **Builds on:**
`2026-10-08-actions-design.md`, `2026-10-05-jira-settings-and-event-rules.md`

## What it gives you

An agent working an item stops linking things by hand. Once an item lists its
branches, todo finds the rest itself and keeps it current, in the CLI (synced or
local-only) and on the dashboard:

- **PRs.** Each branch's PR is linked within one sync round of its opening.
  Its state, checks and unresolved threads show as they do now.
- **Where the work landed.** Each branch shows which tracked branches hold its
  merged code, `in staging ✓ · in main ✗`. This survives deleting the branch.
- **Dependencies between branches in flight.** An item whose branch carries
  another item's unlanded commits shows "depends on" that item, and `todo stage`
  and `todo deploy` refuse until the dependency lands. Real conflicts and shared
  files show as hints that block nothing.
- **Anything a repo adds.** A repo can turn on plugins, such as Vercel previews
  or db-request entries, or write its own. They attach links, docs and edges,
  and never change the item.
- **Docs that don't go missing.** A design, plan or handoff written for an item
  lives in the item, renders on the dashboard, and syncs with the store.

Actions and the Jira bridge move onto the same plugin system. That takes
Watchtower out of todo's core and leaves Jira as plugins only.

## Acceptance checks

1. On a synced rosm item with `branches: [feat/x]`, opening a PR for `feat/x`
   links it on the item, in `todo get` and on the dashboard, with no `todo url`
   call. Linking the same URL by hand adds nothing.
2. After that PR merges into `staging` and `feat/x` is deleted, the item shows
   `in staging ✓ · in main ✗`. Merging `staging` into `main` flips `main` to ✓
   on the next push event.
3. An item on `feat/y`, cut from `feat/x` before it merged, shows "depends on"
   the first item. `todo stage` refuses it until `feat/x` lands in `staging`;
   `todo stage --force` goes through and history records the force.
4. With `.todo-plugins/plugins.yaml` on rosm's default branch enabling
   `vercel-preview`, a branch's preview link appears after the
   `deployment_status` webhook fires. A repo without that file runs only the
   default plugins.
5. The same repo file gives the same attachments whether the CLI ran it (on a
   local-only store) or the server did.
6. `todo doc add <q> plan.md` makes the doc appear on the item page rendered.
   Editing `todo doc path <q> plan.md` in place and syncing updates it.
   YAML, CSS and JSON docs render highlighted, JSON pretty-printed.
7. rosm's Jira triggers and its two Actions run as plugin instances, with the
   same results, and the dashboard's Plugins page shows their settings, run log
   and dry-run output.

## 1. Branches

An item's single `branch` field becomes a **`branches` list**. An item can span
several feature branches in its repo.

```bash
todo branch add <q> feat/x
todo branch rm <q> feat/x
```

`todo set <q> branch` keeps working for one release as an alias for replacing
the list with one branch. Existing items migrate on first read: a non-empty
`branch` becomes a one-element `branches`. The server column and the sync ops
change the same way, and Action templates keep `{{item.branch}}` as the first
branch until Actions retire.

The server keeps an index from `(repo, branch)` to items, updated whenever an
item's branches change. Every git event below starts with that lookup.

## 2. Git facts

todo computes four facts from git. They're built in, not plugins, because each
one compares branches across the project instead of asking about one item.
None of them can be set by hand. Each item stores its facts as derived data,
like `calc-status`: a `git.yaml` in the item folder on the CLI and a table on
the server, synced read-only.

### Landed-in

A repo lists the branches it tracks:

```yaml
# .todo-plugins/plugins.yaml
track: [staging, main]
```

While an item's branch exists, each refresh records its head commit and its
PR. When the PR merges, todo records the PR's `base` and `merge_commit_sha`.
That commit is what reached the base for every merge method (the merge commit,
the squash commit, or the last rebased commit), and GitHub keeps it after the
branch is deleted.

The branch is **in** a tracked branch once that commit is an ancestor of the
tracked branch's tip. The CLI asks local git
(`git merge-base --is-ancestor <sha> origin/main`); the server asks GitHub's
compare API (`compare/<sha>...main` is `ahead` or `identical`). Results are
cached by the pair of commits.

This is a git fact, not a deploy state. Promotions that squash or cherry-pick
break ancestry, so the check would stay ✗; merging promotions keep it true.
A branch that never had a PR uses its last recorded head commit instead.

### Depends on

Each item branch B has a **target**, T(B): where its work is headed.

- With an open PR, follow the PR's base. A base that another open item's
  branch owns hands off to that branch's own target; stop at a branch no open
  item owns. That branch is T(B) when it's on the remote. In a repo with no
  `track:` list, a base nothing tracks adds a hint that blocks nothing (add it
  under `track:` if it's long-lived); beside a `track:` list, it's an unknown
  edge that blocks.
- With no PR, the first tracked branch, else the default branch.

B's **unlanded commits** are those in `T(B)..B`. Two branches are related only
when their unlanded commits overlap, which one `rev-list` per branch finds
without comparing every pair.

When they overlap, the direction comes from facts git or GitHub records:

- B's PR base chain passes through A's branch: **B needs A**. That's a stacked
  branch, the case that matters most.
- A's head is an ancestor of B's head: **B needs A**.
- Neither: an **ambiguous** relation, "shares unlanded commits", shown on both
  items with the fix (base the dependent PR on the other branch, or merge one
  into the other). It blocks nothing, since the graph alone can't say which
  branch builds on which.

An edge **lands** once the shared commits are in T(B), or once a merged PR of
A's branch whose head held them has its merge commit in T(B). The second case
covers squash merges and branches reused after a merge; todo keeps every
merged PR of a branch for it.

An edge goes **stale** when A can't land: its item is cancelled or deferred,
or its latest PR closed unmerged with nothing merged covering the shared
commits. A dependency on an item with no branches lands when that item is
complete. A stale edge never clears itself.

**Unknown is never "no edge".** A failed fetch, a GitHub error, a shallow
clone or a missing tracked branch keeps the previous state and marks it
unknown, and the guard treats an unknown edge as unresolved.

`todo get` lists `needs:` and `needed by:` with each edge's state (waiting,
landed, stale, unknown) and its evidence, the shared commits. `todo list` and
the board show "waits on X".

### Conflicts with, overlaps with

These are hints. They block nothing.

- **Conflicts with:** `git merge-tree --write-tree A B` (git 2.38+) merges in
  memory and lists conflicting files. It needs a checkout, so the CLI and a
  self-hosted server with one run it; the result syncs like any other fact.
- **Overlaps with:** both branches change the same files, from the compare
  API's file lists. Any server can compute it.

The hint names the fix: whichever branch merges second merges the other in.

### What blocks

- An unresolved "depends on" edge makes `todo stage` and `todo deploy` refuse,
  in the CLI and on the server. `--force` overrides and history records it.
- Plugins can add edges for what git can't see, such as a db-request
  migrations PR (§5). Those block the same way.
- A person records an edge git can't see with
  `todo needs <q> <PR URL | branch:<name> | item> [--in <branch>]`, a
  dependency note like a plugin's that blocks the same way; `todo needs rm`
  removes a hand-made one, never a plugin's. The `prereq-branch` check kind
  retires; a one-off `todo deps --from-checks` lists existing ones for a person
  to drop or confirm.

### When the facts recompute

Only a moved branch changes a git fact, so edits to notes, tasks or status
never trigger a recompute.

- **A push to an item's branch** reruns landed-in for that branch and the pair
  checks between it and every other open item branch in the repo.
- **A push to a tracked branch** rechecks landed-in for every item in the repo
  whose PR merged but hasn't reached that branch, which also clears edges.
- "Open" means not archived and not cancelled, so `done` and `deployed` items
  still see `main` catch up. The lookup crosses projects that share a repo.

How each host hears about a push:

- **Server:** GitHub webhooks per repo (`push`, `pull_request`,
  `deployment_status`), registered like the Jira webhook. A repo without one is
  polled: one branch-list call every few minutes with an ETag, which costs
  nothing when unchanged.
- **CLI:** one `git ls-remote` per repo in each sync round, compared with the
  tips it saw last.

## 3. Connections

A **connection** is a named endpoint with credentials and no logic.

```yaml
# .todo-plugins/plugins.yaml
connections:
  vercel:     {mcp: {url: "https://mcp.vercel.com"}}
  db-request: {mcp: {url: "http://leaf-rain:8710/mcp"}}
  watchtower: {http: {url: "http://leaf-rain:10011"}}
```

- **Kinds:** `mcp` (stdio `command:` or `url:`) and `http` (a base URL).
- **Scope:** a repo declares its own; a host can declare host-wide ones, such as
  `github` for the default plugins. A repo's connection overrides a host-wide
  one of the same name.
- **Credentials** never sit in the repo. `todo connection auth <name>` stores
  them for this repo on this host, in `~/.todo/credentials`; `--server` sends
  them to the server, which keeps them encrypted per project, repo and
  connection. Two repos on one server can point the same name at different
  endpoints.
- `todo connection list|test` shows each connection and whether this host can
  reach and authorize it.

### Who may use what

- **Host connections go to shipped plugins only**, with or without a secret.
  A repo plugin uses only the connections its repo declares, with a repo
  credential; one that names a host-wide connection, such as `github` or
  `watchtower`, is skipped and says so.
- **Only instances the host keeps get host connections.** A shipped plugin's
  default instance, and instances stored on the server (or in the CLI's synced
  cache or local `.TODO/.plugins.yaml`), may use them. An instance the repo's
  `plugins.yaml` declares, alone or under a stored override, gets the repo's
  connections only, so a repo file can't point a shipped plugin at the host's
  Jira or GitHub token. The dashboard shows such an instance's reason.
- **A project runs plugins only for its repos.** The server's operator lists
  the GitHub owners it serves (`TODO_PLUGIN_OWNERS`). A repo of a listed owner
  is allowed for a project once a member's CLI has reported a checkout of it,
  or once it is added on the project's settings page. An item naming any other
  repo gets no plugin runs and no git facts, so pointing an item at a repo
  can't make the server act on it. The server token itself should be scoped to
  the team's repos.
- **No private addresses from the server.** A server connection refuses
  loopback, private and link-local addresses unless
  `TODO_PLUGIN_ALLOW_HOSTS` lists the host: a bare entry opens it to host-wide
  connections, which only shipped plugins use; a repo's own connections need an
  `owner/name=host` entry. The check uses the resolved
  address it connects to. The CLI has no such limit, since a dev machine's own
  network is its user's.

## 4. Plugins

### The plugin file

A repo's plugins live in **`.todo-plugins/`** at the repo root: `plugins.yaml`
plus any code files. The name avoids `.todo/`, which collides with the store's
`.TODO/` on case-insensitive file systems.

**Hosts read it from the default branch**, never the working tree: the server
through the `github` connection, the CLI with `git show
origin/<default>:.todo-plugins/…`, fetching the default branch when
`ls-remote` shows it moved. Plugin changes take effect once merged, and
an unmerged branch can't run code on the server. `todo plugin test <name>
--local` runs the working-tree version in dry-run for development.

### Templates and instances

A plugin is a **template**: what it calls, when, and which settings it takes.
An **instance** is one configured use of it: a name, settings values, triggers
that override the plugin's `on:`, a button label, and an on/off switch.

```
watchtower-session            plugin
  ├─ Start agent              on: manual, in-progress · prompt "/todo {{item.id}}"
  └─ Review agent             on: review              · prompt "/review {{item.id}}"
pr-link                       plugin
  └─ (default)                no required settings, so one instance exists automatically
```

- The repo file can declare instances; the dashboard (or `todo plugin
  add|set|rm`) adds more or overrides their settings.
- On a synced store the server holds instances and the CLI caches them, so both
  hosts run the same settings. A local-only store keeps them in
  `.TODO/.plugins.yaml`.
- `exclusive: true` fires at most one instance per event, the first match in
  dashboard order. That is how Jira's "first matching trigger wins" carries
  over.

### The manifest

Every plugin, whatever its body, declares:

```yaml
plugins:
  vercel-preview:
    connections: [vercel]
    on: [push, deployment]           # default triggers; instances may override
    every: 1h                        # floor for state that changes without an event
    settings:
      project: {label: Vercel project id, type: text}
      team:    {label: Vercel team id, type: text}
```

- **Triggers:** `push`, `pr`, `deployment`, `status: [..]` (with `from`/`to`
  on instances), `manual`, and an `every:` floor. Adding a branch to an item
  runs every plugin for that branch.
- **Setting types:** `text`, `long-text`, `choice` (fixed `options`, or
  `options_from: {tool: …}` filled from a connection), `toggle`, `number`,
  `list`, and `secret`, which is stored with credentials and never shown again.
  `scope: plugin` makes a setting shared by every instance.

### YAML bodies

Prefer YAML whenever a plugin is a fixed sequence of calls. PR auto-link:

```yaml
  pr-link:
    connections: [github]
    on: [push, pr]
    per: branch
    steps:
      - name: prs
        http:
          method: GET
          path: "/repos/{{item.repo_owner}}/{{item.repo_name}}/pulls"
          query: {head: "{{item.repo_owner}}:{{branch}}", state: all}
    attach:
      - each: prs
        link: {type: pr, url: "{{each.html_url}}", label: "#{{each.number}} · {{each.title}}"}
```

The language is small:

- **`per:`** repeats the run for each of the item's branches (`per: branch`,
  setting `{{branch}}`) or each linked Jira issue (`per: jira`, setting
  `{{issue}}`). It is the only loop.
- **`when:`** is a JMESPath condition. On the plugin it gates the run, on a step
  it skips the step, on an attachment it skips the attachment.
- **Steps** run in order, each one of `tool:` + `input:` (an MCP call),
  `http:` (method, path, body) or `value:` (a JMESPath expression over earlier
  results). A named step's result is available to later steps. An empty result
  is empty; it never stops the run. A plugin with more than one connection
  names one on each call step (`connection: jira`).
- **`attach:`** lists what to attach, each with an optional `each:` and `when:`.
- **`{{x}}` is a path into the data, never an expression.** Inside an
  expression it is filled in as a quoted literal; in `input` or `body` as a JSON
  value; in an HTTP path URL-encoded. No item field can change a query or a
  call.

There is no waiting, retry or fallback in YAML. A plugin that needs them is
code.

### Code bodies

A code plugin keeps its manifest in `plugins.yaml`, with a `code:` key naming a
JS module in `.todo-plugins/`, so the dashboard reads every manifest without
running code. The module exports one function, `run()`, which receives:

- `item` and `event`, read-only, and `settings`, the instance's values;
- one client per declared connection (`jira.call(tool, input)`,
  `watchtower.get(path)`, `watchtower.post(path, body)`);
- `attach.link|doc|edge|log`;
- `wait.until(fn, {every, timeout})` and `wait.retry(fn, {when, attempts,
  every})`, the only timers it has.

The Watchtower plugin in §5 is the reference example.

### The host

One plugin host, written in TypeScript, runs both kinds. YAML plugins run in
its interpreter; code plugins run in a QuickJS sandbox (WebAssembly) with a
memory limit and a total run deadline, no file system, and no network beyond
its declared connections.

- **Server:** loads the host in-process.
- **CLI:** runs the same host under Node, passing the event as JSON on stdin.
  Without Node, the CLI skips plugins and says so; a synced store still gets
  the server's results.

### Which host runs an instance

On a synced store each instance runs on exactly one host: the server whenever
it can, otherwise the CLI. The server can when the repo is allowed for the
project and it holds every connection the instance needs, with no command
connection and no address its private-network rule refuses. It reports this per
instance, and the CLI runs only the rest, so side effects such as starting an
agent happen once. Of the clones that could run one of the rest, only the
item's developer's runs it automatically (its creator's when it has no
developer). Automatic runs happen after a command prints, within a time budget;
whatever doesn't fit waits for the next command. A local-only store runs everything in the CLI, and a manual
`todo plugin run` runs where it was asked.

### What a plugin can do

A plugin can call its connections and attach **links, docs, edges and dev-log
lines**. It can't change an item's status or fields.

One **capability** extends that: `post-request` lets a plugin post a new request
version, which sends the item back to `requested` for re-triage. Only plugins
shipped with todo may declare it, and a person grants it per project on the
dashboard. The Jira plugin is its one user (§5).

### Results

- Results are stored per instance, as the item's notes (links, edges), docs
  and log entries, each marked with the instance and a stable key. A run computes the full set, then adds, updates and removes by
  key, so seen and acknowledged state survives reruns.
- A note's uid derives from instance and key, so the CLI and the server running
  the same plugin write the same notes instead of duplicates.
- **One link per URL per item**, whatever its source. A plugin attaching a URL
  already linked by hand skips it and its run log says so.
- A host that lacks a connection or its credentials skips the plugin, and the
  item shows "vercel-preview: `vercel` not authorized here".

### Dry-run, run log, tester

- Any instance can run in **dry-run**: read-only calls go through (MCP tools
  marked read-only, HTTP `GET`); every other call is logged as "would send".
- Each instance keeps a **run log**: when it ran, what triggered it, what it
  attached or would send, and any error.
- The **tester** takes an item and an event (a status move, a push) and shows
  which instances would fire and what each would send.

### Dashboard

- **Project settings → Plugins:** each repo's plugins and instances, with
  on/off switches, forms built from `settings:`, connection authorization state,
  run logs and the tester.
- **Item page:** attachments labelled by the plugin that added them, a button
  for each `manual` instance, and skip notices.

## 5. Plugins shipped with todo

| plugin | body | default | replaces |
|---|---|---|---|
| `pr-link` | YAML over `github` | on for every repo | hand-linked PRs |
| `vercel-preview` | YAML over `vercel` | opt-in | hand-built preview URLs |
| `db-request` | YAML over `db-request` | opt-in | hand-linked db-request PRs |
| `rest` | YAML over an `http` connection | opt-in | `rest` Actions |
| `watchtower-session` | code over `watchtower` | opt-in | `watchtower` Actions |
| `jira-transition` | YAML over `jira` | opt-in | Jira outbound triggers |
| `jira-issue` | YAML over `jira` | opt-in | links-mode inbound polling |

The shipped plugins call GitHub, Vercel and Jira through `http` connections to
their REST APIs, so a host needs only a token for each, not an MCP server. MCP
connections stay available for repo plugins.

**`db-request`** attaches each submission's migrations PR as a link and an edge
("needs moneyball PR #560 in staging"), so the edge resolves through landed-in
in that repo. db-request has no MCP or HTTP endpoint today; the plugin waits on
one (open item 2).

**`jira-transition`** keeps today's trigger table as instances:

```yaml
  jira-transition:
    connections: [jira]
    per: jira
    exclusive: true
    when: "!contains(settings.never, settings.to)"
    settings:
      to:    {label: Jira status, type: choice, options_from: {tool: list_statuses}}
      never: {label: Never move to, type: list, scope: plugin}
    steps:
      - name: transitions
        tool: getTransitionsForJiraIssue
        input: {issueIdOrKey: "{{issue}}"}
      - name: transition
        value: "transitions.transitions[?to.name=={{settings.to}}] | [0]"
      - when: transition
        tool: transitionJiraIssue
        input: {issueIdOrKey: "{{issue}}", transition: {id: "{{transition.id}}"}}
```

**`jira-issue`** runs `per: jira`, `every: 5m`. It attaches the issue's status
next to its key, its comments (keyed by Jira comment id) and its images (as
item docs, §6, fetched through the connection). With `post-request` granted, a newly linked issue's summary and
description post as a new request version, as links mode does now.

**`watchtower-session`** reproduces `server/lib/actions/deliver.ts`:

```yaml
  watchtower-session:
    connections: [watchtower]
    on: [manual]
    code: watchtower-session.js
    settings:
      dir:          {label: Folder, type: text, default: "{{item.dir}}"}
      prompt:       {label: Prompt, type: long-text, default: "/todo {{item.id}}"}
      resumePrompt: {label: Prompt for a live or resumed session, type: long-text, optional: true}
      model:        {label: Model, type: choice, options: [opus, sonnet], optional: true}
```

```js
// watchtower-session.js
export async function run({ item, settings, watchtower, attach, wait }) {
  const name = `todo: ${item.id}`;
  const { sessions = [] } = await watchtower.get("/api/roster");

  const live = sessions.find((s) => s.name === name && s.state === "active" && s.managed);
  if (live) return send(live.id, settings.resumePrompt ?? settings.prompt, "sent to");

  const stopped = settings.resumePrompt && sessions
    .filter((s) => s.name === name && s.state === "stopped")
    .sort((a, b) => b.lastActivity - a.lastActivity)[0];
  if (stopped) {
    try {
      await watchtower.post(`/api/sessions/${stopped.id}/resume`);
      await idle(stopped.id);
      return send(stopped.id, settings.resumePrompt, "resumed");
    } catch (e) {
      if (e.waiting) throw e;
    }
  }

  const started = await watchtower.post("/api/sessions", { dir: settings.dir, name, model: settings.model });
  await idle(started.id);
  return send(started.id, settings.prompt, "started");

  async function idle(id) {
    await wait.until(async () => {
      const s = await watchtower.get(`/api/sessions/${id}`);
      if (s.status === "waiting") throw Object.assign(new Error(`session is waiting on ${s.waitingFor}`), { waiting: true });
      return s.state !== "stopped" && s.status === "idle";
    }, { every: "2s", timeout: "3m" });
  }

  async function send(id, text, verb) {
    await wait.retry(() => watchtower.post(`/api/sessions/${id}/message`, { text, from: "todo" }),
                     { when: (e) => e.message.includes("input isn't visible"), attempts: 6, every: "1s" });
    attach.log(`${verb} Watchtower session ${name}: ${id}`);
  }
}
```

## 6. Docs store

A **doc** is a file an item keeps on purpose: a design, plan, onboarding guide,
handoff or instructions. Notes stay short and refer to docs by name.

- **Where:** the item's own folder, `.TODO/<folder>/<item>/docs/`. Docs move
  with the item through deferral, cancellation and archiving.
- **Synced store:** each doc syncs as an entity (name, size, sha256, who and
  when), and its bytes go to the server's S3 bucket. On bishs that is the
  existing local SeaweedFS store (`todo-s3`, port 9000).
- **Commands:**

  ```bash
  todo doc add <q> design.md          # copy a file in; --name renames; "-" reads stdin
  todo docs <q>                       # name, size, who and when; a dashboard link when synced
  todo doc path <q> design.md         # the file's path, for editing in place
  todo doc rm <q> design.md
  ```

- **Edits:** any change in `docs/` counts, however it was made. The sync round
  uploads files whose hash changed. An upload whose base hash isn't the
  server's current one is a conflict: the local file is kept as
  `design.conflict-<who>.md` next to the server's version, so neither is lost.
- **Dashboard:** view-only, with upload, replace and delete. Each doc renders
  by type: Markdown through the notes renderer, HTML in a sandboxed frame,
  JSON pretty-printed and highlighted, other code highlighted by extension
  (YAML, CSS, TS, Python, SQL, shell…), and images, PDF, audio and video
  inline.
- **References:** `doc:design.md` in a note renders as a link to the doc.
- **No Watchtower coupling.** A local-only store prints each doc's path; a
  synced store links to the dashboard.

## 7. Lifecycle guards

- **Edges:** an unresolved "depends on" edge blocks `todo stage` and
  `todo deploy` (§2), with `--force`.
- **Agent handoff:** `--force` lets an agent move `review → ready-for-qa`. The
  guard lives in the CLI (`todo/cli.py` `_check_transition`) and the server
  (`server/lib/apply.ts`, `agent-handoff`); both accept the flag and history
  records the move as forced. The skill tells agents to use it only when a
  person asks.

## 8. What retires

- **Actions:** after `rest` and `watchtower-session` reproduce them, existing
  Actions convert to instances and `projects.actions` drops.
- **Jira import mode and the SR mirror:** import mode's only user is the test
  mirror (`todo-jira.service`, `todo-jira-sync.service`, port 10094). Both
  services stop and import mode leaves the server. Jira status sets and
  inbound transition rules go with it.
- **Jira links-mode bridge:** after `jira-transition` and `jira-issue`
  reproduce it, `jira_outbound` converts to instances and the poller timer
  (`todo-bishs-jira.timer`) stops.
- **`prereq-branch` checks** (§2).

## Open items

1. **Tool names.** Confirm the parameters of Vercel's `list_deployments`
   (whether it filters by branch), GitHub's MCP `list_pull_requests`, and
   Jira's REST endpoints before writing the shipped plugins (they use REST,
   so the `jira-transition` example's tool names become HTTP paths).
2. **db-request endpoint.** db-request is a CLI over Postgres. The plugin
   needs an MCP or HTTP endpoint from the db-request repo.
3. **Watchtower credentials.** Watchtower's API has no authentication, so a
   server reaches it only from the tailnet, as Actions do today.
4. **QuickJS async.** Calls out of the sandbox need QuickJS's asyncify build;
   a spike confirms it before the host is built on it.
5. **Jira comment authors.** Mirrored comments name a Jira account; the
   server maps known accounts to handles today (`user:jira`). The host needs
   to apply that mapping to `jira-issue` attachments.
6. **Derived checks.** The auto-derivation draft
   (`2026-10-08-environments-and-derived-checks.md`) can become a plugin that
   attaches deployment checks. It is outside this design.

## Testing

- **Plugin conformance suite:** plugin files, recorded connection responses and
  expected attachments, run against the host. The CLI bridge runs the same
  suite through Node.
- **Git facts:** fixture repos built in the test (stacked, squash-merged,
  conflicting, deleted-branch cases) against both the local-git and the
  compare-API paths, the latter with recorded responses.
- **Docs:** CLI round trips (add, edit in place, conflict) against PGlite and
  local files; dashboard rendering per type in the smoke suite.
- **Ports:** rosm's Jira triggers and Actions run in dry-run as instances beside
  the old code, and their "would send" output must match before the old code
  retires.
