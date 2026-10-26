// The server's plugin runner: delivers queued events through the plugin host
// and writes what each run attached into the item, so every CLI receives it;
// hears GitHub's webhooks; and, on a tick, polls repos without webhooks and
// runs every: floors. What it keeps per repo lives in ./store.
// See docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §3–§4.
import crypto from "node:crypto";
import type { Db, Row } from "../db";
import { applyOps, type Op, type Result } from "../apply";
import { checkoutDir, projectsAllowed, repoAllowed, repoKey } from "../checkouts";
import { DocError, docByName, issueUpload, recordDoc, removeDoc } from "../docs";
import { docType, putObject } from "../files";
import { PLUGINS_DIR, scheduleRecompute, type Fetch } from "../gitfacts";
import { githubApi } from "../github";
import { itemBranches } from "../model";
import { jiraReadOnly } from "../jira/config";
import { hashUid, ulid } from "../ulid";
import { runEvent, type EventRun, type HostDeps } from "./host";
import { REPO_CODE_DEADLINE_MS } from "./code-runner";
import { finished, PLUGIN_HANDLE, pluginsEnabled, queuePluginEvent } from "./queue";
import {
  guardFor, hostConnections, hostSecrets, invalidateDefs, loadDefs, merge, message, repoSecrets, storedGrants, storedInstances,
  type PluginInfo, type RepoDefs,
} from "./store";
import { parseDuration } from "./triggers";
import { DEFAULT_DEADLINE_MS, POST_REQUEST, type Attachment, type InstanceDef, type PluginEvent, type PluginItem } from "./types";

export { PLUGIN_HANDLE } from "./queue";
const ACTOR = { handle: PLUGIN_HANDLE, bridge: true, unconditional: true };
export const MAX_ATTEMPTS = 4;
/** Renewed before each instance runs, so it must outlast one instance's deadline, with room to apply what it attached. */
export const LEASE_MS = Math.max(DEFAULT_DEADLINE_MS, REPO_CODE_DEADLINE_MS) + 2 * 60_000;
/** Events delivered by one flush after a request; the tick takes more. */
export const FLUSH_EVENTS = 5;
export const TICK_EVENTS = 50;
export const RUNS_KEPT = 20;
const DAYS_KEPT = 7;
const BRANCH_PAGE = 100;
/** A repo whose push webhook arrived within this long isn't polled. */
const HOOK_FRESH_MINUTES = 60;
export const MAX_HOOK_BYTES = 5 * 1024 * 1024;

export interface RunnerDeps {
  /** GitHub for definitions and tips, and, in tests, the plugins' own connections (unpinned). */
  fetch?: Fetch;
  /** The host's own dependencies; of a guard, only its lookup is taken, since the allow lists come from the environment. */
  host?: HostDeps;
}

const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** JSON Postgres accepts: it refuses NUL in text, which a plugin can put in anything it returns. */
const pgJson = (v: unknown) => JSON.stringify(v).replace(/\\u0000/g, "\\ufffd");
const instanceKey = (plugin: string, instance: InstanceDef | string) => `${plugin}/${typeof instance === "string" ? instance : instance.id}`;

/** Stored instances that switch off every plugin outside `only`, so a refresh runs just the ones due. */
function narrowed(stored: Record<string, InstanceDef[]>, plugins: PluginInfo[], only: string[] | null): Record<string, InstanceDef[]> {
  if (!only) return stored;
  const out = { ...stored };
  for (const p of plugins) if (!only.includes(p.name)) out[p.name] = p.instances.map((i) => ({ ...i, enabled: false }));
  return out;
}

// ── the item a plugin sees ────────────────────────────────────────────────────
export async function pluginItem(d: Pick<Db, "query">, project: string, it: Row, by: string): Promise<PluginItem> {
  const x = it.extra ?? {};
  const repo = repoKey(x.repo);
  const [owner, name] = repo ? repo.split("/") : [null, null];
  const notes = await d.query("select text, meta from notes where project = $1 and item_uid = $2 and kind = 'link' order by n",
    [project, it.uid]);
  const requests = await d.query(
    `select text from notes where project = $1 and item_uid = $2 and kind = 'ticket-request'
      order by coalesce((meta->>'version')::int, 1) desc, n desc`, [project, it.uid]);
  const docs = await d.query(
    "select name, plugin, plugin_version from docs where project = $1 and item_uid = $2 and plugin is not null and sha256 = plugin_sha256",
    [project, it.uid]);
  const dir = repo ? (await checkoutDir(d as Db, project, repo, by)).dir : "";
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: it.id, uid: it.uid, title: it.title, type: it.type ?? null, status: it.status, priority: it.priority ?? null,
    repo: repo || null, repo_owner: owner, repo_name: name, branches: itemBranches(x), jira: x.jira ?? null,
    app: str(x.app), section: str(x.section), developer: it.developer ?? null, qa_assignee: it.qa_assignee ?? null, dir: dir || null,
    links: notes.map((n) => ({ type: String(n.meta?.type ?? "link"), url: String(n.meta?.url ?? n.text) })),
    requests: requests.map((r) => String(r.text ?? "")),
    docs: docs.map((r) => ({ name: r.name, plugin: r.plugin, version: r.plugin_version ?? null })),
  };
}

