// The plugin host's entry point: run one instance of a plugin against an item
// and an event, and say what it attached, what it would send, and what went wrong.
import { Calls, type ConnectionOptions } from "./connections";
import { hostCodeSlots, REPO_CODE_DEADLINE_MS, runCode, type CodeSlots, type Isolation } from "./code-runner";
import { test } from "./expr";
import { addLog, Attached, finish } from "./limits";
import { parsePlugins, pluginErrors, settingRef } from "./load";
import { fetchDocs } from "./docs";
import { ALWAYS_ON, SHIPPED } from "./shipped";
import { pickInstances } from "./triggers";
import { fillJson } from "./template";
import { runYaml } from "./yaml-runner";
import {
  DEFAULT_DEADLINE_MS, POST_REQUEST, SHIPPED_KINDS, type ConnectionDef, type ConnectionOrigin, type InstanceDef, type Limits, type PluginDef, type PluginEvent,
  type PluginItem, type PluginsFile, type ResolvedConnection, type RunInput, type RunResult,
} from "./types";

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

/** Whether a run may use the host's own connections: only a shipped plugin's instance that the repo's file doesn't declare. */
const hostTrusted = (input: Pick<RunInput, "shipped" | "repoInstance">) => !!input.shipped && !input.repoInstance;

/** The connections a run gets: the host's own only when it may use them. */
function connectionsOf(input: Pick<RunInput, "connections" | "shipped" | "repoInstance">): Record<string, ResolvedConnection> {
  if (hostTrusted(input)) return input.connections ?? {};
  return Object.fromEntries(Object.entries(input.connections ?? {}).filter(([, c]) => c.origin !== "host"));
}

const hostOnly = (name: string, shipped: boolean) => shipped
  ? `\`${name}\` is this host's connection, which an instance declared in the repo's plugins file doesn't get; store the instance on the server instead, or name a repo connection`
  : `\`${name}\` is this host's connection, which only plugins shipped with todo use; declare a repo connection named ${name}`;

/** Why this host won't run the plugin, if it won't: a connection it lacks, can't authorize, or mustn't start. */
function connectionProblem(input: Pick<RunInput, "plugin" | "connections" | "shipped" | "allowRepoCommands" | "repoInstance">): string | undefined {
  for (const name of input.plugin.connections ?? []) {
    const c = input.connections?.[name];
    if (c?.origin === "host" && !hostTrusted(input)) return hostOnly(name, !!input.shipped);
    if (!c || (c.kind === "http" && c.auth && !c.secret)) return `\`${name}\` not authorized here`;
    if (c.kind === "mcp" && c.command && (c.origin ?? "repo") === "repo" && !input.allowRepoCommands) {
      return `\`${name}\` runs a command, which this host doesn't allow for repo connections`;
    }
  }
  return undefined;
}

/** Why this host would skip an instance whatever the item: a connection it can't use, or a required setting with no value. */
export function wouldSkip(input: Pick<RunInput, "plugin" | "instance" | "connections" | "shipped" | "allowRepoCommands" | "repoInstance">): string | undefined {
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
  /** The repo's .todo-plugins/plugins.yaml and its code files by name; absent when the repo has none. */
  repo?: { text: string; files: Record<string, string> };
  /** Host-wide connections; a repo's connection of the same name overrides one. */
  hostConnections?: Record<string, ConnectionDef>;
  /** This host's secrets for this repo by connection name, kept apart by where the connection was declared. */
  secrets?: { repo?: Record<string, string>; host?: Record<string, string> };
  /** Instances the host keeps: one with a repo instance's id overrides it, the rest are added. */
  storedInstances?: Record<string, InstanceDef[]>;
  /** Capabilities granted, by plugin. */
  grants?: Record<string, string[]>;
  item: PluginItem;
  event: PluginEvent;
  /** The repo these plugins come from, e.g. owner/name, for its share of code-run slots. */
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
  if ("http" in def && def.http) return { kind: "http", url: def.http.url, ...(def.http.auth ? { auth: def.http.auth } : {}), ...extra };
  if ("mcp" in def && def.mcp) return { kind: "mcp", ...def.mcp, ...extra };
  return null;
}

/** The host's connections, then the repo's over them, each with only the secret stored for its own origin. */
export function connectionsFor(input: Pick<EventInput, "hostConnections" | "secrets">, file: PluginsFile): Record<string, ResolvedConnection> {
  const out: Record<string, ResolvedConnection> = {};
  const add = (defs: Record<string, ConnectionDef> | undefined, origin: ConnectionOrigin) => {
    for (const [name, def] of Object.entries(defs ?? {})) {
      const c = resolveConnection(def, origin, input.secrets?.[origin]?.[name]);
      if (c) out[name] = c;
    }
  };
  add(input.hostConnections, "host");
  add(file.connections, "repo");
  return out;
}

