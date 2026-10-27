// The plugin host's entry point: run one instance of a plugin against an item
// and an event, and say what it attached, what it would send, and what went wrong.
import { Calls, type ConnectionOptions } from "./connections";
import { hostCodeSlots, REPO_CODE_DEADLINE_MS, runCode, type CodeSlots, type Isolation } from "./code-runner";
import { test } from "./expr";
import { addLog, Attached, finish } from "./limits";
import { parsePlugins, pluginErrors, settingRef } from "./load";
import { fetchDocs } from "./docs";
import { ALWAYS_ON, isShipped, SHIPPED } from "./shipped";
import { pickInstances } from "./triggers";
import { fillJson } from "./template";
import { runYaml } from "./yaml-runner";
import {
  DEFAULT_DEADLINE_MS, POST_REQUEST, SHIPPED_KINDS, type ConnectionDef, type ConnectionOrigin, type InstanceDef, type Limits, type PluginDef, type PluginEvent,
  type PluginConfig, type PluginItem, type PluginsFile, type ResolvedConnection, type RunInput, type RunResult,
} from "./types";

export type { PluginConfig } from "./types";

export interface HostDeps extends ConnectionOptions {
  /** Stands in for the code runner's sleeps, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Where code plugins run: a worker thread (the default) or this thread, for a host that is its own process. */
  isolation?: Isolation;
  /** The worker script, for hosts whose bundler moves it. */
  workerUrl?: URL;
  /** The sandboxes code plugins wait for; the host-wide pool unless a test brings its own. */
  codeSlots?: CodeSlots;
}

/** The instance's settings over the plugin's defaults, templates filled from the item and event. */
export function resolveSettings(plugin: PluginDef, instance: InstanceDef, scope: Record<string, unknown>):
    { settings: Record<string, unknown>; missing?: string } {
  const given = instance.settings ?? {};
  const settings: Record<string, unknown> = {};
  let missing: string | undefined;
  for (const [k, def] of Object.entries(plugin.settings ?? {})) {
    let v = given[k] ?? def.default;
    if (v === undefined || v === null || v === "") {
      if (def.type === "list") v = [];
      else if (def.type === "toggle") v = false;
      else if (!def.optional) missing ??= k;
    }
    settings[k] = v;
  }
  for (const [k, v] of Object.entries(given)) if (!(k in settings)) settings[k] = v;
  const templates = Object.entries(plugin.settings ?? {}).filter(([, d]) => d.template).map(([k]) => k);
  const filled = fillJson(Object.fromEntries(Object.entries(settings).filter(([k]) => !templates.includes(k))), scope) as Record<string, unknown>;
  for (const k of templates) filled[k] = settings[k];
  return { settings: filled, missing };
}

