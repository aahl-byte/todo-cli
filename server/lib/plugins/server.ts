// The server's plugin runner. It reads each repo's .todo-plugins/ from the
// default branch through GitHub, keeps instances, grants and credentials per
// project and repo, delivers queued events through the plugin host, and
// writes what each run attached into the item, so every CLI receives it.
// See docs/plans/2026-10-23-repo-plugins-git-facts-docs-design.md §3–§4.
import crypto from "node:crypto";
import type { Db, Row } from "../db";
import { applyOps, type Op, type Result } from "../apply";
import { checkoutDir, repoKey } from "../checkouts";
import { DocError, docByName, issueUpload, listDocs, recordDoc, removeDoc } from "../docs";
import { docType, putObject } from "../files";
import { PLUGINS_DIR, githubGet, NotFound, repoFile, scheduleRecompute, type Fetch } from "../gitfacts";
import { githubApi } from "../github";
import { itemBranches } from "../model";
import { hashUid, ulid } from "../ulid";
import { allInstances, pluginsFor, runEvent, type EventRun, type HostDeps, type Resolved } from "./host";
import { checkFile, parsePlugins } from "./load";
import { pluginsEnabled, queuePluginEvent } from "./queue";
import { decryptSecret, encryptSecret, NoSecretKey, secretKey } from "./secrets";
import { ALWAYS_ON } from "./shipped";
import { parseDuration } from "./triggers";
import {
  POST_REQUEST, type Attachment, type ConnectionDef, type InstanceDef, type PluginDef, type PluginEvent, type PluginItem, type PluginsFile,
  type RunResult, type Trigger,
} from "./types";

export const PLUGIN_HANDLE = "plugin";
const ACTOR = { handle: PLUGIN_HANDLE, bridge: true, unconditional: true };
const PLUGINS_YAML = "plugins.yaml";
export const MAX_ATTEMPTS = 4;
const LEASE_MINUTES = 10;
const BATCH = 20;
export const RUNS_KEPT = 20;
const EVENTS_KEPT_DAYS = 7;
const BRANCH_PAGE = 100;
/** A repo whose webhook delivered within this long isn't polled. */
const HOOK_FRESH_MINUTES = 60;
const CAPABILITIES = [POST_REQUEST];
const CONNECTION_NAME = /^[A-Za-z][\w-]*$/;

export interface RunnerDeps {
  /** Every outside call: GitHub for definitions and tips, and the plugins' own connections. */
  fetch?: Fetch;
  host?: HostDeps;
}

const isMap = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ── definitions ───────────────────────────────────────────────────────────────
export interface RepoDefs {
  /** plugins.yaml, or undefined when the default branch has none. */
  text?: string;
  /** The code files it names, by name. */
  files: Record<string, string>;
  sha: string | null;
  defaultBranch: string | null;
}

function defsOf(row: Row): RepoDefs {
  const { [PLUGINS_YAML]: text, ...files } = (row.files ?? {}) as Record<string, string>;
  return { text, files, sha: row.sha ?? null, defaultBranch: row.default_branch ?? null };
}

/** The repo's plugin files from its default branch, read again only once its head has moved. */
export async function loadDefs(d: Db, repo: string, f: Fetch = fetch): Promise<RepoDefs> {
  const [row] = await d.query("select * from plugin_defs where repo = $1", [repo]);
  if (row && !row.stale) return defsOf(row);
  const [owner, name] = repo.split("/");
  let sha: string | null = null;
  let defaultBranch: string | null = null;
  const files: Record<string, string> = {};
  try {
    defaultBranch = (await githubGet(`/repos/${owner}/${name}`, f)).default_branch ?? "main";
    sha = String((await githubGet(`/repos/${owner}/${name}/branches/${encodeURIComponent(defaultBranch!)}`, f)).commit.sha);
  } catch (e) {
    // A repo this token can't see runs only the shipped plugins.
    if (!(e instanceof NotFound)) throw e;
  }
  if (row && sha && row.sha === sha) {
    await d.query("update plugin_defs set stale = false, fetched_at = now() where repo = $1", [repo]);
    return defsOf(row);
  }
  if (sha) {
    const text = await repoFile(owner, name, `${PLUGINS_DIR}/${PLUGINS_YAML}`, sha, f);
    if (text !== null) {
      files[PLUGINS_YAML] = text;
      for (const def of Object.values(parsePlugins(text, { extraPlugins: ALWAYS_ON }).file.plugins ?? {})) {
        if (!def.code || def.code in files) continue;
        const code = await repoFile(owner, name, `${PLUGINS_DIR}/${def.code}`, sha, f);
        if (code !== null) files[def.code] = code;
      }
    }
  }
  const [saved] = await d.query(
    `insert into plugin_defs (repo, sha, default_branch, files, stale, fetched_at) values ($1, $2, $3, $4::jsonb, false, now())
     on conflict (repo) do update set sha = excluded.sha, default_branch = excluded.default_branch, files = excluded.files,
       stale = false, fetched_at = excluded.fetched_at
     returning *`, [repo, sha, defaultBranch, JSON.stringify(files)]);
  return defsOf(saved);
}

