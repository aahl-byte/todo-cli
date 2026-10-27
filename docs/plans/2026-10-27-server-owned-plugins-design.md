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
| `plugin_custom` | one row per custom plugin: `name`, `manifest` (YAML text), `code` |

Instances, grants and connection credentials keep their own tables
(`plugin_instances`, `plugin_grants`, `plugin_credentials`), with secrets
encrypted under `TODO_SECRET_KEY`. Two projects that use the same repo keep
separate configs.

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
its credential). A credential belongs to the endpoint it was given for, so
changing a connection's definition forgets it too. A repo's connection can't
take the name of one of the server's own (`github`, or any in
`TODO_PLUGIN_CONNECTIONS`). `PUT`, `POST` (check only) and `DELETE` on
`/api/projects/<key>/plugins/custom` add, check and remove a custom plugin;
renaming one moves its instances and grants with it, secret settings
encrypted again for the new name. Switching a shipped plugin
off keeps its instances, so switching it back on restores them. Setting deploy
branches recomputes the repo's git facts.

## The trust rule

Who may use the server's own connections (`github` with `GITHUB_TOKEN`, and
those in `TODO_PLUGIN_CONNECTIONS` with `TODO_PLUGIN_SECRET_<NAME>`):

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

The private-address rule is unchanged. `TODO_PLUGIN_ALLOW_HOSTS` opens a private
host to the server's own connections with a bare `host[:port]`, and to one
repo's connections with `owner/name=host[:port]`; the `github` a custom plugin
gets counts as the repo's. `JIRA_READ_ONLY` still holds every write through the
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