// ── applying a run ────────────────────────────────────────────────────────────
/** Note kinds a run replaces by key; logs and requests are only ever added. */
const REPLACED = ["link", "dependency"];

export const pluginUid = (instance: string, itemUid: string, key: string) => hashUid("plugin", instance, itemUid, key);
/** A request's uid key names the version it creates, so text that returns to an earlier version is a new one. */
export const requestKey = (key: string, version: number) => `${key}#v${version}`;
const sameUrl = (a: unknown, b: unknown) => String(a ?? "").replace(/\/+$/, "") === String(b ?? "").replace(/\/+$/, "");

function noteOf(a: Extract<Attachment, { kind: "link" | "edge" }>, instance: string): { kind: string; text: string; meta: Record<string, unknown> } {
  const own = { plugin: instance, plugin_key: a.key };
  if (a.kind === "link") return { kind: "link", text: a.label || a.url, meta: { url: a.url, type: a.type, label: a.label ?? null, ...own } };
  return { kind: "dependency", text: a.because, meta: { needs: a.needs, in: a.in ?? null, because: a.because, ...own } };
}

interface Applied { applied: string[]; log: string[]; edges: boolean }

/** Write one run's attachments: create what's new, set what changed, remove what's gone. The caller holds the item's lock. */
async function applyRun(t: Db, project: string, it: Row, run: EventRun, grants: string[]): Promise<Applied> {
  const instance = instanceKey(run.plugin, run.instance);
  const log: string[] = [];
  const applied: string[] = [];
  const notes = await t.query("select uid, kind, text, meta from notes where project = $1 and item_uid = $2", [project, it.uid]);
  const mine = notes.filter((n) => n.meta?.plugin === instance && REPLACED.includes(n.kind));
  const keep = new Set<string>();
  const ops: Op[] = [];
  const op = (o: Omit<Op, "op_id" | "item_uid">) => ops.push({ op_id: ulid(), item_uid: it.uid, ...o } as Op);
  const docs: Extract<Attachment, { kind: "doc" }>[] = [];
  const urls = new Set<string>();
  for (const a of run.result.attached) {
    const uid = pluginUid(instance, it.uid, a.key);
    if (a.kind === "link" || a.kind === "edge") {
      if (a.kind === "link") {
        const other = notes.find((n) => n.uid !== uid && n.kind === "link" && sameUrl(n.meta?.url ?? n.text, a.url));
        if (other || urls.has(a.url)) {
          log.push(`skipped ${a.url}: already linked on the item`);
          continue;
        }
        urls.add(a.url);
      }
      keep.add(uid);
      applied.push(uid);
      const want = noteOf(a, instance);
      const have = notes.find((n) => n.uid === uid);
      if (!have) {
        op({ op: "create", entity: "note", uid, data: want });
        continue;
      }
      const data: Record<string, unknown> = {};
      if (have.text !== want.text) data.text = want.text;
      if (have.kind !== want.kind) data.kind = want.kind;
      for (const [k, v] of Object.entries(want.meta)) if (JSON.stringify(have.meta?.[k] ?? null) !== JSON.stringify(v)) data[`meta.${k}`] = v;
      if (Object.keys(data).length) op({ op: "set", entity: "note", uid, data });
    } else if (a.kind === "log") {
      applied.push(uid);
      op({ op: "create", entity: "log", uid, data: { text: a.text } });
    } else if (a.kind === "request") {
      if (!grants.includes(POST_REQUEST)) {
        log.push(`dropped a request: ${run.plugin} hasn't been granted ${POST_REQUEST}`);
        continue;
      }
      const [current] = await t.query(
        `select text, coalesce((meta->>'version')::int, 1) as version from notes where project = $1 and item_uid = $2 and kind = 'ticket-request'
          order by coalesce((meta->>'version')::int, 1) desc, n desc limit 1`, [project, it.uid]);
      if (current?.text === a.text) continue;
      const key = requestKey(a.key, current ? Number(current.version) + 1 : 1);
      const ruid = pluginUid(instance, it.uid, key);
      applied.push(ruid);
      op({ op: "create", entity: "note", uid: ruid, data: { kind: "ticket-request", text: a.text, meta: { plugin: instance, plugin_key: key } } });
    } else {
      docs.push(a);
    }
  }
  for (const n of mine) if (!keep.has(n.uid)) op({ op: "remove", entity: "note", uid: n.uid, plugin: true });
  const results = ops.length ? await applyOps(t, project, ops, ACTOR) : [];
  results.forEach((r, i) => {
    const why = refused(r, ops[i]);
    if (why) log.push(why);
  });
  applied.push(...await applyDocs(t, project, it.uid, run, docs, log));
  const edgeUids = new Set([...run.result.attached.filter((a) => a.kind === "edge").map((a) => pluginUid(instance, it.uid, a.key)),
                            ...mine.filter((n) => n.kind === "dependency").map((n) => n.uid)]);
  return { applied, log, edges: ops.some((o) => edgeUids.has(o.uid)) };
}

