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

create table if not exists applied_ops (
  project text not null,
  op_id   text not null,
  result  jsonb not null,
  created timestamptz not null default now(),
  primary key (project, op_id)
);

-- An item may link many Jira issues, and an issue may link items in several
-- projects. source 'import' is the link the bridge made when it imported the
-- issue (status and fields mirror); 'field' follows the item's extra.jira list
-- (request backfill and comments only).
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
alter table jira_links add column if not exists source text not null default 'import';
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
-- 'import' mirrors the project's jira_project; 'links' mirrors only the issues
-- its items link, from any Jira project.
alter table projects add column if not exists jira_mode text not null default 'import';
alter table projects add column if not exists jira_synced_at timestamptz;
alter table jira_files add column if not exists size bigint;
alter table projects add column if not exists jira_inbound jsonb;
alter table jira_links add column if not exists replayed_through bigint;
alter table projects add column if not exists jira_outbound jsonb;
alter table projects add column if not exists jira_settings_by text;
alter table projects add column if not exists jira_settings_at timestamptz;
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
`;
