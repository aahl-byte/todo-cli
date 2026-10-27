# Plugin config owned by todo

A project admin sets up everything a repo's plugins do on the dashboard's
**Settings → Automation**, without touching the repo: which shipped plugins run,
the repo's deploy branches, custom plugins and the connections they call, and
each plugin's instances. todo stores all of it per project and repo. No host
reads any file from a repo to learn what to run; the server reads GitHub only
for git facts and polling: branches, commits and pull requests.

## Storage

Each repo a project uses has one plugin config. It is four things:

- **Deploy branches**: the long-lived branches git facts check work against,
  shown on items as "in staging ✓ · in main ✗".
- **Shipped plugins switched on**: `vercel-preview`, `db-request`, `rest`,
  `watchtower-session`, `jira-transition`, `jira-issue`. `pr-link` runs for
  every repo without being switched on.
- **Connections**: named endpoints (an HTTP base URL with an auth kind, or an
  MCP server's URL) that custom plugins call, and that an instance of a shipped
  plugin may name.
- **Custom plugins**: each one's manifest, the same YAML a plugin definition
  has always used, and the code its `code:` key names.

On the server these live in two tables, keyed by project and repo:

| table | holds |
|---|---|
| `plugin_configs` | `track` (deploy branches), `shipped`, `connections`, who changed it and when |
| `plugin_custom` | one row per custom plugin: `name`, `manifest` (YAML text), `code`, `version` |

Instances, grants and connection credentials keep their own tables
(`plugin_instances`, `plugin_grants`, `plugin_credentials`), with secrets
encrypted under `TODO_SECRET_KEY`. A credential also records the endpoint it
was given for. Two projects that use the same repo keep separate configs.

The migration starts every repo's config empty. It drops each credential
without an endpoint or for a connection no config declares, and each instance
or grant of a plugin that neither ships with todo nor is a custom plugin.

**What the host runs.** `composeConfig` turns the stored parts into one YAML
map, the shape `load.ts` has always checked:

```yaml
track: [staging, main]
connections:
  hooks: {http: {url: "https://hooks.example.com", auth: bearer}}
plugins:
  vercel-preview: {use: shipped}
  notes-link: {on: [manual], attach: [...]}
```

The host takes it as `config: {text, code}`, with each code plugin's module
under its plugin name. Instances never sit in this map; the host gets them
apart, as `storedInstances`.

**Checks before saving.** A custom plugin goes through `pluginErrors` from
`load.ts`, plus what only a stored plugin can get wrong: a name a shipped plugin
or another custom plugin has, a `use:` key, a `code:` with no code pasted, code
with no `code:`. The Automation page runs the same check (`checkCustom`) as the
YAML is typed, so errors show before Save. A connection the plugin calls that
the repo doesn't declare is a warning, since it can be declared next. The API
refuses an MCP connection that starts a command: the server never starts one,
and a CLI doesn't for a server's config (below).

**Writes.** `PUT /api/projects/<key>/plugins/config` takes `track`, `enable`,
`disable` or `connection: {name, def}` (`def: null` drops the connection and
its credential). Declaring or changing a connection forgets any credential
stored under its name. A repo's connection can't take the name of one of the
server's own (`github`, or any in `TODO_PLUGIN_CONNECTIONS`) or the project's.
`POST /api/projects/<key>/plugins/credentials` takes the endpoint the person
saw beside the secret. A credential is handed out only while its connection
points there.

`PUT`, `POST` (check only) and `DELETE` on `/api/projects/<key>/plugins/custom`
add, check and remove a custom plugin. Renaming one moves its instances and
grants with it, secret settings encrypted again for the new name. A name new
to the repo starts with nothing stored under it. Switching a shipped plugin off
keeps its instances, so switching it back on restores them. Setting deploy
branches recomputes the repo's git facts.

**Concurrent edits** answer 409 rather than overwrite:

- A deploy-branch change sends `base`, the list it was made on.
- A custom plugin edit sends `base`, the version it began from.
- A credential checks its endpoint against the config in the same transaction
  that stores it.
- Instances check their custom plugin still exists in the transaction that
  stores them.
- A project connection change sends `base`, the version it was made on; a repo
  connection edit sends the definition it was made on.

The page says what changed and offers a reload.

## A project's own connections

The connections shipped plugins call (`vercel`, `jira`, `watchtower`,
`db-request`, `github`'s token, and any a web-request button names) are set on
Settings → Automation, per project, in `project_connections`.
`PUT /api/projects/<key>/plugins/connections` takes `{name, def?, secret?, base,
allowPrivate?}`:

- **Precedence.** A project's connection replaces the server's of that name
  (`TODO_PLUGIN_CONNECTIONS`) for every repo of the project, address and secret
  together: the server's secret is never lent to it. github's address is always
  the server's GitHub API; a project gives only its token.
- **Endpoint binding.** The secret is encrypted for the project, the connection
  and the endpoint it was given for, and a change to the address or auth drops
  it. It decrypts for no other endpoint, whatever the row says.
- **Addresses.** A connection's address is an http or https URL. Saving one
  that resolves to a private network needs `allowPrivate: true`, recorded with
  who and when, unless `TODO_PLUGIN_ALLOW_HOSTS` opens it; an allowance is
  recorded only for an address that is private when it's given. The guard
  waives the rule for that connection's name and host:port alone, and only for
  host-origin calls. A link-local address, where a cloud's metadata service
  answers, is never allowed from the page, at save time or when a call finds
  the name resolving there.
- **GitHub reads.** The project's github token reads its repos for git facts,
  polling, PR status and plugins, and a project that gave one never falls back
  to the server's, even while its own doesn't decrypt. The server's
  `GITHUB_TOKEN` reads only repos of `TODO_PLUGIN_OWNERS`, PR link status
  included: the `github` connection holding it refuses a path outside
  `/repos/<owner>/` of those owners, or one with an encoded separator. A repo added on
  the page is the project's whatever its owner; a checkout brings one in only
  for those owners. The tick polls a repo with the first of its projects'
  tokens GitHub accepts, and records which; when GitHub fails, a project sees
  polled branch names only if its own token polled them.

## The trust rule

Who may use the host's connections (the project's own, `github` with the
project's token or `GITHUB_TOKEN`, and those in `TODO_PLUGIN_CONNECTIONS` with
`TODO_PLUGIN_SECRET_<NAME>`):

- **A shipped plugin**, through any of its instances, gets the host's
  connections with their secrets, and the repo config's connections with the
  repo's credentials.
- **A custom plugin** gets the repo config's connections with the repo's
  credentials, and `github` pointed at the server's GitHub API without the
  token. It never gets another host connection or any host secret. One that
  names a host connection is skipped, saying to declare the connection for the
  repo under another name.

Since anyone signed in can edit a config, it can't repoint what a host set up.
Of a name both declare, a shipped plugin keeps the host's connection, and a
custom plugin gets the repo's. The server refuses a repo connection named after
one of its own, and takes a credential only for a connection the config
declares. A CLI gives its own secret for a repo connection only while that
connection points where the secret was given: `todo connection auth` records
the endpoint beside it.

`host.ts` draws the line in `connectionsFor` and `connectionsOf`: `shipped`
decides, and nothing a person types into a config can make a custom plugin
shipped, since a custom plugin can't take a shipped plugin's name.

`TODO_PLUGIN_ALLOW_HOSTS` opens a private host to the host's connections with a
bare `host[:port]`, and to one repo's connections with `owner/name=host[:port]`;
a project's own connection can also be allowed on the page, for itself alone.
The `github` a custom plugin gets counts as the repo's. `JIRA_READ_ONLY` still holds every write through the
host's `jira` connection back.

## The sync path

The CLI runs the instances the server can't (a connection only a developer's
network reaches, a credential only the developer holds), so it needs the same
config.

