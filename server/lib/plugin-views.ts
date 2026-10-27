// What the dashboard shows of plugins: each of a project's repos with its
// plugins, instances, connections, grants and run log for the Automation
// settings page, what the Jira bridge and Actions do beside them, and an item's
// manual buttons, skip notices and manual-run outcomes.
import type { Db, Row } from "./db";
import { pluginOwners, repoAllowed, repoKey, repoRefusal } from "./checkouts";
import { storedActions } from "./actions/model";
import { outboundRules } from "./jira/rules";
import { jiraReadOnly } from "./jira/config";
import { remoteBranches, type Fetch, type RemoteBranches } from "./gitfacts";
import { hostConnections, hostSecrets, loadConfig, merge, projectRepos, repoPlugins, type RepoPlugins } from "./plugins/store";
import { finished, pluginsEnabled } from "./plugins/queue";
import { ALWAYS_ON, SHIPPED } from "./plugins/shipped";
import { triggersOf } from "./plugins/triggers";
import { attachedSummary, connectionKeysOf } from "./plugin-form";
import { pickRepo } from "./automation";
import { parse } from "yaml";
import type { Attachment, Call, ConnectionDef, PluginDef, PluginEvent, RunResult } from "./plugins/types";

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
  /** Declared in the repo's config, by this server for every repo, or nowhere. */
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
  description: string | null;
  shipped: boolean;
  /** Shipped and on in every repo, without being switched on. */
  always: boolean;
  connections: string[];
  on: PluginDef["on"];
  every: string | null;
  exclusive: boolean;
  per: string | null;
  code: boolean;
  settings: PluginDef["settings"];
  instances: DashInstance[];
  /** Capabilities a shipped plugin declares, and what's granted. */
  capabilities: string[];
  grant: { capabilities: string[]; by: string; at: string } | null;
  runs: Record<string, RunRow[]>;
}

/** A custom plugin as stored: what its editor opens with, and what keeps it from loading. */
export interface DashCustom {
  name: string;
  manifest: string;
  code: string | null;
  /** The file name its code: key gives, if it has one. */
  codeFile: string | null;
  /** Why it doesn't load as stored; empty when it does. */
  errors: string[];
  updated: { by: string; at: string };
}

/** A shipped plugin the repo doesn't have switched on. */
export interface DashOffer { name: string; description: string | null; connections: string[] }

/** What the repo picker knows of a repo before its plugins are read. */
export interface RepoEntry {
  repo: string;
  listed: { by: string; at: string } | null;
  checkout: boolean;
  /** How many of the project's items name it. */
  items: number;
  /** Only a member's checkout brings it in: no item names it and it isn't listed. */
  folded: boolean;
  /** Why the server doesn't read this repo, or null when the project may use it. */
  refusal: string | null;
  /** Listing it would let the project use it. */
  addable: boolean;
}

export interface DashRepo extends RepoEntry {
  /** Its deploy branches. */
  track: string[];
  /** The remote's branches, for the deploy-branches field to suggest. */
  branches: RemoteBranches;
  plugins: DashPlugin[];
  offered: DashOffer[];
  custom: DashCustom[];
  connections: DashConnection[];
  /** Connection names an instance may pick: the repo's own, and this server's, which only instances stored here get. */
  available: { repo: string[]; host: string[] };
  errors: string[];
  /** Who last changed the repo's config, and when; null for a repo nobody has set up. */
  updated: { by: string; at: string } | null;
}

export interface PluginsPage { ownersSet: boolean; repos: DashRepo[] }

/** What still runs outside plugins in a project: the Jira bridge and Actions. */
export interface BridgeFacts {
  jira: {
    /** todo → Jira triggers on the General tab. */
    triggers: number;
    writes: boolean;
    readOnly: boolean;
    /** When the bridge last mirrored the project's linked issues, or null when it never has. */
    polled: string | null;
    /** Jira issues the project's items link. */
    linked: number;
  };
  actions: { name: string; kind: "rest" | "watchtower" }[];
}

/** A connection this server offers every repo. */
export interface HostConnection { name: string; auth: boolean; held: boolean }

export interface AutomationPage {
  ownersSet: boolean;
  /** GITHUB_TOKEN is set, without which no plugin runs. */
  pluginsOn: boolean;
  repos: RepoEntry[];
  selected: DashRepo | null;
  bridge: BridgeFacts;
  host: HostConnection[];
  /** Every plugin that ships with todo, which a custom plugin can't be named after. */
  shipped: string[];
}

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

