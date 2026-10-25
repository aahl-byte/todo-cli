// The plugin host's entry point: run one instance of a plugin against an item
// and an event, and say what it attached, what it would send, and what went wrong.
import { Calls, type ConnectionOptions } from "./connections";
import { hostCodeSlots, REPO_CODE_DEADLINE_MS, runCode, type CodeSlots, type Isolation } from "./code-runner";
import { test } from "./expr";
import { Attached, finish } from "./limits";
import { parsePlugins, pluginErrors } from "./load";
import { ALWAYS_ON, SHIPPED } from "./shipped";
import { pickInstances } from "./triggers";
import { fillJson } from "./template";
import { runYaml } from "./yaml-runner";
import {
  DEFAULT_DEADLINE_MS, POST_REQUEST, type ConnectionDef, type ConnectionOrigin, type InstanceDef, type Limits, type PluginDef, type PluginEvent,
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
  return { settings: fillJson(settings, scope) as Record<string, unknown>, missing };
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why this host won't run the plugin, if it won't: a connection it lacks, can't authorize, or mustn't start. */
function connectionProblem(input: RunInput): string | undefined {
  for (const name of input.plugin.connections ?? []) {
    const c = input.connections?.[name];
    if (!c || (c.kind === "http" && c.auth && !c.secret)) return `\`${name}\` not authorized here`;
    if (c.kind === "mcp" && c.command && (c.origin ?? "repo") === "repo" && !input.allowRepoCommands) {
      return `\`${name}\` runs a command, which this host doesn't allow for repo connections`;
    }
  }
  return undefined;
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

export async function runInstance(input: RunInput, deps: HostDeps = {}): Promise<RunResult> {
  const result: RunResult = { attached: [], wouldSend: [], log: [] };
  const { plugin, instance, item, event } = input;
  const name = input.name ?? "(unnamed)";
  const skip = (why: string) => finish({ ...result, skipped: input.name ? `${input.name}: ${why}` : why }, secretsOf(input));
  if (plugin.use !== undefined) return { ...result, error: `plugin ${name}: use: ${plugin.use} must be resolved before it runs` };
  const errors = pluginErrors(name, plugin, { shipped: input.shipped === true });
  if (errors.length) return { ...result, error: errors.join("; ") };
  const problem = connectionProblem(input);
  if (problem) return skip(problem);
  const { settings, missing } = resolveSettings(plugin, instance, { item, event });
  if (missing) return skip(`setting ${missing} is not set`);
  if (plugin.code && typeof input.code !== "string") return { ...result, error: `the code for ${plugin.code} wasn't given` };

  const repoCode = !!plugin.code && !input.shipped;
  const deadline = Date.now() + (input.limits?.deadlineMs ?? (repoCode ? REPO_CODE_DEADLINE_MS : DEFAULT_DEADLINE_MS));
  const calls = new Calls(input.connections, result, { ...deps, dryRun: input.dryRun || !!instance.dry_run, deadline });
  const attached = new Attached();
  const mayRequest = !!plugin.capabilities?.includes(POST_REQUEST) && !!input.grants?.includes(POST_REQUEST);
  try {
    if (plugin.code) {
      if (plugin.when !== undefined && !test(plugin.when, { item, event, settings })) return skip(`when is false: ${plugin.when}`);
      await runCode({ name, plugin, code: input.code!, item, event, settings, calls, result, attached, mayRequest, deadline,
                      memoryBytes: input.limits?.memoryBytes, sleep: deps.sleep, isolation: deps.isolation, workerUrl: deps.workerUrl,
                      slots: deps.codeSlots ?? hostCodeSlots(), repoKey: input.repoKey ?? "" });
      result.attached = attached.list;
    } else {
      const { skipped } = await runYaml({ name, plugin, item, event, settings, calls, result, attached, mayRequest });
      result.attached = attached.list;
      if (skipped) return skip(skipped);
    }
  } catch (e) {
    result.attached = [];
    result.error = message(e);
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
function connectionsFor(input: EventInput, file: PluginsFile): Record<string, ResolvedConnection> {
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

interface Resolved { name: string; def: PluginDef; code?: string; shipped: boolean }

/** The repo file's plugins with shipped ones resolved, after the always-on shipped plugins. */
function pluginsFor(input: EventInput, file: PluginsFile, errors: string[]): Resolved[] {
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
  const merged = repo.map((r) => {
    const s = stored.find((x) => x.id === r.id);
    return s ? { ...r, ...s, settings: { ...r.settings, ...s.settings } } : r;
  });
  merged.push(...stored.filter((s) => !repo.some((r) => r.id === s.id)));
  if (!merged.length && !droppedSome && needsNoSettings(def)) merged.push({ ...DEFAULT_INSTANCE });
  return merged.filter((i) => i.enabled !== false);
}

/** Given a repo's plugin file and an event on an item, run every instance the event fires, one after another. */
export async function runEvent(input: EventInput, deps: HostDeps = {}): Promise<EventResult> {
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
    const instances = instancesFor(def, file.instances?.[name] ?? [], input.storedInstances?.[name] ?? [], dropped.includes(name));
    for (const instance of pickInstances(def, instances, input.event)) {
      const result = await runInstance({
        plugin: def, name, code, instance, item: input.item, event: input.event, connections, dryRun: !!input.dryRun,
        limits: input.limits, grants: input.grants?.[name], allowRepoCommands: input.allowRepoCommands, shipped,
        repoKey: input.repoKey,
      }, deps);
      results.push({ plugin: name, instance, result });
    }
  }
  return { results, errors, track: file.track ?? [] };
}
