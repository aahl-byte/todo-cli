// What the dashboard shows of plugins: each of a project's repos with its
// plugins, instances, connections, grants and run log for the Plugins settings
// page, and an item's manual buttons, skip notices and manual-run outcomes.
import type { Db, Row } from "./db";
import { pluginOwners, repoKey, repoRefusal } from "./checkouts";
import { hostConnections, loadDefs, merge, projectRepos, repoPlugins, type RepoDefs, type RepoPlugins } from "./plugins/store";
import { finished } from "./plugins/queue";
import { SHIPPED } from "./plugins/shipped";
import { triggersOf } from "./plugins/triggers";
import { attachedSummary } from "./plugin-form";
import type { Attachment, Call, ConnectionDef, InstanceDef, PluginDef, PluginEvent, RunResult } from "./plugins/types";

/** Runs the log shows per instance. */
export const RUNS_SHOWN = 20;

export interface RunRow {
  id: number;
  at: string;
  item: { id: string; title: string } | null;
  event: PluginEvent;
  dryRun: boolean;
  attached: Attachment[];
  wouldSend: Call[];
  log: string[];
  skipped: string | null;
  error: string | null;
}

export interface DashConnection {
  name: string;
  /** Declared in the repo file, by this server for every repo, or nowhere. */
  origin: "repo" | "host" | "missing";
  kind: "http" | "mcp" | null;
  url: string | null;
  /** Calls carry a secret: an http connection with auth. */
  needsSecret: boolean;
  /** An mcp connection that starts a local command, which the server never does. */
  command: boolean;
  /** This server holds a secret for it. */
  held: boolean;
  usedBy: string[];
}

export type DashInstance = RepoPlugins["plugins"][number]["instances"][number];

export interface DashPlugin {
  name: string;
  shipped: boolean;
  connections: string[];
  on: PluginDef["on"];
  every: string | null;
  exclusive: boolean;
  per: string | null;
  code: boolean;
  settings: PluginDef["settings"];
  instances: DashInstance[];
  /** Instances the repo file declares, as it declares them. */
  declared: Record<string, InstanceDef>;
  /** Ids with a stored row. */
  stored: string[];
  /** Capabilities a shipped plugin declares, and what's granted. */
  capabilities: string[];
  grant: { capabilities: string[]; by: string; at: string } | null;
  runs: Record<string, RunRow[]>;
}

export interface DashRepo {
  repo: string;
  listed: { by: string; at: string } | null;
  checkout: boolean;
  /** Why the server doesn't read this repo, or null when the project may use it. */
  refusal: string | null;
  plugins: DashPlugin[];
  connections: DashConnection[];
  errors: string[];
}

export interface PluginsPage { ownersSet: boolean; repos: DashRepo[] }

const iso = (v: unknown) => new Date(v as string).toISOString();

function runRow(r: Row): RunRow {
  const res = (r.result ?? {}) as Partial<RunResult>;
  return {
    id: Number(r.id), at: iso(r.at), item: r.item_id ? { id: r.item_id, title: r.title } : null, event: r.event, dryRun: !!r.dry_run,
    attached: res.attached ?? [], wouldSend: res.wouldSend ?? [], log: res.log ?? [], skipped: res.skipped ?? null, error: res.error ?? null,
  };
}

async function repoRuns(d: Pick<Db, "query">, project: string, repo: string): Promise<Record<string, RunRow[]>> {
  const rows = await d.query(
    `select r.id, r.at, r.plugin, r.instance, r.event, r.result, r.dry_run, i.id as item_id, i.title
       from plugin_runs r left join items i on i.project = r.project and i.uid = r.item_uid
      where r.project = $1 and r.repo = $2 order by r.id desc`, [project, repo]);
  const out: Record<string, RunRow[]> = {};
  for (const r of rows) {
    const list = (out[`${r.plugin}/${r.instance}`] ??= []);
    if (list.length < RUNS_SHOWN) list.push(runRow(r));
  }
  return out;
}