export interface Resolved { name: string; def: PluginDef; code?: string; shipped: boolean }

/** The repo file's plugins with shipped ones resolved, after the always-on shipped plugins. */
export function pluginsFor(input: Pick<EventInput, "repo">, file: PluginsFile, errors: string[]): Resolved[] {
  const out = new Map<string, Resolved>();
  const fromRegistry = (name: string) => out.set(name, { name, def: SHIPPED[name].def, code: SHIPPED[name].code, shipped: true });
  for (const name of ALWAYS_ON) fromRegistry(name);
  for (const [name, def] of Object.entries(file.plugins ?? {})) {
    if (def.use !== undefined) {
      if (def.use === "shipped" && SHIPPED[name]) fromRegistry(name);
      else errors.push(def.use === "shipped" ? `plugin ${name}: no plugin named ${name} ships with todo` : `plugin ${name}: use: ${def.use} isn't a source todo knows`);
    } else if (name in SHIPPED) {
      errors.push(`plugin ${name}: ships with todo, so the repo can only enable it with use: shipped`);
    } else if (def.code && !(def.code in (input.repo?.files ?? {}))) {
      errors.push(`plugin ${name}: ${def.code} isn't in .todo-plugins/`);
    } else {
      out.set(name, { name, def, code: def.code ? input.repo!.files[def.code] : undefined, shipped: false });
    }
  }
  return [...out.values()];
}

const needsNoSettings = (def: PluginDef) => Object.values(def.settings ?? {})
  .every((s) => s.optional || s.default !== undefined || s.type === "list" || s.type === "toggle");

/**
 * The repo's instances, overridden or added to by stored ones. An implicit default appears when there are
 * none, nothing must be set, and load dropped none of the repo's.
 */
export function instancesFor(def: PluginDef, repo: InstanceDef[], stored: InstanceDef[], droppedSome = false): InstanceDef[] {
  return allInstances(def, repo, stored, droppedSome).filter((i) => i.enabled !== false);
}

/** Like instancesFor, keeping the ones switched off. */
export function allInstances(def: PluginDef, repo: InstanceDef[], stored: InstanceDef[], droppedSome = false): InstanceDef[] {
  const merged = repo.map((r) => {
    const s = stored.find((x) => x.id === r.id);
    return s ? { ...r, ...s, settings: { ...r.settings, ...s.settings } } : r;
  });
  merged.push(...stored.filter((s) => !repo.some((r) => r.id === s.id)));
  if (!merged.length && !droppedSome && needsNoSettings(def)) merged.push({ ...DEFAULT_INSTANCE });
  return merged;
}

/** Lets a host take part between instances: skip one, or act on each result as it comes. */
export interface EventHooks {
  /** Called before an instance runs; false skips it. */
  before?(plugin: string, instance: InstanceDef): Promise<boolean>;
  /** Called with each instance's result before the next one runs. */
  after?(run: EventRun): Promise<void>;
}

/** Given a repo's plugin file and an event on an item, run every instance the event fires, one after another. */
export async function runEvent(input: EventInput, deps: HostDeps = {}, hooks: EventHooks = {}): Promise<EventResult> {
  const errors: string[] = [];
  let file: PluginsFile = {};
  let dropped: string[] = [];
  if (input.repo) {
    const loaded = parsePlugins(input.repo.text, { extraPlugins: ALWAYS_ON });
    file = loaded.file;
    dropped = loaded.droppedInstances;
    errors.push(...loaded.errors);
  }
  const connections = connectionsFor(input, file);
  const results: EventRun[] = [];
  for (const { name, def, code, shipped } of pluginsFor(input, file, errors)) {
    const declared = (file.instances?.[name] ?? []).map((i) => i.id);
    const instances = instancesFor(def, file.instances?.[name] ?? [], input.storedInstances?.[name] ?? [], dropped.includes(name));
    for (const instance of pickInstances(def, instances, input.event)) {
      if (hooks.before && !(await hooks.before(name, instance))) continue;
      const result = await runInstance({
        plugin: def, name, code, instance, item: input.item, event: input.event, connections, dryRun: !!input.dryRun,
        limits: input.limits, grants: input.grants?.[name], allowRepoCommands: input.allowRepoCommands, shipped,
        repoKey: input.repoKey, track: file.track ?? [], repoInstance: declared.includes(instance.id), dryRunConnections: input.dryRunConnections,
      }, deps);
      results.push({ plugin: name, instance, result });
      await hooks.after?.(results[results.length - 1]);
    }
  }
  return { results, errors, track: file.track ?? [] };
}