**A synced store** asks the server: `GET /api/projects/<key>/plugins?repo=`
answers with the composed `config`, the deploy branches as `track`, the stored
instances and grants, and whether the server runs each instance. The CLI caches
the answer in `.sync/plugins.json` for a minute and keeps using the last good one
while the server fails; after an hour of failures it runs no instance from it.
The plugin runner and the CLI's git facts both read that one cache, so
`todo deps`, `todo stage`, `todo deploy` and `todo refresh` see the deploy
branches the server sees, and a change to them recomputes the repo's facts. The
CLI never starts a command an MCP connection from the server's config names: a
config anyone on the dashboard can edit would otherwise run commands on every
developer's machine.

**A local-only store** has no server. It keeps its config in
`.TODO/.plugins.yaml`, one map per repo holding `track`, `connections`,
`plugins`, `instances` and `grants`, with each code plugin's file under
`.TODO/.plugins/<owner>/<name>/`. The CLI composes the same `{text, code}` from
it, and there a connection may start a command, since the file is the
developer's own.

**From the command line**, on either kind of store:

- `todo plugin deploy-branches [--repo R] [B ...] [--add B] [--remove B] [--clear]`
  shows or sets the deploy branches.
- `todo plugin enable|disable <plugin>` switches a shipped plugin.
- `todo plugin test <plugin> [item] --draft FILE [--set k=v]` dry-runs a draft
  manifest from a file, with the code file its `code:` names beside it, in
  place of the config's plugin of that name. `--set` runs one throwaway
  instance with those settings.