export async function invalidateDefs(d: Db, repo: string): Promise<void> {
  await d.query("update plugin_defs set stale = true where repo = $1", [repo]);
}

// ── instances, grants and the plugin list ─────────────────────────────────────
export async function storedInstances(d: Db, project: string, repo: string): Promise<Record<string, InstanceDef[]>> {
  const rows = await d.query("select plugin, def from plugin_instances where project = $1 and repo = $2 order by plugin, position, id",
    [project, repo]);
  const out: Record<string, InstanceDef[]> = {};
  for (const r of rows) (out[r.plugin] ??= []).push(r.def);
  return out;
}

export async function storedGrants(d: Db, project: string, repo: string): Promise<Record<string, string[]>> {
  const rows = await d.query("select plugin, capabilities from plugin_grants where project = $1 and repo = $2", [project, repo]);
  return Object.fromEntries(rows.map((r) => [r.plugin, r.capabilities ?? []]));
}

export class PluginInputError extends Error {}

/** Replace one plugin's stored instances in a repo. */
export async function putInstances(d: Db, project: string, repo: string, plugin: string, instances: unknown, handle: string): Promise<void> {
  if (!Array.isArray(instances)) throw new PluginInputError("instances must be a list");
  const { file, errors } = checkFile({ instances: { [plugin]: instances } }, { extraPlugins: [plugin] });
  if (errors.length) throw new PluginInputError(errors.join("; "));
  const list = file.instances?.[plugin] ?? [];
  await d.tx(async (t) => {
    await t.query("delete from plugin_instances where project = $1 and repo = $2 and plugin = $3", [project, repo, plugin]);
    for (const [i, inst] of list.entries()) {
      await t.query(
        `insert into plugin_instances (project, repo, plugin, id, def, position, updated_by) values ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [project, repo, plugin, inst.id, JSON.stringify(inst), i, handle]);
    }
  });
}

/** Set the capabilities granted to one plugin in a repo, recording who granted them. */
export async function putGrants(d: Db, project: string, repo: string, plugin: string, grants: unknown, handle: string): Promise<void> {
  if (!Array.isArray(grants) || !grants.every((g) => typeof g === "string")) throw new PluginInputError("grants must be a list of capability names");
  const unknown = grants.filter((g) => !CAPABILITIES.includes(g));
  if (unknown.length) throw new PluginInputError(`unknown capability: ${unknown.join(", ")}`);
  if (!grants.length) {
    await d.query("delete from plugin_grants where project = $1 and repo = $2 and plugin = $3", [project, repo, plugin]);
    return;
  }
  await d.query(
    `insert into plugin_grants (project, repo, plugin, capabilities, granted_by, granted_at) values ($1, $2, $3, $4, $5, now())
     on conflict (project, repo, plugin) do update set capabilities = excluded.capabilities, granted_by = excluded.granted_by,
       granted_at = excluded.granted_at`, [project, repo, plugin, [...new Set(grants)], handle]);
}

export interface PluginInfo {
  name: string;
  connections: string[];
  on: Trigger[];
  every: string | null;
  settings: PluginDef["settings"];
  instances: InstanceDef[];
  shipped: boolean;
}

interface Merged { file: PluginsFile; resolved: Resolved[]; plugins: PluginInfo[]; errors: string[] }

/** The plugins a repo runs: shipped ones and the repo file's, with every instance, switched off or not. */
function merge(defs: RepoDefs, stored: Record<string, InstanceDef[]>): Merged {
  const errors: string[] = [];
  let file: PluginsFile = {};
  let dropped: string[] = [];
  if (defs.text !== undefined) {
    const loaded = parsePlugins(defs.text, { extraPlugins: ALWAYS_ON });
    file = loaded.file;
    dropped = loaded.droppedInstances;
    errors.push(...loaded.errors);
  }
  const resolved = pluginsFor({ repo: defs.text === undefined ? undefined : { text: defs.text, files: defs.files } }, file, errors);
  const plugins = resolved.map(({ name, def, shipped }) => ({
    name, connections: def.connections ?? [], on: def.on ?? [], every: def.every ?? null, settings: def.settings ?? {},
    instances: allInstances(def, file.instances?.[name] ?? [], stored[name] ?? [], dropped.includes(name)), shipped,
  }));
  return { file, resolved, plugins, errors };
}

/** Stored instances that switch off every plugin outside `only`, so a refresh runs just the ones due. */
function narrowed(stored: Record<string, InstanceDef[]>, plugins: PluginInfo[], only: string[] | null): Record<string, InstanceDef[]> {
  if (!only) return stored;
  const out = { ...stored };
  for (const p of plugins) if (!only.includes(p.name)) out[p.name] = p.instances.map((i) => ({ ...i, enabled: false }));
  return out;
}

// ── connections and credentials ───────────────────────────────────────────────
const envName = (connection: string) => connection.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** Connections this server offers every repo: github, and those in TODO_PLUGIN_CONNECTIONS. */
export function hostConnections(): Record<string, ConnectionDef> {
  const out: Record<string, ConnectionDef> = {
    github: { http: { url: githubApi(), ...(process.env.GITHUB_TOKEN ? { auth: "bearer" as const } : {}) } },
  };
  const raw = process.env.TODO_PLUGIN_CONNECTIONS;
  if (!raw) return out;
  try {
    const { file, errors } = checkFile({ connections: JSON.parse(raw) });
    for (const e of errors) console.error(`plugins: TODO_PLUGIN_CONNECTIONS: ${e}`);
    return { ...out, ...file.connections };
  } catch (e) {
    console.error(`plugins: TODO_PLUGIN_CONNECTIONS isn't JSON: ${message(e)}`);
    return out;
  }
}

/** Secrets for the host's connections: GITHUB_TOKEN, and TODO_PLUGIN_SECRET_<NAME>. */
export function hostSecrets(connections = hostConnections()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(connections)) {
    const v = name === "github" ? process.env.GITHUB_TOKEN : process.env[`TODO_PLUGIN_SECRET_${envName(name)}`];
    if (v) out[name] = v;
  }
  return out;
}

const scope = (project: string, repo: string, connection: string) => [project, repo, connection];

/** Store (or, with null, forget) a repo connection's secret. */
export async function putCredential(d: Db, project: string, repo: string, connection: unknown, secret: unknown, handle: string): Promise<void> {
  if (!secretKey()) throw new NoSecretKey();
  if (typeof connection !== "string" || !CONNECTION_NAME.test(connection)) throw new PluginInputError("connection must be a connection name");
  if (secret === null) {
    await d.query("delete from plugin_credentials where project = $1 and repo = $2 and connection = $3", [project, repo, connection]);
    return;
  }
  if (typeof secret !== "string" || !secret) throw new PluginInputError("secret must be a non-empty string");
  await d.query(
    `insert into plugin_credentials (project, repo, connection, secret_enc, updated_by, updated_at) values ($1, $2, $3, $4, $5, now())
     on conflict (project, repo, connection) do update set secret_enc = excluded.secret_enc, updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`, [project, repo, connection, encryptSecret(secret, scope(project, repo, connection)), handle]);
}

/** The repo's stored secrets this server can read; none without TODO_SECRET_KEY. */
async function repoSecrets(d: Db, project: string, repo: string): Promise<Record<string, string>> {
  const key = secretKey();
  if (!key) return {};
  const out: Record<string, string> = {};
  for (const r of await d.query("select connection, secret_enc from plugin_credentials where project = $1 and repo = $2", [project, repo])) {
    const plain = decryptSecret(r.secret_enc, scope(project, repo, r.connection), key);
    if (plain !== null) out[r.connection] = plain;
  }
  return out;
}

/** Connection names this server holds a secret for in the repo, whether stored or host-wide. */
async function secretNames(d: Db, project: string, repo: string): Promise<string[]> {
  const stored = secretKey()
    ? (await d.query("select connection from plugin_credentials where project = $1 and repo = $2", [project, repo])).map((r) => r.connection)
    : [];
  return [...new Set([...stored, ...Object.keys(hostSecrets())])].sort();
}

// ── what the CLI and dashboard read ───────────────────────────────────────────
export interface LastRun { at: string; item: string; skipped?: string; error?: string }

async function lastRuns(d: Db, project: string, repo: string): Promise<Record<string, LastRun>> {
  const rows = await d.query(
    `select distinct on (r.plugin, r.instance) r.plugin, r.instance, r.at, r.result, i.id as item_id
       from plugin_runs r left join items i on i.project = r.project and i.uid = r.item_uid
      where r.project = $1 and r.repo = $2 order by r.plugin, r.instance, r.id desc`, [project, repo]);
  const out: Record<string, LastRun> = {};
  for (const r of rows) {
    const res = r.result as RunResult;
    out[`${r.plugin}/${r.instance}`] = { at: new Date(r.at).toISOString(), item: r.item_id ?? r.item_uid,
      ...(res.skipped ? { skipped: res.skipped } : {}), ...(res.error ? { error: res.error } : {}) };
  }
  return out;
}

export interface RepoPlugins {
  instances: Record<string, InstanceDef[]>;
  grants: Record<string, string[]>;
  plugins: PluginInfo[];
  secrets: string[];
  runs: Record<string, LastRun>;
  errors: string[];
}

/** One repo's plugins as a project sees them. A repo file GitHub won't give leaves the shipped plugins and an error. */
export async function repoPlugins(d: Db, project: string, repo: string, f: Fetch = fetch): Promise<RepoPlugins> {
  const instances = await storedInstances(d, project, repo);
  const errors: string[] = [];
  let defs: RepoDefs = { files: {}, sha: null, defaultBranch: null };
  try {
    defs = await loadDefs(d, repo, f);
  } catch (e) {
    errors.push(`couldn't read ${repo}'s ${PLUGINS_DIR}: ${message(e)}`);
  }
  const merged = merge(defs, instances);
  return {
    instances, grants: await storedGrants(d, project, repo), plugins: merged.plugins, secrets: await secretNames(d, project, repo),
    runs: await lastRuns(d, project, repo), errors: [...errors, ...merged.errors],
  };
}

// ── the item a plugin sees ────────────────────────────────────────────────────
async function pluginItem(d: Db, project: string, it: Row, by: string): Promise<PluginItem> {
  const x = it.extra ?? {};
  const repo = repoKey(x.repo);
  const [owner, name] = repo ? repo.split("/") : [null, null];
  const notes = await d.query("select text, meta from notes where project = $1 and item_uid = $2 and kind = 'link' order by n",
    [project, it.uid]);
  const dir = repo ? (await checkoutDir(d, project, repo, by)).dir : "";
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: it.id, uid: it.uid, title: it.title, type: it.type ?? null, status: it.status, priority: it.priority ?? null,
    repo: repo || null, repo_owner: owner, repo_name: name, branches: itemBranches(x), jira: x.jira ?? null,
    app: str(x.app), section: str(x.section), developer: it.developer ?? null, qa_assignee: it.qa_assignee ?? null, dir: dir || null,
    links: notes.map((n) => ({ type: String(n.meta?.type ?? "link"), url: String(n.meta?.url ?? n.text) })),
  };
}

// ── applying a run ────────────────────────────────────────────────────────────
/** Note kinds a run replaces by key; logs and requests are only ever added. */
const REPLACED = ["link", "dependency"];

export const pluginUid = (instance: string, itemUid: string, key: string) => hashUid("plugin", instance, itemUid, key);
const sameUrl = (a: unknown, b: unknown) => String(a ?? "").replace(/\/+$/, "") === String(b ?? "").replace(/\/+$/, "");

function noteOf(a: Extract<Attachment, { kind: "link" | "edge" }>, instance: string): { kind: string; text: string; meta: Record<string, unknown> } {
  const own = { plugin: instance, plugin_key: a.key };
  if (a.kind === "link") return { kind: "link", text: a.label || a.url, meta: { url: a.url, type: a.type, label: a.label ?? null, ...own } };
  return { kind: "dependency", text: a.because, meta: { needs: a.needs, in: a.in ?? null, because: a.because, ...own } };
}

interface Applied { applied: string[]; log: string[]; edges: boolean }

/** Write one run's attachments: create what's new, set what changed, remove what's gone. */
async function applyRun(d: Db, project: string, it: Row, run: EventRun, grants: string[]): Promise<Applied> {
  const instance = `${run.plugin}/${run.instance.id}`;
  const log: string[] = [];
  const applied: string[] = [];
  const notes = await d.query("select uid, kind, text, meta from notes where project = $1 and item_uid = $2", [project, it.uid]);
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
      const [current] = await d.query(
        `select text from notes where project = $1 and item_uid = $2 and kind = 'ticket-request'
          order by coalesce((meta->>'version')::int, 1) desc, n desc limit 1`, [project, it.uid]);
      if (current?.text === a.text) continue;
      applied.push(uid);
      op({ op: "create", entity: "note", uid, data: { kind: "ticket-request", text: a.text, meta: { plugin: instance, plugin_key: a.key } } });
    } else {
      docs.push(a);
    }
  }
  for (const n of mine) if (!keep.has(n.uid)) op({ op: "remove", entity: "note", uid: n.uid });
  const results = ops.length ? await applyOps(d, project, ops, ACTOR) : [];
  results.forEach((r, i) => {
    const why = refused(r, ops[i]);
    if (why) log.push(why);
  });
  applied.push(...await applyDocs(d, project, it.uid, run, docs, log));
  const edgeUids = new Set([...run.result.attached.filter((a) => a.kind === "edge").map((a) => pluginUid(instance, it.uid, a.key)),
                            ...mine.filter((n) => n.kind === "dependency").map((n) => n.uid)]);
  return { applied, log, edges: ops.some((o) => edgeUids.has(o.uid)) };
}