const codeFileOf = (manifest: string): string | null => {
  try {
    const def = parse(manifest) as { code?: unknown } | null;
    return typeof def?.code === "string" ? def.code : null;
  } catch {
    return null;
  }
};

/** The load errors that name a plugin, without its name. */
const errorsOf = (name: string, errors: string[]) =>
  errors.filter((e) => e.startsWith(`plugin ${name}: `)).map((e) => e.slice(`plugin ${name}: `.length));

/** One allowed repo as the settings page shows it. */
export async function dashRepo(d: Pick<Db, "query">, project: string, repo: string, f: Fetch = fetch):
    Promise<Pick<DashRepo, "track" | "branches" | "plugins" | "offered" | "custom" | "connections" | "available" | "errors" | "updated">> {
  const view = await repoPlugins(d, project, repo);
  const stored = await loadConfig(d, project, repo);
  const bare = merge(stored, {});
  const grants = await grantsOf(d, project, repo);
  const runs = await repoRuns(d, project, repo);
  const plugins = view.plugins.map((p): DashPlugin => {
    const def = bare.resolved.find((r) => r.name === p.name)?.def ?? SHIPPED[p.name]?.def ?? {};
    return {
      name: p.name, description: def.description ?? null, shipped: p.shipped, always: ALWAYS_ON.includes(p.name), connections: p.connections, on: p.on, every: p.every, exclusive: !!def.exclusive,
      per: def.per ?? null, code: !!def.code, settings: p.settings, instances: p.instances,
      capabilities: p.shipped ? def.capabilities ?? [] : [], grant: grants[p.name] ?? null,
      runs: Object.fromEntries(p.instances.map((i) => [i.id, runs[`${p.name}/${i.id}`] ?? []])),
    };
  });
  const used = new Map<string, string[]>();
  const use = (c: string, plugin: string) => { if (!used.get(c)?.includes(plugin)) used.set(c, [...(used.get(c) ?? []), plugin]); };
  for (const p of plugins) {
    const keys = connectionKeysOf(p.connections);
    for (const c of p.connections) if (!c.includes("{{")) use(c, p.name);
    // A connection an instance names is used by that plugin.
    for (const i of p.instances) for (const k of keys) if (typeof i.settings?.[k] === "string" && i.settings[k]) use(i.settings[k] as string, p.name);
  }
  const repoDefs = bare.file.connections ?? {};
  const hostDefs = hostConnections();
  const names = [...new Set([...used.keys(), ...Object.keys(repoDefs)])].sort();
  const offered = Object.entries(SHIPPED).filter(([name]) => !plugins.some((p) => p.name === name)).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, { def }]) => ({ name, description: def.description ?? null, connections: def.connections ?? [] }));
  const custom = stored.custom.map((c): DashCustom => ({
    name: c.name, manifest: c.manifest, code: c.code, codeFile: codeFileOf(c.manifest), errors: errorsOf(c.name, view.errors),
    updated: { by: c.updated_by, at: c.updated_at },
  }));
  const own = new Set(custom.map((c) => c.name));
  return {
    track: stored.track, branches: await remoteBranches(d, repo, f), plugins, offered, custom,
    connections: names.map((n) => connectionOf(n, repoDefs, hostDefs, view, used.get(n) ?? [])),
    available: { repo: Object.keys(repoDefs).sort(), host: Object.keys(hostDefs).filter((n) => !(n in repoDefs)).sort() },
    errors: view.errors.filter((e) => ![...own].some((n) => e.startsWith(`plugin ${n}: `))), updated: stored.updated,
  };
}

/** How many of the project's items name each repo, by repoKey. */
async function itemRepos(d: Pick<Db, "query">, project: string): Promise<Map<string, number>> {
  const rows = await d.query("select extra->>'repo' as repo, count(*)::int as n from items where project = $1 and coalesce(extra->>'repo', '') <> '' group by 1",
                             [project]);
  const out = new Map<string, number>();
  for (const r of rows) {
    const key = repoKey(r.repo);
    if (key) out.set(key, (out.get(key) ?? 0) + Number(r.n));
  }
  return out;
}

