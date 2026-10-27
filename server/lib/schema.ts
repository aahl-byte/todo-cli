// The database schema, applied idempotently by migrate() on every deploy and
// on PGlite startup. It lives in code, not in a file read at runtime, so it
// works from any working directory and in bundled deploys.
export const SCHEMA = `
-- Every entity row is keyed by (project, uid): a uid is unique within a
-- project, so one store can be linked to several projects over time.

-- A database built from a pre-release schema (entity rows keyed by uid alone)
-- can't be upgraded in place; refuse it rather than half-apply this file.
do $$
begin
  if exists (select 1 from information_schema.tables where table_name = 'tasks' and table_schema = current_schema())
     and not exists (select 1 from information_schema.columns
                      where table_name = 'tasks' and column_name = 'project' and table_schema = current_schema()) then
    raise exception 'This database predates the project-keyed schema. Recreate it (it held only pre-release data).';
  end if;
end $$;

create table if not exists users (
  handle          text primary key,
  name            text,
  email           text,
  token_hash      text unique,
  jira_account_id text unique,
  created         timestamptz not null default now()
);

create table if not exists projects (
  key             text primary key,
  name            text,
  seq             bigint not null default 0,
  deploy_step     boolean not null default true,
  jira_project    text unique,
  jira_status_map jsonb not null default '{}'::jsonb,
  created         timestamptz not null default now()
);

create table if not exists items (
  project     text not null references projects(key),
  uid         text not null,
  id          text not null,
  title       text not null,
  type        text not null default 'feature',
  status      text not null default 'todo',
  priority    text,
  super_phase integer,
  creator     text,
  developer   text,
  qa_assignee text,
  created     text not null,
  completed   text,
  calc_status text,
  extra       jsonb not null default '{}'::jsonb,
  versions    jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, id)
);

create table if not exists tasks (
  project  text not null,
  uid      text not null,
  item_uid text not null,
  n        integer not null,
  title    text not null,
  status   text not null default 'todo',
  phase    integer,
  position double precision not null default 0,
  versions jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, item_uid, n),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

create table if not exists notes (
  project  text not null,
  uid      text not null,
  item_uid text not null,
  n        integer not null,
  kind     text not null default 'context',
  author   text,
  via      text,
  ts       text not null,
  text     text not null,
  meta     jsonb not null default '{}'::jsonb,
  source   text,
  versions jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, item_uid, n),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

create table if not exists logs (
  project  text not null,
  uid      text not null,
  item_uid text not null,
  n        integer not null,
  author   text,
  via      text,
  ts       text not null,
  text     text not null,
  versions jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, item_uid, n),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

create table if not exists checks (
  project  text not null,
  uid      text not null,
  item_uid text not null,
  n        integer not null,
  kind     text not null,
  title    text not null,
  payload  text,
  timing   text not null default 'pre-deploy',
  status   text not null default 'pending',
  versions jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, item_uid, n),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

create table if not exists status_history (
  project     text not null,
  uid         text not null,
  item_uid    text not null,
  n           integer not null,
  from_status text,
  to_status   text not null,
  by          text,
  via         text,
  forced      boolean not null default false,
  override    boolean not null default false,
  note        text,
  ts          text not null,
  primary key (project, uid),
  unique (project, item_uid, n),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

-- One row per changed entity. seq comes from projects.seq under the project's
-- row lock, so sequence numbers commit in order and a pull never skips one.
create table if not exists changes (
  project  text not null,
  seq      bigint not null,
  entity   text not null,
  uid      text not null,
  item_uid text not null,
  deleted  boolean not null default false,
  author   text,
  ts       text not null,
  primary key (project, seq)
);
create index if not exists changes_uid on changes (project, uid, seq);

create table if not exists tombstones (
  project  text not null,
  uid      text not null,
  entity   text not null,
  item_uid text not null,
  seq      bigint not null,
  primary key (project, uid)
);
-- Who removed it; a plugin may create again what a plugin run removed, but not what a person did.
alter table tombstones add column if not exists by text;
alter table tombstones add column if not exists by_plugin boolean not null default false;

create table if not exists applied_ops (
  project text not null,
  op_id   text not null,
  result  jsonb not null,
  created timestamptz not null default now(),
  primary key (project, op_id)
);

-- An item may link many Jira issues, and an issue may link items in several
-- projects. Rows with source 'field' follow the item's extra.jira list, and
-- the bridge mirrors only those.
create table if not exists jira_links (
  project          text not null,
  item_uid         text not null,
  jira_key         text not null,
  last_event_at    bigint,
  last_assignee_at bigint,
  primary key (project, item_uid, jira_key),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);
alter table jira_links drop constraint if exists jira_links_jira_key_key;
do $$
begin
  if not exists (select 1 from information_schema.key_column_usage
                  where table_schema = current_schema() and table_name = 'jira_links'
                    and constraint_name = 'jira_links_pkey' and column_name = 'jira_key') then
    alter table jira_links drop constraint jira_links_pkey;
    alter table jira_links add primary key (project, item_uid, jira_key);
  end if;
end $$;
create index if not exists jira_links_key on jira_links (jira_key);
-- Rows that predate the column were imports; new rows are field links.
alter table jira_links add column if not exists source text not null default 'import';
alter table jira_links alter column source set default 'field';
alter table jira_links add column if not exists linked_at timestamptz not null default now();
alter table jira_links add column if not exists backfilled_at timestamptz;
alter table jira_links add column if not exists jira_status text;

-- One row per attachment per project: projects keep their own copies.
create table if not exists jira_files (
  project       text not null,
  attachment_id text not null,
  issue_key     text not null,
  media_id      text,
  filename      text not null,
  mime          text,
  file_key      text,
  primary key (project, attachment_id)
);
do $$
begin
  if not exists (select 1 from information_schema.key_column_usage
                  where table_schema = current_schema() and table_name = 'jira_files'
                    and constraint_name = 'jira_files_pkey' and column_name = 'project') then
    alter table jira_files drop constraint jira_files_pkey;
    alter table jira_files add primary key (project, attachment_id);
  end if;
end $$;
create index if not exists jira_files_issue on jira_files (project, issue_key);
-- Every project mirrors only the issues its items link, from any Jira project.
-- projects.jira_project, jira_status_map and jira_inbound are unused.
alter table projects add column if not exists jira_mode text not null default 'links';
alter table projects alter column jira_mode set default 'links';
update projects set jira_mode = 'links' where jira_mode = 'import';
alter table projects add column if not exists jira_synced_at timestamptz;
alter table jira_files add column if not exists size bigint;
alter table projects add column if not exists jira_inbound jsonb;
alter table jira_links add column if not exists replayed_through bigint;
alter table projects add column if not exists jira_outbound jsonb;
alter table projects add column if not exists jira_settings_by text;
alter table projects add column if not exists jira_settings_at timestamptz;
-- Off once jira-issue mirrors the project's linked tickets in the bridge's place.
alter table projects add column if not exists jira_poll boolean not null default true;
alter table status_history add column if not exists override boolean not null default false;
alter table status_history add column if not exists note text;
alter table logs add column if not exists meta jsonb not null default '{}'::jsonb;

create table if not exists jira_outbox (
  id              bigserial primary key,
  project         text not null,
  item_uid        text not null,
  action          text not null,
  payload         jsonb not null,
  attempts        integer not null default 0,
  error           text,
  result          jsonb,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  done_at         timestamptz,
  created         timestamptz not null default now()
);

-- A check's ticked environments, as "dev,staging,production" in lifecycle order.
alter table checks add column if not exists envs text;
alter table projects add column if not exists actions jsonb not null default '[]'::jsonb;
alter table projects add column if not exists actions_by text;
alter table projects add column if not exists actions_at timestamptz;
-- Actions moved into plugin instances, each with where it went, kept so they can move back.
alter table projects add column if not exists actions_moved jsonb not null default '[]'::jsonb;

create table if not exists action_runs (
  id              bigserial primary key,
  project         text not null,
  item_uid        text not null,
  action_id       text not null,
  name            text not null,
  trigger         text not null,
  by              text not null,
  request         jsonb not null,
  attempts        integer not null default 0,
  error           text,
  result          jsonb,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  done_at         timestamptz,
  created         timestamptz not null default now()
);
create index if not exists action_runs_due on action_runs (id) where done_at is null;

create table if not exists notifications (
  id       bigserial primary key,
  handle   text not null,
  kind     text not null,
  project  text not null,
  item_uid text not null,
  note_uid text,
  actor    text,
  created  timestamptz not null default now(),
  read_at  timestamptz
);
create index if not exists notifications_handle on notifications (handle, read_at);

create table if not exists item_seen (
  handle   text not null,
  project  text not null,
  item_uid text not null,
  seen_at  timestamptz not null,
  primary key (handle, project, item_uid)
);

-- The folder each person keeps a repo in, as their CLI last reported it.
-- repo is the remote's owner/name, lowercased; '' for a folder with no remote.
create table if not exists checkouts (
  handle  text not null,
  project text not null,
  repo    text not null,
  dir     text not null,
  seen_at timestamptz not null default now(),
  primary key (handle, project, repo)
);
create index if not exists checkouts_repo on checkouts (repo);

create table if not exists item_pins (
  handle    text not null,
  project   text not null,
  item_uid  text not null,
  pinned_at timestamptz not null default now(),
  primary key (handle, project, item_uid),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

-- Read-only keys for a wall display: each shows one project's board.
create table if not exists display_tokens (
  token_hash text primary key,
  project    text not null references projects(key),
  label      text not null,
  created    timestamptz not null default now(),
  last_seen  timestamptz,
  unique (project, label)
);
-- Who set the display up: it shows their pins.
alter table display_tokens add column if not exists handle text;

-- Per-device API tokens, minted when a signed-in user approves a CLI login.
-- users.token_hash stays the user's own token.
create table if not exists api_tokens (
  id         bigserial primary key,
  token_hash text not null unique,
  handle     text not null references users(handle) on delete cascade,
  label      text not null,
  created    timestamptz not null default now(),
  last_used  timestamptz
);
create index if not exists api_tokens_handle on api_tokens (handle);

-- An item's docs: files it keeps on purpose. The bytes live in the files
-- store under file_key; sha256 is what a client's base is checked against, and
-- versions.sha256 is the change seq of the current content. name_key (the name
-- NFC-normalized and lowercased, set by the app) is what makes two names one doc.
create table if not exists docs (
  project      text not null,
  uid          text not null,
  item_uid     text not null,
  name         text not null,
  name_key     text not null,
  size         bigint not null,
  sha256       text not null,
  file_key     text not null,
  content_type text not null,
  by           text,
  via          text,
  at           text not null,
  versions     jsonb not null default '{}'::jsonb,
  primary key (project, uid),
  unique (project, item_uid, name_key),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);

-- plugin: the <plugin>/<instance> that wrote the doc, and plugin_sha256 what it
-- wrote; a doc whose sha256 has moved on since was edited, and the plugin leaves it.
alter table docs add column if not exists plugin text;
alter table docs add column if not exists plugin_sha256 text;
-- plugin_version: the version the plugin gave the doc, so it isn't fetched again while that holds.
alter table docs add column if not exists plugin_version text;

-- A deleted doc's last sha256, so a client can tell whether its copy was edited since.
create table if not exists doc_tombstones (
  project  text not null,
  uid      text not null,
  item_uid text not null,
  sha256   text not null,
  primary key (project, uid)
);

-- Doc upload keys the server issued and nothing has recorded yet. A record
-- takes only one of these; keys left over a day are swept with their bytes.
create table if not exists doc_uploads (
  project  text not null,
  file_key text not null,
  item_uid text not null,
  name_key text not null,
  created  timestamptz not null default now(),
  primary key (project, file_key)
);

-- A CLI waiting for a browser to approve it. The token is minted when the CLI
-- collects it, so it is never stored.
create table if not exists device_logins (
  device_hash text primary key,
  user_code   text not null unique,
  label       text not null,
  handle      text,
  expires     timestamptz not null,
  last_poll   timestamptz,
  created     timestamptz not null default now()
);

-- Each item's git facts, derived and never set by hand: what a CLI posted, or
-- what the server computed through GitHub (keeping the CLI's conflicts).
create table if not exists git_facts (
  project     text not null,
  item_uid    text not null,
  data        jsonb not null default '{}'::jsonb,
  computed_by text not null,
  at          timestamptz not null default now(),
  primary key (project, item_uid),
  foreign key (project, item_uid) references items (project, uid) on delete cascade
);
-- Open items by branch, for routing a GitHub event to the items it concerns.
create index if not exists items_branches on items using gin ((extra->'branches'));

-- Each repo's plugin config in a project, set on Settings → Automation: its
-- deploy branches, the shipped plugins switched on, and the connections its
-- custom plugins call.
create table if not exists plugin_configs (
  project     text not null,
  repo        text not null,
  track       text[] not null default '{}',
  shipped     text[] not null default '{}',
  connections jsonb not null default '{}'::jsonb,
  updated_by  text not null,
  updated_at  timestamptz not null default now(),
  primary key (project, repo)
);

-- A repo's custom plugins: each one's manifest, as YAML, and the code its
-- code: key names.
create table if not exists plugin_custom (
  project    text not null,
  repo       text not null,
  name       text not null,
  manifest   text not null,
  code       text,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (project, repo, name)
);
-- version: counts its saves, so an edit made on an older one is refused.
alter table plugin_custom add column if not exists version integer not null default 1;

drop table if exists plugin_defs;

-- An item written with a single legacy branch also lists it in branches, so
-- lookups by branch need only the branches index.
update items set extra = jsonb_set(extra, '{branches}', jsonb_build_array(btrim(extra->>'branch')))
 where extra ? 'branch' and not extra ? 'branches' and jsonb_typeof(extra->'branch') = 'string' and btrim(extra->>'branch') <> '';

-- Each repo's branch tips as the tick last listed them, page by page with
-- GitHub's ETag for each, and when a push webhook last arrived for it: a repo
-- with webhooks isn't polled.
create table if not exists repo_polls (
  repo      text primary key,
  pages     jsonb not null default '[]'::jsonb,
  tips      jsonb not null default '{}'::jsonb,
  polled_at timestamptz,
  hook_at   timestamptz
);
-- polled_with: a hash of the token the tips were read with, so only a project
-- reading with that token is shown them.
alter table repo_polls add column if not exists polled_with text;

-- Repos a project may read from GitHub and run plugins for, beyond the ones
-- its members' CLIs report checkouts of.
create table if not exists project_plugin_repos (
  project  text not null,
  repo     text not null,
  added_by text not null,
  added_at timestamptz not null default now(),
  primary key (project, repo)
);
create index if not exists project_plugin_repos_repo on project_plugin_repos (repo);

-- Who is applying a plugin instance's run to an item, until when; a holder
-- renews it while it works, and a crashed one's lease runs out.
create table if not exists plugin_locks (
  project    text not null,
  item_uid   text not null,
  instance   text not null,
  holder     text not null,
  expires_at timestamptz not null,
  primary key (project, item_uid, instance)
);

-- GitHub webhook deliveries already handled, so a replay queues nothing.
create table if not exists github_deliveries (
  id text primary key,
  at timestamptz not null default now()
);

-- Plugin instances the server keeps per project and repo.
create table if not exists plugin_instances (
  project    text not null,
  repo       text not null,
  plugin     text not null,
  id         text not null,
  def        jsonb not null,
  position   integer not null default 0,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (project, repo, plugin, id)
);
-- Secret-type settings, encrypted apart from def, which names none of them.
alter table plugin_instances add column if not exists secret_keys text[] not null default '{}';
alter table plugin_instances add column if not exists secrets_enc text;

-- Capabilities a person granted a plugin, e.g. post-request.
create table if not exists plugin_grants (
  project      text not null,
  repo         text not null,
  plugin       text not null,
  capabilities text[] not null default '{}',
  granted_by   text not null,
  granted_at   timestamptz not null default now(),
  primary key (project, repo, plugin)
);

-- Connection credentials, encrypted under TODO_SECRET_KEY; never read back out.
create table if not exists plugin_credentials (
  project    text not null,
  repo       text not null,
  connection text not null,
  secret_enc text not null,
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (project, repo, connection)
);
-- endpoint: where the connection pointed when the credential was given. It is
-- handed out only while the connection still points there, and only for a
-- connection the repo's config declares; any other row is dropped.
alter table plugin_credentials add column if not exists endpoint text;
delete from plugin_credentials c
 where c.endpoint is null
    or not exists (select 1 from plugin_configs p where p.project = c.project and p.repo = c.repo and p.connections ? c.connection);

-- A project's own connections, set on Settings → Automation, which plugins that
-- ship with todo use in every repo of the project in place of the server's of
-- that name. The secret is encrypted under TODO_SECRET_KEY for the endpoint it
-- was given for; private_ok records who let todo call a private address, and
-- for which endpoint. version counts its saves, so a stale page's save is refused.
create table if not exists project_connections (
  project         text not null,
  name            text not null,
  def             jsonb not null,
  secret_enc      text,
  secret_endpoint text,
  private_ok      jsonb,
  version         integer not null default 1,
  updated_by      text not null,
  updated_at      timestamptz not null default now(),
  primary key (project, name)
);

-- The plugin outbox: one row per event on an item, queued with what caused it
-- and delivered after the request or by the tick. only_plugins narrows an
-- every: floor's refresh to the plugins that were due.
create table if not exists plugin_events (
  id              bigserial primary key,
  project         text not null,
  item_uid        text not null,
  repo            text not null,
  event           jsonb not null,
  only_plugins    text[],
  by              text not null,
  attempts        integer not null default 0,
  error           text,
  errors          jsonb,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  done_at         timestamptz,
  created         timestamptz not null default now()
);
create index if not exists plugin_events_due on plugin_events (id) where done_at is null;
-- lease: who holds the row; finished: plugin/instance pairs already delivered, skipped when it's delivered again.
alter table plugin_events add column if not exists lease text;
alter table plugin_events add column if not exists finished text[] not null default '{}';

-- Each instance's run log: what fired it, its result, and what was applied.
create table if not exists plugin_runs (
  id       bigserial primary key,
  event_id bigint,
  project  text not null,
  item_uid text not null,
  repo     text not null,
  plugin   text not null,
  instance text not null,
  event    jsonb not null,
  result   jsonb not null,
  applied  jsonb not null default '[]'::jsonb,
  at       timestamptz not null default now()
);
alter table plugin_runs add column if not exists dry_run boolean not null default false;
create index if not exists plugin_runs_instance on plugin_runs (project, repo, plugin, instance, id);
create index if not exists plugin_runs_item on plugin_runs (project, item_uid, plugin, instance, id);
`;