async function grantsOf(d: Pick<Db, "query">, project: string, repo: string) {
  const rows = await d.query("select plugin, capabilities, granted_by, granted_at from plugin_grants where project = $1 and repo = $2", [project, repo]);
  return Object.fromEntries(rows.map((r) => [r.plugin, { capabilities: r.capabilities ?? [], by: r.granted_by, at: iso(r.granted_at) }]));
}

function connectionOf(name: string, repoDefs: Record<string, ConnectionDef>, hostDefs: Record<string, ConnectionDef>, view: RepoPlugins,
                      usedBy: string[]): DashConnection {
  const origin = name in repoDefs ? "repo" : name in hostDefs ? "host" : "missing";
  const def = origin === "repo" ? repoDefs[name] : origin === "host" ? hostDefs[name] : null;
  const http = def && "http" in def ? def.http : null;
  const mcp = def && "mcp" in def ? def.mcp : null;
  return {
    name, origin, kind: http ? "http" : mcp ? "mcp" : null,
    url: http?.url ?? (mcp && "url" in mcp ? mcp.url : null),
    needsSecret: !!http?.auth, command: !!mcp && "command" in mcp,
    held: origin === "repo" ? view.secrets.includes(name) : origin === "host" ? view.host_secrets.includes(name) : false,
    usedBy,
  };
}

/** One allowed repo as the settings page shows it. */
export async function dashRepo(d: Pick<Db, "query">, project: string, repo: string): Promise<Pick<DashRepo, "plugins" | "connections" | "errors">> {
  const view = await repoPlugins(d, project, repo);
  let defs: RepoDefs = { files: {}, sha: null, defaultBranch: null };
  try {
    defs = await loadDefs(d, repo);
  } catch {
    // repoPlugins has already said why.
  }
  const bare = merge(defs, {});
  const grants = await grantsOf(d, project, repo);
  const runs = await repoRuns(d, project, repo);
  const plugins = view.plugins.map((p): DashPlugin => {
    const def = bare.resolved.find((r) => r.name === p.name)?.def ?? SHIPPED[p.name]?.def ?? {};
    const declared = Object.fromEntries((bare.file.instances?.[p.name] ?? []).map((i) => [i.id, i]));
    return {
      name: p.name, shipped: p.shipped, connections: p.connections, on: p.on, every: p.every, exclusive: !!def.exclusive,
      per: def.per ?? null, code: !!def.code, settings: p.settings, instances: p.instances, declared,
      stored: (view.instances[p.name] ?? []).map((i) => i.id),
      capabilities: p.shipped ? def.capabilities ?? [] : [], grant: grants[p.name] ?? null,
      runs: Object.fromEntries(p.instances.map((i) => [i.id, runs[`${p.name}/${i.id}`] ?? []])),
    };
  });
  const used = new Map<string, string[]>();
  for (const p of plugins) for (const c of p.connections) used.set(c, [...(used.get(c) ?? []), p.name]);
  const repoDefs = bare.file.connections ?? {};
  const hostDefs = hostConnections();
  const names = [...new Set([...used.keys(), ...Object.keys(repoDefs)])].sort();
  return { plugins, connections: names.map((n) => connectionOf(n, repoDefs, hostDefs, view, used.get(n) ?? [])), errors: view.errors };
}

/** Every repo the project lists or a member has a checkout of, each with its plugins when the project may use it. */
export async function pluginsPage(d: Pick<Db, "query">, project: string): Promise<PluginsPage> {
  const { repos, checkouts } = await projectRepos(d, project);
  const names = [...new Set([...repos.map((r) => r.repo), ...checkouts.map((c) => repoKey(c)).filter(Boolean)])].sort();
  const out: DashRepo[] = [];
  for (const repo of names) {
    const listed = repos.find((r) => r.repo === repo);
    const refusal = await repoRefusal(d, project, repo);
    const base = { repo, listed: listed ? { by: listed.added_by, at: listed.added_at } : null, checkout: checkouts.includes(repo), refusal };
    if (refusal) out.push({ ...base, plugins: [], connections: [], errors: [] });
    else out.push({ ...base, ...(await dashRepo(d, project, repo)) });
  }
  return { ownersSet: pluginOwners().length > 0, repos: out };
}