function refused(r: Result, o: Op): string | null {
  if (r.status === "applied" && !r.rejected?.length) return null;
  // A create whose uid a person already removed stays removed.
  if (r.reason === "removed") return `${o.entity} ${o.uid} was removed from the item, so it isn't added again`;
  if (r.reason === "uid-exists" && o.entity === "log") return null;
  return `${o.op} ${o.entity} ${o.uid} was refused: ${r.reason ?? r.rejected?.map((x) => `${x.field} ${x.reason}`).join(", ")}`;
}

/** Docs a run attached, and the ones it attached last time and no longer does, if no one has changed them since. */
async function applyDocs(d: Db, project: string, itemUid: string, run: EventRun, docs: Extract<Attachment, { kind: "doc" }>[],
                         log: string[]): Promise<string[]> {
  const applied: string[] = [];
  const [prev] = await d.query(
    `select applied from plugin_runs where project = $1 and item_uid = $2 and plugin = $3 and instance = $4
        and result->>'error' is null and result->>'skipped' is null order by id desc limit 1`, [project, itemUid, run.plugin, run.instance.id]);
  const before = ((prev?.applied ?? []) as string[]).filter((a) => a.startsWith("doc:")).map((a) => a.slice(4));
  try {
    for (const a of docs) {
      if (a.content === undefined) {
        log.push(`doc ${a.name}: the server doesn't fetch a doc by url yet`);
        continue;
      }
      const bytes = Buffer.from(a.content, "utf8");
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const existing = await docByName(d, project, itemUid, a.name);
      if (existing && existing.by !== PLUGIN_HANDLE) {
        log.push(`doc ${a.name} was written by ${existing.by}, so the plugin leaves it alone`);
        continue;
      }
      applied.push(`doc:${a.name}`);
      if (existing?.sha256 === sha256) continue;
      const key = await issueUpload(d, project, itemUid, a.name, bytes.length);
      await putObject(key, bytes, docType(a.name));
      const r = await recordDoc(d, project, PLUGIN_HANDLE, { item_uid: itemUid, name: a.name, file_key: key, base: existing?.sha256 ?? null, sha256 });
      if (r.status === "conflict") log.push(`doc ${a.name} changed while it was written; kept the newer one`);
    }
    const now = new Set(applied.map((a) => a.slice(4)));
    for (const name of before.filter((n) => !now.has(n))) {
      const doc = (await listDocs(d, project, itemUid)).find((x) => x.name === name);
      if (doc && doc.by === PLUGIN_HANDLE) await removeDoc(d, project, PLUGIN_HANDLE, doc.uid, doc.sha256);
    }
  } catch (e) {
    if (!(e instanceof DocError)) throw e;
    log.push(`docs: ${e.message}`);
  }
  return applied;
}