/** Every repo the project's items name, lists, or a member has a checkout of; the ones only a checkout brings in come last. */
async function repoEntries(d: Pick<Db, "query">, project: string): Promise<RepoEntry[]> {
  const { repos, checkouts } = await projectRepos(d, project);
  const used = await itemRepos(d, project);
  const names = [...new Set([...repos.map((r) => r.repo), ...checkouts.map((c) => repoKey(c)).filter(Boolean), ...used.keys()])].sort();
  const owners = pluginOwners();
  const out: RepoEntry[] = [];
  for (const repo of names) {
    const listed = repos.find((r) => r.repo === repo);
    const refusal = await repoRefusal(d, project, repo);
    out.push({
      repo, listed: listed ? { by: listed.added_by, at: listed.added_at } : null, checkout: checkouts.includes(repo), items: used.get(repo) ?? 0,
      folded: !listed && !used.has(repo), refusal,
      addable: !!refusal && !listed && owners.includes(repo.split("/")[0]) && !(await repoAllowed(d, project, repo)),
    });
  }
  return [...out.filter((r) => !r.folded), ...out.filter((r) => r.folded)];
}

const UNREAD: Omit<DashRepo, keyof RepoEntry> = {
  track: [], branches: { names: [], default: null, visible: null }, plugins: [], offered: [], custom: [], connections: [],
  available: { repo: [], host: [] }, errors: [], updated: null,
};

/** Every repo the project uses, each with its plugins when the project may use it. */
export async function pluginsPage(d: Pick<Db, "query">, project: string, f: Fetch = fetch): Promise<PluginsPage> {
  const out: DashRepo[] = [];
  for (const e of await repoEntries(d, project)) out.push(e.refusal ? { ...e, ...UNREAD } : { ...e, ...(await dashRepo(d, project, e.repo, f)) });
  return { ownersSet: pluginOwners().length > 0, repos: out };
}

/** The Jira bridge's triggers and polling, and the project's Actions. */
export async function bridgeFacts(d: Pick<Db, "query">, project: string): Promise<BridgeFacts> {
  const [p] = await d.query("select jira_outbound, jira_synced_at, actions from projects where key = $1", [project]);
  const [linked] = await d.query("select count(distinct jira_key)::int as n from jira_links where project = $1 and source = 'field'", [project]);
  const rules = outboundRules(p?.jira_outbound);
  const actions = storedActions(p?.actions);
  return {
    jira: { triggers: rules?.triggers.length ?? 0, writes: !!rules?.writes, readOnly: jiraReadOnly(),
            polled: p?.jira_synced_at ? iso(p.jira_synced_at) : null, linked: Number(linked?.n ?? 0) },
    actions: actions.map((a) => ({ name: a.name || a.id, kind: a.kind })),
  };
}

/** The Automation page: the repo picker's repos, the one asked for (or the one most items name) with its plugins, and
 * what the server and the General tab bring to every repo. */
export async function automationPage(d: Pick<Db, "query">, project: string, wanted: string | null, f: Fetch = fetch): Promise<AutomationPage> {
  const repos = await repoEntries(d, project);
  const choice = pickRepo(repos, wanted);
  const entry = repos.find((r) => r.repo === choice);
  const secrets = hostSecrets();
  const host = Object.entries(hostConnections()).map(([name, def]) => ({ name, auth: "http" in def && !!def.http.auth, held: name in secrets }));
  return {
    ownersSet: pluginOwners().length > 0, pluginsOn: pluginsEnabled(), repos,
    selected: entry ? { ...entry, ...(await dashRepo(d, project, entry.repo, f)) } : null,
    bridge: await bridgeFacts(d, project), host, shipped: Object.keys(SHIPPED).sort(),
  };
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
    if (run.dry_run) return { done: true, ok: true, message: `test mode: would send ${count(res.wouldSend?.length ?? 0, "call")}, attached nothing` };
    const what = res.attached?.length ? `attached ${attachedSummary(res.attached)}` : "ran, attaching nothing";
    return { done: true, ok: true, message: res.log?.length ? `${what} · ${res.log[res.log.length - 1]}` : what };
  }
  if (e.done_at) {
    const why = e.error ?? (Array.isArray(e.errors) && e.errors.length ? e.errors.join("; ") : "no instance fired");
    return { done: true, ok: false, message: `didn't run: ${why}` };
  }
  return { done: false, ok: true, message: e.claimed_at ? "running" : "queued" };
}