/** The plugin with each {{settings.<key>}} in its connections replaced by the instance's value, which must be a plain name. */
export function bindConnections(plugin: PluginDef, instance: InstanceDef): { plugin: PluginDef; problem?: string } {
  if (!plugin.connections?.some((c) => settingRef(c))) return { plugin };
  const names: string[] = [];
  for (const c of plugin.connections) {
    const key = settingRef(c);
    if (!key) {
      names.push(c);
      continue;
    }
    const v = instance.settings?.[key] ?? plugin.settings?.[key]?.default;
    if (v === undefined || v === null || v === "") return { plugin, problem: `setting ${key} is not set` };
    if (typeof v !== "string" || v.includes("{{")) return { plugin, problem: `setting ${key} must name a connection, not a template` };
    names.push(v);
  }
  return { plugin: { ...plugin, connections: names } };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const GITHUB = "github";

/** Whether a run may use the host's own connections and secrets: only a plugin shipped with todo. */
const hostTrusted = (input: Pick<RunInput, "shipped">) => !!input.shipped;

/** The connections a run gets. A custom plugin gets the repo's own, and github without the host's token unless the
 * repo declares a github of its own; a shipped one gets the host's too. */
function connectionsOf(input: Pick<RunInput, "connections" | "shipped">): Record<string, ResolvedConnection> {
  const all = input.connections ?? {};
  if (hostTrusted(input)) return all;
  const own = Object.fromEntries(Object.entries(all).filter(([, c]) => c.origin !== "host"));
  const github = all[GITHUB];
  if (!own[GITHUB] && github?.kind === "http") own[GITHUB] = { kind: "http", url: github.url, origin: "repo" };
  return own;
}

const hostOnly = (name: string) =>
  `\`${name}\` is this host's connection, which only plugins shipped with todo use; declare a connection named ${name} in the repo's plugin config`;

/** Why this host won't run the plugin, if it won't: a connection it lacks, can't authorize, or mustn't start. */
function connectionProblem(input: Pick<RunInput, "plugin" | "connections" | "shipped" | "allowRepoCommands">): string | undefined {
  const usable = connectionsOf(input);
  for (const name of input.plugin.connections ?? []) {
    const c = usable[name];
    if (!c && input.connections?.[name]?.origin === "host") return hostOnly(name);
    if (!c || (c.kind === "http" && c.auth && !c.secret)) return `\`${name}\` not authorized here`;
    if (c.kind === "mcp" && c.command && (c.origin ?? "repo") === "repo" && !input.allowRepoCommands) {
      return `\`${name}\` runs a command, which this host doesn't allow for repo connections`;
    }
  }
  return undefined;
}

/** Why this host would skip an instance whatever the item: a connection it can't use, or a required setting with no value. */
export function wouldSkip(input: Pick<RunInput, "plugin" | "instance" | "connections" | "shipped" | "allowRepoCommands">): string | undefined {
  const bound = bindConnections(input.plugin, input.instance);
  if (bound.problem) return bound.problem;
  const problem = connectionProblem({ ...input, plugin: bound.plugin });
  if (problem) return problem;
  const { missing } = resolveSettings(input.plugin, input.instance, { item: {}, event: {} });
  return missing ? `setting ${missing} is not set` : undefined;
}

/** Text that must never leave the host: connection secrets and secret settings. */
function secretsOf(input: RunInput): string[] {
  const out = Object.values(input.connections ?? {}).map((c) => c.secret ?? "");
  for (const [k, def] of Object.entries(input.plugin.settings ?? {})) {
    const v = input.instance.settings?.[k];
    if (def.type === "secret" && typeof v === "string") out.push(v);
  }
  return out.filter(Boolean);
}

/** What set a run off, in the words the dev log uses: `review → in-qa`, `manual`, `push feat/x`. */
export function triggerLabel(event: PluginEvent): string {
  if (event.type === "status") return `${event.from} → ${event.to}`;
  if (event.type === "push" || event.type === "pr" || event.type === "deployment") return `${event.type} ${event.branch}`;
  return event.type;
}

export async function runInstance(input: RunInput, deps: HostDeps = {}): Promise<RunResult> {
  const result: RunResult = { attached: [], wouldSend: [], log: [] };
  const { instance, item, event } = input;
  const name = input.name ?? "(unnamed)";
  const skip = (why: string) => finish({ ...result, skipped: input.name ? `${input.name}: ${why}` : why }, secretsOf(input));
  if (input.plugin.use !== undefined) return { ...result, error: `plugin ${name}: use: ${input.plugin.use} must be resolved before it runs` };
  const errors = pluginErrors(name, input.plugin, { shipped: input.shipped === true });
  if (errors.length) return { ...result, error: errors.join("; ") };
  const bound = bindConnections(input.plugin, instance);
  if (bound.problem) return skip(bound.problem);
  const plugin = bound.plugin;
  const problem = connectionProblem({ ...input, plugin });
  if (problem) return skip(problem);
  const { settings, missing } = resolveSettings(plugin, instance, { item, event });
  if (missing) return skip(`setting ${missing} is not set`);
  if (plugin.code && typeof input.code !== "string") return { ...result, error: `the code for ${plugin.code} wasn't given` };

  const repoCode = !!plugin.code && !input.shipped;
  const deadline = Date.now() + (input.limits?.deadlineMs ?? (repoCode ? REPO_CODE_DEADLINE_MS : DEFAULT_DEADLINE_MS));
  const readOnly = (plugin.connections ?? []).find((n) => input.dryRunConnections?.includes(n) && connectionsOf(input)[n]?.origin === "host");
  const dryRun = input.dryRun || !!instance.dry_run || !!readOnly;
  if (readOnly && !input.dryRun && !instance.dry_run) {
    result.dryRun = true;
    addLog(result, `${readOnly} is read-only on this host, so every write is held back`);
  }
  const calls = new Calls(connectionsOf(input), result, { ...deps, dryRun, deadline });
  const attached = new Attached();
  const mayRequest = !!plugin.capabilities?.includes(POST_REQUEST) && !!input.grants?.includes(POST_REQUEST);
  try {
    if (plugin.code) {
      if (plugin.when !== undefined && !test(plugin.when, { item, event, settings })) return skip(`when is false: ${plugin.when}`);
      await runCode({ name, plugin, code: input.code!, item, event, settings, calls, result, attached, mayRequest, deadline, dryRun,
                      instance: { id: instance.id, name: instance.name }, trigger: triggerLabel(event),
                      memoryBytes: input.limits?.memoryBytes, sleep: deps.sleep, isolation: deps.isolation, workerUrl: deps.workerUrl,
                      slots: deps.codeSlots ?? hostCodeSlots(), repoKey: input.repoKey ?? "" });
    } else {
      const self = { instance: { id: instance.id, name: instance.name }, trigger: triggerLabel(event), run: { at: new Date().toISOString() } };
      const { skipped } = await runYaml({ name, plugin, item, event, settings, track: input.track ?? [], self, calls, result, attached, mayRequest });
      if (skipped) return skip(skipped);
    }
    if (!input.shipped) {
      for (const a of attached.list.filter((x) => SHIPPED_KINDS.includes(x.kind))) addLog(result, `dropped a ${a.kind}: only plugins shipped with todo attach one`);
      attached.list.splice(0, attached.list.length, ...attached.list.filter((x) => !SHIPPED_KINDS.includes(x.kind)));
    }
    await fetchDocs(plugin, `${name}/${instance.id}`, item, connectionsOf(input), calls, attached, result);
    result.attached = attached.list;
  } catch (e) {
    result.attached = [];
    result.error = message(e);
    if (calls.retryable(e)) result.transient = true;
  } finally {
    await calls.close();
  }
  return finish(result, secretsOf(input));
}

export interface EventInput {
  /** The repo's plugin config; absent when it has none, which runs the always-on shipped plugins alone. */
  config?: PluginConfig;
  /** Host-wide connections; a shipped plugin keeps the host's of a name the repo's config also declares. */
  hostConnections?: Record<string, ConnectionDef>;
  /** This host's secrets for this repo by connection name, kept apart by where the connection was declared. */
  secrets?: { repo?: Record<string, string>; host?: Record<string, string> };
  /** The instances the host keeps, by plugin. */
  storedInstances?: Record<string, InstanceDef[]>;
  /** Capabilities granted, by plugin. */
  grants?: Record<string, string[]>;
  item: PluginItem;
  event: PluginEvent;
  /** The repo these plugins run for, e.g. owner/name, for its share of code-run slots. */
  repoKey?: string;
  dryRun?: boolean;
  allowRepoCommands?: boolean;
  limits?: Limits;
  /** Host connections this host never writes through, e.g. jira under JIRA_READ_ONLY. */
  dryRunConnections?: string[];
}

export interface EventRun { plugin: string; instance: InstanceDef; result: RunResult }
export interface EventResult { results: EventRun[]; errors: string[]; track: string[] }

export const DEFAULT_INSTANCE: InstanceDef = { id: "default", name: "default" };

function resolveConnection(def: ConnectionDef, origin: ConnectionOrigin, secret: string | undefined): ResolvedConnection | null {
  const extra = { origin, ...(secret === undefined ? {} : { secret }) };
  if ("http" in def && def.http) {
    return { kind: "http", url: def.http.url, ...(def.http.auth ? { auth: def.http.auth } : {}), ...(def.http.paths ? { paths: def.http.paths } : {}), ...extra };
  }
  if ("mcp" in def && def.mcp) return { kind: "mcp", ...def.mcp, ...extra };
  return null;
}

/** The connections a run may get, each with only the secret stored for its own origin. Of a name both declare, a shipped
 * plugin gets the host's, which a config anyone can edit mustn't repoint; a custom plugin gets the repo config's. */
export function connectionsFor(input: Pick<EventInput, "hostConnections" | "secrets">, file: PluginsFile, shipped = false):
    Record<string, ResolvedConnection> {
  const out: Record<string, ResolvedConnection> = {};
  const add = (defs: Record<string, ConnectionDef> | undefined, origin: ConnectionOrigin) => {
    for (const [name, def] of Object.entries(defs ?? {})) {
      const c = resolveConnection(def, origin, input.secrets?.[origin]?.[name]);
      if (c) out[name] = c;
    }
  };
  const order: [Record<string, ConnectionDef> | undefined, ConnectionOrigin][] = [[input.hostConnections, "host"], [file.connections, "repo"]];
  for (const [defs, origin] of shipped ? order.reverse() : order) add(defs, origin);
  return out;
}

export interface Resolved { name: string; def: PluginDef; code?: string; shipped: boolean }

/** The config's plugins with shipped ones resolved, after the always-on shipped plugins. */
export function pluginsFor(input: Pick<EventInput, "config">, file: PluginsFile, errors: string[]): Resolved[] {
  const out = new Map<string, Resolved>();
  const fromRegistry = (name: string) => out.set(name, { name, def: SHIPPED[name].def, code: SHIPPED[name].code, shipped: true });
  for (const name of ALWAYS_ON) fromRegistry(name);
  for (const [name, def] of Object.entries(file.plugins ?? {})) {
    const code = input.config?.code?.[name];
    if (def.use !== undefined) {
      if (def.use === "shipped" && isShipped(name)) fromRegistry(name);
      else errors.push(def.use === "shipped" ? `plugin ${name}: no plugin named ${name} ships with todo` : `plugin ${name}: use: ${def.use} isn't a source todo knows`);
    } else if (isShipped(name)) {
      errors.push(`plugin ${name}: ships with todo, so it is switched on, never redefined`);
    } else if (def.code && typeof code !== "string") {
      errors.push(`plugin ${name}: no code is stored for ${def.code}`);
    } else {
      out.set(name, { name, def, code: def.code ? code : undefined, shipped: false });
    }
  }
  return [...out.values()];
}

const needsNoSettings = (def: PluginDef) => Object.values(def.settings ?? {})
  .every((s) => s.optional || s.default !== undefined || s.type === "list" || s.type === "toggle");

/** The stored instances that are switched on, or an implicit default when none are stored and nothing must be set. */
export function instancesFor(def: PluginDef, stored: InstanceDef[]): InstanceDef[] {
  return allInstances(def, stored).filter((i) => i.enabled !== false);
}

/** Like instancesFor, keeping the ones switched off. */
export function allInstances(def: PluginDef, stored: InstanceDef[]): InstanceDef[] {
  if (stored.length) return stored;
  return needsNoSettings(def) ? [{ ...DEFAULT_INSTANCE }] : [];
}

/** Lets a host take part between instances: skip one, or act on each result as it comes. */
export interface EventHooks {
  /** Called before an instance runs; false skips it. */
  before?(plugin: string, instance: InstanceDef): Promise<boolean>;
  /** Called with each instance's result before the next one runs. */
  after?(run: EventRun): Promise<void>;
}

/** The config's map, and every problem with it; no config is an empty one. */
export function readConfig(config: PluginConfig | undefined): { file: PluginsFile; errors: string[] } {
  if (!config) return { file: {}, errors: [] };
  const { file: { instances, ...file }, errors } = parsePlugins(config.text, { extraPlugins: ALWAYS_ON });
  if (instances) errors.push("instances: a repo's plugin config holds none; instances are stored apart");
  return { file, errors };
}

/** Given a repo's plugin config and an event on an item, run every instance the event fires, one after another. */
export async function runEvent(input: EventInput, deps: HostDeps = {}, hooks: EventHooks = {}): Promise<EventResult> {
  const { file, errors } = readConfig(input.config);
  const connections = { shipped: connectionsFor(input, file, true), custom: connectionsFor(input, file) };
  const results: EventRun[] = [];
  for (const { name, def, code, shipped } of pluginsFor(input, file, errors)) {
    for (const instance of pickInstances(def, instancesFor(def, input.storedInstances?.[name] ?? []), input.event)) {
      if (hooks.before && !(await hooks.before(name, instance))) continue;
      const result = await runInstance({
        plugin: def, name, code, instance, item: input.item, event: input.event, connections: connections[shipped ? "shipped" : "custom"],
        dryRun: !!input.dryRun,
        limits: input.limits, grants: input.grants?.[name], allowRepoCommands: input.allowRepoCommands, shipped,
        repoKey: input.repoKey, track: file.track ?? [], dryRunConnections: input.dryRunConnections,
      }, deps);
      results.push({ plugin: name, instance, result });
      await hooks.after?.(results[results.length - 1]);
    }
  }
  return { results, errors, track: file.track ?? [] };
}