// ── delivery ──────────────────────────────────────────────────────────────────
/** A failure before any plugin ran, such as GitHub being unreachable: the event is retried. */
class Transport extends Error {}

async function recordRun(d: Db, row: Row, run: EventRun, outcome: Applied | null): Promise<void> {
  const result = outcome?.log.length ? { ...run.result, log: [...run.result.log, ...outcome.log] } : run.result;
  await d.query(
    `insert into plugin_runs (event_id, project, item_uid, repo, plugin, instance, event, result, applied)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb)`,
    [row.id, row.project, row.item_uid, row.repo, run.plugin, run.instance.id, JSON.stringify(row.event), JSON.stringify(result),
     JSON.stringify(outcome?.applied ?? [])]);
  // Keep each instance's last RUNS_KEPT runs, and its last run on every item, which names what it attached there.
  await d.query(
    `delete from plugin_runs where id in (
       select id from (
         select id, row_number() over (order by id desc) as n_instance,
                row_number() over (partition by item_uid order by id desc) as n_item
           from plugin_runs where project = $1 and repo = $2 and plugin = $3 and instance = $4) ranked
        where n_instance > $5 and n_item > 1)`, [row.project, row.repo, run.plugin, run.instance.id, RUNS_KEPT]);
}

async function deliver(d: Db, row: Row, deps: RunnerDeps): Promise<string[]> {
  const f = deps.fetch ?? fetch;
  const [it] = await d.query("select * from items where project = $1 and uid = $2", [row.project, row.item_uid]);
  if (!it) return ["the item is gone"];
  let defs: RepoDefs;
  try {
    defs = await loadDefs(d, row.repo, f);
  } catch (e) {
    throw new Transport(`couldn't read ${row.repo}'s ${PLUGINS_DIR}: ${message(e)}`);
  }
  const stored = await storedInstances(d, row.project, row.repo);
  const grants = await storedGrants(d, row.project, row.repo);
  const merged = merge(defs, stored);
  const connections = hostConnections();
  const out = await runEvent({
    repo: defs.text === undefined ? undefined : { text: defs.text, files: defs.files },
    hostConnections: connections,
    secrets: { repo: await repoSecrets(d, row.project, row.repo), host: hostSecrets(connections) },
    storedInstances: narrowed(stored, merged.plugins, row.only_plugins ?? null),
    grants, item: await pluginItem(d, row.project, it, row.by), event: row.event as PluginEvent, repoKey: row.repo,
    allowRepoCommands: false,
  }, { fetch: f, ...deps.host });
  let edges = false;
  for (const run of out.results) {
    let outcome: Applied | null = null;
    if (run.instance.dry_run) outcome = { applied: [], log: ["dry run: nothing was attached"], edges: false };
    else if (!run.result.error && !run.result.skipped) outcome = await applyRun(d, row.project, it, run, grants[run.plugin] ?? []);
    edges ||= !!outcome?.edges;
    await recordRun(d, row, run, outcome);
  }
  if (edges) void scheduleRecompute(d, row.project, f);
  return out.errors;
}

