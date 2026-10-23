// The plugin host's entry point: run one instance of a plugin against an item
// and an event, and say what it attached, what it would send, and what went wrong.
import { Calls, type ConnectionOptions } from "./connections";
import { runCode, type Isolation } from "./code-runner";
import { test } from "./expr";
import { Attached, finish } from "./limits";
import { pluginErrors } from "./load";
import { fillJson } from "./template";
import { runYaml } from "./yaml-runner";
import { DEFAULT_DEADLINE_MS, POST_REQUEST, type InstanceDef, type PluginDef, type RunInput, type RunResult } from "./types";

export interface HostDeps extends ConnectionOptions {
  /** Stands in for the code runner's sleeps, for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Where code plugins run: a worker thread (the default) or this thread, for a host that is its own process. */
  isolation?: Isolation;
  /** The worker script, for hosts whose bundler moves it. */
  workerUrl?: URL;
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
  const errors = pluginErrors(name, plugin, { shipped: true });
  if (errors.length) return { ...result, error: errors.join("; ") };
  const problem = connectionProblem(input);
  if (problem) return skip(problem);
  const { settings, missing } = resolveSettings(plugin, instance, { item, event });
  if (missing) return skip(`setting ${missing} is not set`);
  if (plugin.code && typeof input.code !== "string") return { ...result, error: `the code for ${plugin.code} wasn't given` };

  const deadline = Date.now() + (input.limits?.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const calls = new Calls(input.connections, result, { ...deps, dryRun: input.dryRun || !!instance.dry_run, deadline });
  const attached = new Attached();
  const mayRequest = !!plugin.capabilities?.includes(POST_REQUEST) && !!input.grants?.includes(POST_REQUEST);
  try {
    if (plugin.code) {
      if (plugin.when !== undefined && !test(plugin.when, { item, event, settings })) return skip(`when is false: ${plugin.when}`);
      await runCode({ name, plugin, code: input.code!, item, event, settings, calls, result, attached, mayRequest, deadline,
                      memoryBytes: input.limits?.memoryBytes, sleep: deps.sleep, isolation: deps.isolation, workerUrl: deps.workerUrl });
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