function refused(r: Result, o: Op): string | null {
  if (r.status === "applied" && !r.rejected?.length) return null;
  if (r.reason === "removed") return `${o.entity} ${o.uid} was removed from the item by a person, so it isn't added again`;
  if (r.reason === "uid-exists" && o.entity === "log") return null;
  const why = r.reason === "error" && r.message ? `error: ${r.message}` : r.reason ?? r.rejected?.map((x) => `${x.field} ${x.reason}`).join(", ");
  return `${o.op} ${o.entity} ${o.uid} was refused: ${why}`;
}

/** The plugin may change a doc it wrote that no one has edited since. */
const ownDoc = (doc: Row | null, instance: string) => !!doc && doc.plugin === instance && doc.sha256 === doc.plugin_sha256;

/** Docs a run attached, and the ones it attached on its last real run and no longer does. */
async function applyDocs(t: Db, project: string, itemUid: string, run: EventRun, docs: Extract<Attachment, { kind: "doc" }>[],
                         log: string[]): Promise<string[]> {
  const instance = instanceKey(run.plugin, run.instance);
  const applied: string[] = [];
  const [prev] = await t.query(
    `select applied from plugin_runs where project = $1 and item_uid = $2 and plugin = $3 and instance = $4 and not dry_run
        and result->>'error' is null and result->>'skipped' is null order by id desc limit 1`, [project, itemUid, run.plugin, run.instance.id]);
  const before = ((prev?.applied ?? []) as string[]).filter((a) => a.startsWith("doc:")).map((a) => a.slice(4));
  try {
    for (const a of docs) {
      if (a.unchanged) {
        const held = await docByName(t, project, itemUid, a.name);
        if (ownDoc(held, instance)) applied.push(`doc:${a.name}`);
        else log.push(`doc ${a.name} was written or edited by someone else, so the plugin leaves it alone`);
        continue;
      }
      if (a.content === undefined) {
        log.push(`doc ${a.name}: the host returned no content for it`);
        continue;
      }
      const bytes = Buffer.from(a.content, a.encoding === "base64" ? "base64" : "utf8");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const existing = await docByName(t, project, itemUid, a.name);
      if (existing && !ownDoc(existing, instance)) {
        log.push(`doc ${a.name} was written or edited by someone else, so the plugin leaves it alone`);
        continue;
      }
      applied.push(`doc:${a.name}`);
      if (existing?.sha256 === sha256) {
        if ((existing.plugin_version ?? null) !== (a.version ?? null)) {
          await t.query("update docs set plugin_version = $3 where project = $1 and uid = $2", [project, existing.uid, a.version ?? null]);
        }
        continue;
      }
      const key = await issueUpload(t, project, itemUid, a.name, bytes.length);
      await putObject(key, bytes, docType(a.name));
      const r = await recordDoc(t, project, PLUGIN_HANDLE, { item_uid: itemUid, name: a.name, file_key: key, base: existing?.sha256 ?? null,
                                                           sha256, plugin: instance, plugin_version: a.version ?? null });
      if (r.status === "conflict") log.push(`doc ${a.name} changed while it was written; kept the newer one`);
    }
    const now = new Set(applied.map((a) => a.slice(4)));
    for (const name of before.filter((n) => !now.has(n))) {
      const doc = await docByName(t, project, itemUid, name);
      if (ownDoc(doc, instance)) await removeDoc(t, project, PLUGIN_HANDLE, doc!.uid, doc!.sha256);
      else if (doc) log.push(`doc ${name} was edited since the plugin wrote it, so it stays`);
    }
  } catch (e) {
    if (!(e instanceof DocError)) throw e;
    log.push(`docs: ${e.message}`);
  }
  return applied;
}