/** Deliver due plugin events: each leased, retried with backoff when GitHub can't be read, given up after MAX_ATTEMPTS. */
export async function flushPluginRuns(d: Db, deps: RunnerDeps = {}): Promise<{ ran: number; failed: number }> {
  if (!pluginsEnabled()) return { ran: 0, failed: 0 };
  await d.query(
    `update plugin_events set claimed_at = null, done_at = now(), error = coalesce(error, 'the process stopped during the last attempt')
      where done_at is null and attempts >= $1 and claimed_at < now() - make_interval(mins => $2)`, [MAX_ATTEMPTS, LEASE_MINUTES]);
  const due = await d.query(
    `select id from plugin_events
      where done_at is null and attempts < $1 and (next_attempt_at is null or next_attempt_at <= now())
        and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
      order by id limit $3`, [MAX_ATTEMPTS, LEASE_MINUTES, BATCH]);
  let ran = 0;
  let failed = 0;
  for (const { id } of due) {
    const [row] = await d.query(
      `update plugin_events set attempts = attempts + 1, claimed_at = now()
        where id = $1 and done_at is null and (claimed_at is null or claimed_at < now() - make_interval(mins => $2))
        returning *`, [id, LEASE_MINUTES]);
    if (!row) continue;
    try {
      const errors = await deliver(d, row, deps);
      await d.query("update plugin_events set done_at = now(), claimed_at = null, error = null, errors = $2::jsonb where id = $1",
        [row.id, JSON.stringify(errors)]);
      ran++;
    } catch (e) {
      const last = row.attempts >= MAX_ATTEMPTS || !(e instanceof Transport);
      await d.query(
        `update plugin_events set error = $2, claimed_at = null, done_at = case when $4 then now() end,
           next_attempt_at = now() + make_interval(secs => $3) where id = $1`,
        [row.id, message(e), 30 * 2 ** (row.attempts - 1), last]);
      if (!(e instanceof Transport)) console.error(`plugins: event ${row.id} failed:`, e);
      failed++;
    }
  }
  return { ran, failed };
}

