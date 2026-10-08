# Actions

An Action is a call a project defines once and fires against any of its items:
by hand from the item page or `todo action`, or on its own when an item makes a
status move the Action names. The first use is to start a Claude session in
the item's repo through Watchtower's REST API, but any REST endpoint works.

## Where Actions live

Actions are project settings, stored on the team server in `projects.actions`
(a jsonb array) and edited on the project's settings page. A store with no team
server has no Actions.

```ts
interface ActionDef {
  id: string;                 // slug, unique in the project: `todo action <q> <id>`
  name: string;               // the button label
  kind: "rest" | "watchtower";
  runner: "server" | "cli";   // who sends the call
  auto: { from: string; to: string }[];  // status moves that fire it; from "*" is any
  // rest
  method?: string; url?: string; headers?: Record<string, string>; body?: string;
  // watchtower
  base?: string;              // e.g. http://leaf-rain:10011
  dir?: string;               // e.g. /mnt/rain/git/{{item.repo_name}}
  prompt?: string;            // default "/todo {{item.id}}"
  model?: string;
}
```

## Templates

`url`, header values, `body`, `dir` and `prompt` take `{{name}}` placeholders,
filled from the item when the Action fires. Unknown names are an error at save
time.

| name | value |
|------|-------|
| `item.id`, `item.title`, `item.status`, `item.type`, `item.priority` | the item's fields |
| `item.from` | the status it moved from (empty when fired by hand) |
| `item.app`, `item.section`, `item.repo`, `item.branch` | the item's work fields |
| `item.repo_name` | `repo` after its last `/` |
| `item.developer`, `item.qa` | handles |
| `item.url` | the item's page on the team server |
| `project`, `actor` | the project key; who fired it |

A placeholder takes a filter after a bar: `{{item.title | json}}` writes a
quoted JSON string, and `{{item.title | url}}` URL-encodes it. Without a filter
the value goes in as-is, so a body that embeds free text should use `json`.

## Who sends the call

The `runner` decides. A `server` Action is queued in `action_runs` by the same
transaction that applies the status move or the manual run, and delivered
after the request by `flushActions`, which also runs on the cron. Delivery
leases each row, retries with backoff and gives up after `MAX_ATTEMPTS`. It
writes one dev-log line per run, either the response status or the final error.

A `cli` Action runs in the `todo` process that fired it. `todo action <q> <id>`
runs it by hand. After any status change it makes, the CLI fetches the
project's Actions and runs the matching `cli` ones. A move made in the web UI or
by another teammate's CLI fires no `cli` Action on this machine. Pick `cli` for
endpoints only this machine can reach.

## The watchtower kind

A `watchtower` Action calls [Watchtower's agent API](/mnt/rain/git/watchtower/specs/AGENT_API.md):

1. `GET {base}/api/roster`. If an active managed session is named
   `todo: <item.id>`, post the prompt to it (`POST /api/sessions/<id>/message`,
   `from: "todo"`).
2. Otherwise `POST {base}/api/sessions` with `dir`, the name and `model`. The
   prompt rides as `initialPrompt` when it is one line of at most 200
   characters. A longer prompt waits for the session to report `idle`, then is
   posted as a message.

The run's log line carries the session's watch link. Watchtower has no
credentials, so a `server` runner reaches it only when the team server is on
the tailnet; watchtower item `agent-api-credential-for-callers-off-the` tracks
adding them. The first session in a never-opened folder stops at Claude's
folder-trust prompt until a person accepts it.

## Security

Anyone signed in to the project can edit its Actions, and the server sends
what they configure. Header values are stored and shown in plain text, so a
token placed there is visible to every project member.