// ── the per-item lock ─────────────────────────────────────────────────────────
const LOCK_TTL_MS = 2 * 60_000;

export interface LockOptions { pollMs?: number; waitMs?: number; renewMs?: number }

/** Run `fn` holding the lease on one item and instance, a row in plugin_locks, so two deliveries never apply the same
 * instance to an item at once. It needs nothing of the connection between statements, so it holds behind a
 * transaction-mode pooler; a crashed holder's lease runs out. */
export async function withItemLock<T>(d: Pick<Db, "query">, project: string, itemUid: string, instance: string, fn: () => Promise<T>,
                                      opts: LockOptions = {}): Promise<T> {
  const holder = ulid();
  const ttl = `${LOCK_TTL_MS} milliseconds`;
  const key = [project, itemUid, instance];
  const giveUp = Date.now() + (opts.waitMs ?? LOCK_TTL_MS);
  for (;;) {
    const [got] = await d.query(
      `insert into plugin_locks (project, item_uid, instance, holder, expires_at) values ($1, $2, $3, $4, now() + $5::interval)
       on conflict (project, item_uid, instance) do update set holder = excluded.holder, expires_at = excluded.expires_at
         where plugin_locks.expires_at < now()
       returning holder`, [...key, holder, ttl]);
    if (got) break;
    if (Date.now() >= giveUp) throw new Transport(`${instance} on ${itemUid} is busy in another delivery`);
    await new Promise((done) => setTimeout(done, opts.pollMs ?? 250));
  }
  const renew = setInterval(() => {
    void d.query("update plugin_locks set expires_at = now() + $5::interval where project = $1 and item_uid = $2 and instance = $3 and holder = $4",
                 [...key, holder, ttl]).catch(() => undefined);
  }, opts.renewMs ?? LOCK_TTL_MS / 3);
  try {
    return await fn();
  } finally {
    clearInterval(renew);
    await d.query("delete from plugin_locks where project = $1 and item_uid = $2 and instance = $3 and holder = $4", [...key, holder]);
  }
}

// ── delivery ──────────────────────────────────────────────────────────────────
/** A failure that may pass: GitHub unreachable before any plugin ran, or a read-only run that failed transiently. */
class Transport extends Error {}
/** Another delivery took the event over. */
class LeaseLost extends Error {}

const STILL_OPEN = `i.uid is not null and i.status not in ('done', 'deployed', 'cancelled')
  and coalesce(i.extra->'archived', 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb)`;

