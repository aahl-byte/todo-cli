// The plugin host's entry point: run one instance of a plugin against an item
// and an event, and say what it attached, what it would send, and what went wrong.
import { uniqueByKey } from "./attachments";
import { Calls, type ConnectionOptions } from "./connections";
import { runCode } from "./code-runner";
import { test } from "./expr";
import { pluginErrors } from "./load";
import { fillJson } from "./template";
import { runYaml } from "./yaml-runner";
import { DEFAULT_DEADLINE_MS, type InstanceDef, type PluginDef, type RunInput, type RunResult } from "./types";

export interface HostDeps extends ConnectionOptions {
  /** Stands in for the code runner's sleeps, for tests. */
  sleep?: (ms: number) => Promise<void>;
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

export async function runInstance(input: RunInput, deps: HostDeps = {}): Promise<RunResult> {
  const result: RunResult = { attached: [], wouldSend: [], log: [] };
  const { plugin, instance, item, event } = input;
  const errors = pluginErrors(input.name ?? "(unnamed)", plugin);
  if (errors.length) return { ...result, error: errors.join("; ") };
  const absent = (plugin.connections ?? []).find((c) => !input.connections?.[c]);
  if (absent) return { ...result, skipped: `\`${absent}\` not authorized here` };
  const { settings, missing } = resolveSettings(plugin, instance, { item, event });
  if (missing) return { ...result, skipped: `setting ${missing} is not set` };
  if (plugin.code && typeof input.code !== "string") return { ...result, error: `the code for ${plugin.code} wasn't given` };

  const deadline = Date.now() + (input.limits?.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const calls = new Calls(input.connections, result, { ...deps, dryRun: input.dryRun || !!instance.dry_run, deadline });
  try {
    if (plugin.code) {
      if (plugin.when !== undefined && !test(plugin.when, { item, event, settings })) return { ...result, skipped: `when is false: ${plugin.when}` };
      const attached = await runCode({ plugin, code: input.code!, item, event, settings, calls, result,
                                       memoryBytes: input.limits?.memoryBytes, deadline, sleep: deps.sleep });
      result.attached = uniqueByKey(attached, result.log);
    } else {
      const { attached, skipped } = await runYaml({ plugin, item, event, settings, calls, result });
      result.attached = uniqueByKey(attached, result.log);
      if (skipped) result.skipped = skipped;
    }
  } catch (e) {
    result.attached = [];
    result.error = message(e);
  } finally {
    await calls.close();
  }
  return result;
}