// ── GitHub events ─────────────────────────────────────────────────────────────
interface ItemRef { project: string; uid: string; extra: Row }

const open = (r: Row) => r.status !== "cancelled" && !r.extra?.archived;

/** Open items in any project on `branch` of `repo`. */
export async function itemsOnBranch(d: Pick<Db, "query">, repo: string, branch: string): Promise<ItemRef[]> {
  const rows = await d.query(
    `select project, uid, status, extra from items
      where (extra->'branches' @> jsonb_build_array($1::text) or extra->>'branch' = $1) and status <> 'cancelled'`, [branch]);
  return rows.filter((r) => open(r) && repoKey(r.extra?.repo) === repo && itemBranches(r.extra).includes(branch)) as ItemRef[];
}

/** Projects with any item in `repo`. */
async function projectsOf(d: Db, repo: string): Promise<string[]> {
  const rows = await d.query("select distinct project, extra->>'repo' as repo from items where extra ? 'repo'");
  return [...new Set(rows.filter((r) => repoKey(r.repo) === repo).map((r) => r.project as string))].sort();
}

async function queueBranch(d: Db, repo: string, branch: string, event: PluginEvent): Promise<number> {
  const items = await itemsOnBranch(d, repo, branch);
  await d.tx(async (t) => {
    for (const it of items) await queuePluginEvent(t, it.project, it.uid, repo, event, PLUGIN_HANDLE);
  });
  return items.length;
}

