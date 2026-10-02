-- Idempotent: `npm run migrate` applies the whole file on every deploy.

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
  uid         text primary key,
  project     text not null references projects(key),
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
  unique (project, id)
);

create table if not exists tasks (
  uid      text primary key,
  item_uid text not null references items(uid) on delete cascade,
  n        integer not null,
  title    text not null,
  status   text not null default 'todo',
  phase    integer,
  position double precision not null default 0,
  versions jsonb not null default '{}'::jsonb,
  unique (item_uid, n)
);

create table if not exists notes (
  uid      text primary key,
  item_uid text not null references items(uid) on delete cascade,
  n        integer not null,
  kind     text not null default 'context',
  author   text,
  via      text,
  ts       text not null,
  text     text not null,
  meta     jsonb not null default '{}'::jsonb,
  source   text,
  versions jsonb not null default '{}'::jsonb,
  unique (item_uid, n)
);

create table if not exists logs (
  uid      text primary key,
  item_uid text not null references items(uid) on delete cascade,
  n        integer not null,
  author   text,
  via      text,
  ts       text not null,
  text     text not null,
  versions jsonb not null default '{}'::jsonb,
  unique (item_uid, n)
);

create table if not exists checks (
  uid      text primary key,
  item_uid text not null references items(uid) on delete cascade,
  n        integer not null,
  kind     text not null,
  title    text not null,
  payload  text,
  timing   text not null default 'pre-deploy',
  status   text not null default 'pending',
  versions jsonb not null default '{}'::jsonb,
  unique (item_uid, n)
);

create table if not exists status_history (
  uid         text primary key,
  item_uid    text not null references items(uid) on delete cascade,
  n           integer not null,
  from_status text,
  to_status   text not null,
  by          text,
  via         text,
  forced      boolean not null default false,
  ts          text not null,
  unique (item_uid, n)
);

-- One row per changed entity. `seq` comes from projects.seq under the project's
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
create index if not exists changes_uid on changes (uid, seq);

create table if not exists tombstones (
  uid      text primary key,
  entity   text not null,
  item_uid text not null,
  seq      bigint not null
);

create table if not exists applied_ops (
  op_id   text primary key,
  project text not null,
  result  jsonb not null,
  created timestamptz not null default now()
);

create table if not exists jira_links (
  item_uid text primary key references items(uid) on delete cascade,
  jira_key text not null unique
);

create table if not exists jira_outbox (
  id       bigserial primary key,
  item_uid text not null,
  action   text not null,
  payload  jsonb not null,
  attempts integer not null default 0,
  error    text,
  result   jsonb,
  claimed_at      timestamptz,
  next_attempt_at timestamptz,
  done_at  timestamptz,
  created  timestamptz not null default now()
);

create table if not exists notifications (
  id       bigserial primary key,
  handle   text not null,
  kind     text not null,
  project  text not null,
  note_uid text,
  item_uid text not null,
  created  timestamptz not null default now(),
  read_at  timestamptz
);
create index if not exists notifications_handle on notifications (handle, read_at);