/** A doc's content as its size and hash, for the run log. */
function withoutContent(a: Attachment): Record<string, unknown> {
  if (a.kind !== "doc" || a.content === undefined) return a;
  const { content, ...rest } = a;
  const bytes = Buffer.from(content, a.encoding === "base64" ? "base64" : "utf8");
  return { ...rest, size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

async function recordRun(t: Pick<Db, "query">, row: Row, run: EventRun, outcome: Applied | null): Promise<void> {
  const logged = { ...run.result, attached: run.result.attached.map(withoutContent) };
  const result = outcome?.log.length ? { ...logged, log: [...run.result.log, ...outcome.log] } : logged;
  await t.query(
    `insert into plugin_runs (event_id, project, item_uid, repo, plugin, instance, event, result, applied, dry_run)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)`,
    [row.id, row.project, row.item_uid, row.repo, run.plugin, run.instance.id, pgJson(row.event), pgJson(result),
     pgJson(outcome?.applied ?? []), !!run.instance.dry_run]);
  // Each instance keeps its last RUNS_KEPT runs, and its last run on each open item, which names the docs it attached there.
  await t.query(
    `delete from plugin_runs where id in (
       select r.id from (
         select id, item_uid, row_number() over (order by id desc) as n_instance,
                row_number() over (partition by item_uid order by id desc) as n_item
           from plugin_runs where project = $1 and repo = $2 and plugin = $3 and instance = $4) r
         left join items i on i.project = $1 and i.uid = r.item_uid
        where r.n_instance > $5 and (r.n_item > 1 or not (${STILL_OPEN})))`, [row.project, row.repo, run.plugin, run.instance.id, RUNS_KEPT]);
}

/** The server's guard: no private addresses, except the hosts TODO_PLUGIN_ALLOW_HOSTS opens to this repo's runs. */
function hostDeps(deps: RunnerDeps, repo: string): HostDeps {
  const { guard, ...rest } = deps.host ?? {};
  return { fetch: deps.fetch, ...rest, guard: guardFor(repo, guard?.lookup) };
}

async function deliver(d: Db, row: Row, deps: RunnerDeps): Promise<string[]> {
  const f = deps.fetch ?? fetch;
  const [it] = await d.query("select * from items where project = $1 and uid = $2", [row.project, row.item_uid]);
  if (!it) return ["the item is gone"];
  if (!(await repoAllowed(d, row.project, row.repo))) return [`${row.repo} isn't one of this project's repos`];
  let defs: RepoDefs;
  try {
    defs = await loadDefs(d, row.repo, f);
  } catch (e) {
    throw new Transport(`couldn't read ${row.repo}'s ${PLUGINS_DIR}: ${message(e)}`);
  }
  const stored = await storedInstances(d, row.project, row.repo, { secrets: true });
  const grants = await storedGrants(d, row.project, row.repo);
  const merged = merge(defs, stored);
  const connections = hostConnections();
  const done = new Set<string>(row.finished ?? []);
  let edges = false;
  let retry = false;
  const holds = async (sql: string, params: unknown[]) => {
    const [held] = await d.query(sql, params);
    if (!held) throw new LeaseLost(`event ${row.id} was taken over by another delivery`);
  };
  const out = await runEvent({
    repo: defs.text === undefined ? undefined : { text: defs.text, files: defs.files },
    hostConnections: connections,
    secrets: { repo: await repoSecrets(d, row.project, row.repo), host: hostSecrets(connections) },
    storedInstances: narrowed(stored, merged.plugins, row.only_plugins ?? null),
    grants, item: await pluginItem(d, row.project, it, row.by), event: row.event as PluginEvent, repoKey: row.repo,
    allowRepoCommands: false, dryRunConnections: jiraReadOnly() ? ["jira"] : undefined,
  }, hostDeps(deps, row.repo), {
    before: async (plugin, instance) => {
      if (done.has(instanceKey(plugin, instance))) return false;
      await holds("update plugin_events set claimed_at = now() where id = $1 and lease = $2 returning id", [row.id, row.lease]);
      return true;
    },
    after: async (run) => {
      const key = instanceKey(run.plugin, run.instance);
      // One run at a time per item and instance, from read through apply; each unit of ops commits on its own.
      const outcome = await withItemLock(d, row.project, row.item_uid, key, async () => {
        await holds("select 1 from plugin_events where id = $1 and lease = $2", [row.id, row.lease]);
        let applied: Applied | null = null;
        if (run.instance.dry_run) applied = { applied: [], log: ["dry run: nothing was attached"], edges: false };
        else if (!run.result.error && !run.result.skipped) {
          const [fresh] = await d.query("select * from items where project = $1 and uid = $2", [row.project, row.item_uid]);
          if (fresh) applied = await applyRun(d, row.project, fresh, run, grants[run.plugin] ?? []);
        }
        await recordRun(d, row, run, applied);
        if (!run.result.transient) {
          await holds("update plugin_events set finished = array_append(finished, $3) where id = $1 and lease = $2 returning id",
            [row.id, row.lease, key]);
        }
        return applied;
      });
      edges ||= !!outcome?.edges;
      retry ||= !!run.result.transient;
    },
  });
  if (edges) void scheduleRecompute(d, row.project, f, row.repo);
  if (retry) throw new Transport(`a read-only run failed for now; it runs again`);
  return out.errors;
}

/** Deliver up to `limit` due events: each leased, retried with backoff when the failure may pass, given up after MAX_ATTEMPTS. */
export async function flushPluginRuns(d: Db, deps: RunnerDeps = {}, limit = FLUSH_EVENTS): Promise<{ ran: number; failed: number }> {
  if (!pluginsEnabled()) return { ran: 0, failed: 0 };
  const lease = `${LEASE_MS} milliseconds`;
  await d.query(
    `update plugin_events set claimed_at = null, lease = null, done_at = now(), error = coalesce(error, 'the process stopped during the last attempt')
      where done_at is null and attempts >= $1 and claimed_at < now() - $2::interval`, [MAX_ATTEMPTS, lease]);
  const due = await d.query(
    `select id from plugin_events
      where done_at is null and attempts < $1 and (next_attempt_at is null or next_attempt_at <= now())
        and (claimed_at is null or claimed_at < now() - $2::interval)
      order by id limit $3`, [MAX_ATTEMPTS, lease, limit]);
  let ran = 0;
  let failed = 0;
  for (const { id } of due) {
    const [row] = await d.query(
      `update plugin_events set attempts = attempts + 1, claimed_at = now(), lease = $3
        where id = $1 and done_at is null and (claimed_at is null or claimed_at < now() - $2::interval)
        returning *`, [id, lease, ulid()]);
    if (!row) continue;
    try {
      const errors = await deliver(d, row, deps);
      await d.query("update plugin_events set done_at = now(), claimed_at = null, lease = null, error = null, errors = $3::jsonb where id = $1 and lease = $2",
        [row.id, row.lease, pgJson(errors)]);
      ran++;
    } catch (e) {
      if (e instanceof LeaseLost) continue;
      const last = row.attempts >= MAX_ATTEMPTS || !(e instanceof Transport);
      await d.query(
        `update plugin_events set error = $3, claimed_at = null, lease = null, done_at = case when $5 then now() end,
           next_attempt_at = now() + make_interval(secs => $4) where id = $1 and lease = $2`,
        [row.id, row.lease, message(e), 30 * 2 ** (row.attempts - 1), last]);
      if (!(e instanceof Transport)) console.error(`plugins: event ${row.id} failed:`, e);
      failed++;
    }
  }
  return { ran, failed };
}

// ── GitHub events ─────────────────────────────────────────────────────────────
interface ItemRef { project: string; uid: string; status: string; extra: Row }

/** Items in any project on `branch` of `repo` that still run plugins for their branches. */
export async function itemsOnBranch(d: Pick<Db, "query">, repo: string, branch: string): Promise<ItemRef[]> {
  const rows = await d.query(
    `select project, uid, status, extra from items
      where extra->'branches' @> jsonb_build_array($1::text) and status not in ('done', 'deployed', 'cancelled')`, [branch]);
  return rows.filter((r) => !finished(r) && repoKey(r.extra?.repo) === repo) as ItemRef[];
}

async function queueBranch(d: Db, repo: string, branch: string, event: PluginEvent): Promise<number> {
  const items = await itemsOnBranch(d, repo, branch);
  return d.tx(async (t) => {
    let queued = 0;
    for (const it of items) if ((await queuePluginEvent(t, it.project, it.uid, repo, event, PLUGIN_HANDLE)) !== null) queued++;
    return queued;
  });
}

/** Deployment states after which there's something to look at. */
const DEPLOYED = ["success", "failure", "error"];
const PR_ACTIONS = ["opened", "reopened", "closed", "ready_for_review"];

export interface HookOutcome { repo: string | null; queued: number; projects: string[]; duplicate?: boolean }

const deliveryKeys = (id: string | null, body: string) =>
  [`body:${crypto.createHash("sha256").update(body).digest("hex")}`, ...(id ? [`id:${id.slice(0, 200)}`] : [])];

class Duplicate extends Error {}

/** Handle a webhook delivery once: its id and its signed body's hash (which a replay under a fresh id keeps) are claimed in the
 * transaction that queues its events, so a parallel copy waits and finds them taken, and a failure releases them for
 * GitHub's redelivery. Null for a copy already handled. */
export async function handleDelivery(d: Db, id: string | null, body: string, kind: string, payload: unknown): Promise<HookOutcome | null> {
  await d.query("delete from github_deliveries where at < now() - make_interval(days => $1)", [DAYS_KEPT]);
  try {
    return await d.tx(async (t) => {
      for (const key of deliveryKeys(id, body)) {
        const [claimed] = await t.query("insert into github_deliveries (id) values ($1) on conflict do nothing returning id", [key]);
        if (!claimed) throw new Duplicate();
      }
      return githubEvent(t, kind, payload);
    });
  } catch (e) {
    if (e instanceof Duplicate) return null;
    throw e;
  }
}

/** A GitHub webhook delivery: queue the event for the items on its branch, and say which projects' git facts it moves. */
export async function githubEvent(d: Db, kind: string, payload: unknown): Promise<HookOutcome> {
  const body = isMap(payload) ? payload : {};
  const repo = repoKey(body.repository?.full_name);
  if (!repo) return { repo: null, queued: 0, projects: [] };
  let queued = 0;
  if (kind === "push" && typeof body.ref === "string" && body.ref.startsWith("refs/heads/")) {
    const branch = body.ref.slice("refs/heads/".length);
    await d.query(`insert into repo_polls (repo, hook_at) values ($1, now()) on conflict (repo) do update set hook_at = excluded.hook_at`, [repo]);
    if (body.deleted) await d.query("update repo_polls set tips = tips - $2::text where repo = $1", [repo, branch]);
    else if (typeof body.after === "string") {
      await d.query("update repo_polls set tips = tips || jsonb_build_object($2::text, $3::text) where repo = $1", [repo, branch, body.after]);
    }
    if (branch === body.repository?.default_branch) await invalidateDefs(d, repo);
    if (!body.deleted) queued = await queueBranch(d, repo, branch, { type: "push", branch });
  } else if (kind === "pull_request" && typeof body.pull_request?.head?.ref === "string"
             && (PR_ACTIONS.includes(body.action) || (body.action === "edited" && isMap(body.changes?.base)))) {
    const branch = body.pull_request.head.ref;
    queued = await queueBranch(d, repo, branch, { type: "pr", branch });
  } else if (kind === "deployment_status" && typeof body.deployment?.ref === "string" && DEPLOYED.includes(body.deployment_status?.state)) {
    const branch = body.deployment.ref;
    return { repo, queued: await queueBranch(d, repo, branch, { type: "deployment", branch }), projects: [] };
  } else {
    return { repo, queued: 0, projects: [] };
  }
  return { repo, queued, projects: await projectsAllowed(d, repo) };
}

export function signatureValid(body: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/** A request body as text, or null once it passes `max` bytes. */
export async function readCapped(req: Request, max = MAX_HOOK_BYTES): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── the tick ──────────────────────────────────────────────────────────────────
type OpenItem = ItemRef & { repo: string };

/** Items that still run plugins for their branches, in repos their projects may use. */
async function openItems(d: Db): Promise<OpenItem[]> {
  const rows = await d.query("select project, uid, status, extra from items where extra ? 'repo' and status not in ('done', 'deployed', 'cancelled')");
  const allowed = new Map<string, boolean>();
  const out: OpenItem[] = [];
  for (const r of rows) {
    const repo = repoKey(r.extra?.repo);
    if (!repo || finished(r)) continue;
    const k = `${r.project}\x1f${repo}`;
    if (!allowed.has(k)) allowed.set(k, await repoAllowed(d, r.project, repo));
    if (allowed.get(k)) out.push({ project: r.project, uid: r.uid, status: r.status, extra: r.extra, repo });
  }
  return out;
}

interface Page { etag: string | null; tips: Record<string, string> }

/** Every branch's tip, each page asked with its own ETag, so an unchanged first page never hides a later one that moved. */
async function branchPages(repo: string, before: Page[], f: Fetch): Promise<Page[]> {
  const token = process.env.GITHUB_TOKEN;
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
                    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const pages: Page[] = [];
  for (let page = 1; ; page++) {
    const known = before[page - 1];
    const res = await f(`${githubApi()}/repos/${repo}/branches?per_page=${BRANCH_PAGE}&page=${page}`, {
      signal: AbortSignal.timeout(10_000), headers: { ...headers, ...(known?.etag ? { "if-none-match": known.etag } : {}) },
    });
    let got: Page;
    if (res.status === 304 && known) got = known;
    else if (!res.ok) throw new Error(`GitHub GET /repos/${repo}/branches: ${res.status}`);
    else {
      const rows = (await res.json()) as { name: string; commit: { sha: string } }[];
      got = { etag: res.headers.get("etag"), tips: Object.fromEntries(rows.map((r) => [r.name, r.commit.sha])) };
    }
    pages.push(got);
    if (Object.keys(got.tips).length < BRANCH_PAGE) return pages;
  }
}

/** Poll repos with open items and no recent push webhook; a moved tip queues a push for its items. */
async function pollRepos(d: Db, items: OpenItem[], f: Fetch): Promise<{ polled: number; queued: number }> {
  const repos = [...new Set(items.map((it) => it.repo))].sort();
  let polled = 0;
  let queued = 0;
  for (const repo of repos) {
    const [state] = await d.query("select * from repo_polls where repo = $1", [repo]);
    if (state?.hook_at && Date.now() - new Date(state.hook_at).getTime() < HOOK_FRESH_MINUTES * 60_000) continue;
    let pages: Page[];
    try {
      pages = await branchPages(repo, state?.pages ?? [], f);
    } catch (e) {
      console.error(`plugins: polling ${repo}: ${message(e)}`);
      continue;
    }
    polled++;
    const tips = Object.assign({}, ...pages.map((p) => p.tips)) as Record<string, string>;
    const before: Record<string, string> | null = state?.polled_at ? state.tips ?? {} : null;
    if (before) {
      const moved = Object.keys(tips).filter((b) => before[b] !== tips[b]);
      const [defs] = await d.query("select default_branch from plugin_defs where repo = $1", [repo]);
      if (defs?.default_branch && moved.includes(defs.default_branch)) await invalidateDefs(d, repo);
      for (const branch of moved) queued += await queueBranch(d, repo, branch, { type: "push", branch });
    }
    await d.query(
      `insert into repo_polls (repo, pages, tips, polled_at) values ($1, $2::jsonb, $3::jsonb, now())
       on conflict (repo) do update set pages = excluded.pages, tips = excluded.tips, polled_at = excluded.polled_at`,
      [repo, JSON.stringify(pages), JSON.stringify(tips)]);
  }
  return { polled, queued };
}

/** Queue a refresh for each open item with an every: floor that has come due. */
async function queueFloors(d: Db, items: OpenItem[], f: Fetch): Promise<number> {
  const byRepo = new Map<string, OpenItem[]>();
  for (const it of items) byRepo.set(it.repo, [...(byRepo.get(it.repo) ?? []), it]);
  let queued = 0;
  for (const [repo, list] of byRepo) {
    let defs: RepoDefs;
    try {
      defs = await loadDefs(d, repo, f);
    } catch (e) {
      console.error(`plugins: reading ${repo}'s ${PLUGINS_DIR}: ${message(e)}`);
      continue;
    }
    const perProject = new Map<string, PluginInfo[]>();
    for (const it of list) {
      if (!perProject.has(it.project)) {
        const { plugins } = merge(defs, await storedInstances(d, it.project, repo));
        perProject.set(it.project, plugins.filter((p) => p.every && p.instances.some((i) => i.enabled !== false)));
      }
      const floored = perProject.get(it.project)!;
      if (!floored.length) continue;
      const [pending] = await d.query(
        "select 1 from plugin_events where project = $1 and item_uid = $2 and done_at is null and event->>'type' = 'refresh'",
        [it.project, it.uid]);
      if (pending) continue;
      const last = new Map((await d.query(
        `select plugin, extract(epoch from now() - max(at)) * 1000 as age from plugin_runs
          where project = $1 and item_uid = $2 group by plugin`, [it.project, it.uid])).map((r) => [r.plugin, Number(r.age)]));
      const due = floored.filter((p) => {
        let every: number;
        try {
          every = parseDuration(p.every!);
        } catch {
          return false;
        }
        return !last.has(p.name) || last.get(p.name)! >= every;
      });
      if (!due.length) continue;
      if ((await queuePluginEvent(d, it.project, it.uid, repo, { type: "refresh" }, PLUGIN_HANDLE, due.map((p) => p.name))) !== null) queued++;
    }
  }
  return queued;
}

export interface TickResult { ran: number; failed: number; polled: number; pushes: number; refreshes: number }

/** The cron tick: poll repos without webhooks, queue due every: floors, and deliver what's due. */
export async function pluginTick(d: Db, deps: RunnerDeps = {}): Promise<TickResult> {
  if (!pluginsEnabled()) return { ran: 0, failed: 0, polled: 0, pushes: 0, refreshes: 0 };
  const f = deps.fetch ?? fetch;
  const items = await openItems(d);
  const { polled, queued: pushes } = await pollRepos(d, items, f);
  const refreshes = await queueFloors(d, items, f);
  await d.query("delete from plugin_events where done_at < now() - make_interval(days => $1)", [DAYS_KEPT]);
  return { ...(await flushPluginRuns(d, deps, TICK_EVENTS)), polled, pushes, refreshes };
}