const DEPLOYED = ["success", "failure", "error", "inactive"];

export interface HookOutcome { repo: string | null; queued: number; projects: string[] }

/** A GitHub webhook delivery: queue the event for the items on its branch, and say which projects' git facts it moves. */
export async function githubEvent(d: Db, kind: string, payload: unknown): Promise<HookOutcome> {
  const body = isMap(payload) ? payload : {};
  const repo = repoKey(body.repository?.full_name);
  if (!repo) return { repo: null, queued: 0, projects: [] };
  await d.query(
    `insert into plugin_repos (repo, hook_at) values ($1, now()) on conflict (repo) do update set hook_at = excluded.hook_at`, [repo]);
  let queued = 0;
  if (kind === "push" && typeof body.ref === "string" && body.ref.startsWith("refs/heads/")) {
    const branch = body.ref.slice("refs/heads/".length);
    if (body.deleted) await d.query("update plugin_repos set tips = tips - $2::text where repo = $1", [repo, branch]);
    else if (typeof body.after === "string") {
      await d.query("update plugin_repos set tips = tips || jsonb_build_object($2::text, $3::text) where repo = $1", [repo, branch, body.after]);
    }
    if (branch === body.repository?.default_branch) await invalidateDefs(d, repo);
    if (!body.deleted) queued = await queueBranch(d, repo, branch, { type: "push", branch });
  } else if (kind === "pull_request" && typeof body.pull_request?.head?.ref === "string") {
    const branch = body.pull_request.head.ref;
    queued = await queueBranch(d, repo, branch, { type: "pr", branch });
  } else if (kind === "deployment_status" && typeof body.deployment?.ref === "string" && DEPLOYED.includes(body.deployment_status?.state)) {
    const branch = body.deployment.ref;
    queued = await queueBranch(d, repo, branch, { type: "deployment", branch });
  } else {
    return { repo, queued: 0, projects: [] };
  }
  return { repo, queued, projects: kind === "deployment_status" ? [] : await projectsOf(d, repo) };
}