// ── the item page ─────────────────────────────────────────────────────────────
export interface PluginButton {
  plugin: string;
  instance: string;
  label: string;
  /** The server runs it; otherwise a developer's CLI does, for `reason`. */
  server: boolean;
  reason: string | null;
}

/** A button for each enabled manual instance of the item's repo, while the item is open. */
export async function itemButtons(d: Pick<Db, "query">, project: string, item: Row): Promise<PluginButton[]> {
  const repo = repoKey(item.extra?.repo);
  if (!repo || finished(item) || (await repoRefusal(d, project, repo))) return [];
  const view = await repoPlugins(d, project, repo);
  return view.plugins.flatMap((p) => p.instances
    .filter((i) => i.enabled !== false && triggersOf({ on: p.on }, i).includes("manual"))
    .map((i) => ({ plugin: p.name, instance: i.id, label: i.button || i.name || i.id, server: i.server_runs, reason: i.server_runs_reason })));
}

const notable = (skipped: string) => !/: when is false|^when is false/.test(skipped);

/** One line per plugin whose last run on the item was skipped or failed, newest first. */
export async function itemNotices(d: Pick<Db, "query">, project: string, itemUid: string): Promise<string[]> {
  const rows = await d.query(
    `select distinct on (plugin, instance) id, plugin, instance, result from plugin_runs
      where project = $1 and item_uid = $2 order by plugin, instance, id desc`, [project, itemUid]);
  const byPlugin = new Map<string, string>();
  for (const r of [...rows].sort((a, b) => Number(b.id) - Number(a.id))) {
    if (byPlugin.has(r.plugin)) continue;
    const res = (r.result ?? {}) as Partial<RunResult>;
    const text = res.error ? `failed: ${res.error}` : res.skipped && notable(res.skipped) ? res.skipped : null;
    if (text) byPlugin.set(r.plugin, text.startsWith(`${r.plugin}: `) ? text : `${r.plugin}: ${text}`);
  }
  return [...byPlugin.values()];
}

export interface ManualRunState { done: boolean; ok: boolean; message: string }

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Where a manual run stands: queued, running, or what its run recorded. */
export async function manualRunState(d: Pick<Db, "query">, project: string, event: number): Promise<ManualRunState | null> {
  const [e] = await d.query("select done_at, claimed_at, error, errors from plugin_events where id = $1 and project = $2", [event, project]);
  if (!e) return null;
  const [run] = await d.query("select result, dry_run from plugin_runs where event_id = $1 and project = $2 order by id desc limit 1", [event, project]);
  if (run) {
    const res = run.result as RunResult;
    if (res.error && res.transient && !e.done_at) return { done: false, ok: true, message: `retrying: ${res.error}` };
    if (res.error) return { done: true, ok: false, message: `failed: ${res.error}` };
    if (res.skipped) return { done: true, ok: false, message: `skipped: ${res.skipped}` };
    if (run.dry_run) return { done: true, ok: true, message: `dry run: would send ${count(res.wouldSend?.length ?? 0, "call")}, attached nothing` };
    const what = res.attached?.length ? `attached ${attachedSummary(res.attached)}` : "ran, attaching nothing";
    return { done: true, ok: true, message: res.log?.length ? `${what} · ${res.log[res.log.length - 1]}` : what };
  }
  if (e.done_at) {
    const why = e.error ?? (Array.isArray(e.errors) && e.errors.length ? e.errors.join("; ") : "no instance fired");
    return { done: true, ok: false, message: `didn't run: ${why}` };
  }
  return { done: false, ok: true, message: e.claimed_at ? "running" : "queued" };
}