export function signatureValid(body: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`);
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ── the tick ──────────────────────────────────────────────────────────────────
/** Open items with a repo, across projects. */
async function openItems(d: Db): Promise<(ItemRef & { repo: string })[]> {
  const rows = await d.query("select project, uid, status, extra from items where extra ? 'repo' and status <> 'cancelled'");
  return rows.filter(open).map((r) => ({ project: r.project, uid: r.uid, extra: r.extra, repo: repoKey(r.extra?.repo) })).filter((r) => r.repo);
}

async function branchTips(repo: string, etag: string | null, f: Fetch): Promise<{ tips: Record<string, string>; etag: string | null } | null> {
  const token = process.env.GITHUB_TOKEN;
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28",
                    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const tips: Record<string, string> = {};
  let first: string | null = null;
  for (let page = 1; ; page++) {
    const res = await f(`${githubApi()}/repos/${repo}/branches?per_page=${BRANCH_PAGE}&page=${page}`, {
      signal: AbortSignal.timeout(10_000), headers: { ...headers, ...(page === 1 && etag ? { "if-none-match": etag } : {}) },
    });
    if (page === 1 && res.status === 304) return null;
    if (!res.ok) throw new Error(`GitHub GET /repos/${repo}/branches: ${res.status}`);
    if (page === 1) first = res.headers.get("etag");
    const rows = (await res.json()) as { name: string; commit: { sha: string } }[];
    for (const r of rows) tips[r.name] = r.commit.sha;
    if (rows.length < BRANCH_PAGE) return { tips, etag: first };
  }
}

/** Poll repos with open items and no recent webhook; a moved tip queues a push for its items. */
async function pollRepos(d: Db, items: (ItemRef & { repo: string })[], f: Fetch): Promise<{ polled: number; queued: number }> {
  const repos = [...new Set(items.map((it) => it.repo))].sort();
  let polled = 0;
  let queued = 0;
  for (const repo of repos) {
    const [state] = await d.query("select * from plugin_repos where repo = $1", [repo]);
    if (state?.hook_at && Date.now() - new Date(state.hook_at).getTime() < HOOK_FRESH_MINUTES * 60_000) continue;
    let listed: Awaited<ReturnType<typeof branchTips>>;
    try {
      listed = await branchTips(repo, state?.etag ?? null, f);
    } catch (e) {
      console.error(`plugins: polling ${repo}: ${message(e)}`);
      continue;
    }
    polled++;
    if (!listed) {
      await d.query("update plugin_repos set polled_at = now() where repo = $1", [repo]);
      continue;
    }
    const before: Record<string, string> | null = state?.polled_at ? state.tips ?? {} : null;
    if (before) {
      const moved = Object.keys(listed.tips).filter((b) => before[b] !== listed!.tips[b]);
      const [defs] = await d.query("select default_branch from plugin_defs where repo = $1", [repo]);
      if (defs?.default_branch && moved.includes(defs.default_branch)) await invalidateDefs(d, repo);
      for (const branch of moved) queued += await queueBranch(d, repo, branch, { type: "push", branch });
    }
    await d.query(
      `insert into plugin_repos (repo, etag, tips, polled_at) values ($1, $2, $3::jsonb, now())
       on conflict (repo) do update set etag = excluded.etag, tips = excluded.tips, polled_at = excluded.polled_at`,
      [repo, listed.etag, JSON.stringify(listed.tips)]);
  }
  return { polled, queued };
}

/** Queue a refresh for each open item with an every: floor that has come due. */
async function queueFloors(d: Db, items: (ItemRef & { repo: string })[], f: Fetch): Promise<number> {
  const byRepo = new Map<string, (ItemRef & { repo: string })[]>();
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
      await queuePluginEvent(d, it.project, it.uid, repo, { type: "refresh" }, PLUGIN_HANDLE, due.map((p) => p.name));
      queued++;
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
  await d.query("delete from plugin_events where done_at < now() - make_interval(days => $1)", [EVENTS_KEPT_DAYS]);
  return { ...(await flushPluginRuns(d, deps)), polled, pushes, refreshes };
}
