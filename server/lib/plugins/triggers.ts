// Which instances an event fires, and the duration strings plugins use.
import type { InstanceDef, PluginDef, PluginEvent, Trigger } from "./types";

const UNITS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/;
export const ANY = "*";

/** "2s", "15m", "1h" in ms; a number is already ms. */
export function parseDuration(d: string | number): number {
  if (typeof d === "number" && Number.isFinite(d) && d >= 0) return d;
  const m = typeof d === "string" ? d.trim().match(DURATION) : null;
  if (!m) throw new Error(`not a duration: ${JSON.stringify(d)}`);
  return Number(m[1]) * UNITS[m[2]];
}

const matches = (want: string | undefined, got: string) => want === undefined || want === ANY || want === got;

function fires(trigger: Trigger, event: PluginEvent, instance: InstanceDef): boolean {
  if (typeof trigger === "object") {
    return event.type === "status" && matches(trigger.status.from, event.from) && matches(trigger.status.to, event.to);
  }
  if (trigger === "manual") return event.type === "manual" && event.instance === instance.id;
  return trigger === event.type;
}

export function triggersOf(plugin: PluginDef, instance: InstanceDef): Trigger[] {
  return instance.on ?? plugin.on ?? [];
}

const GIT_TRIGGERS: Trigger[] = ["push", "pr", "deployment"];

/** A refresh rechecks state that can change on its own: git-triggered instances and every: floors, never status moves or buttons. */
function firesOnRefresh(plugin: PluginDef, instance: InstanceDef): boolean {
  return !!plugin.every || triggersOf(plugin, instance).some((t) => GIT_TRIGGERS.includes(t));
}

/** The enabled instances this event fires, in order; with exclusive, only the first. */
export function pickInstances(plugin: PluginDef, instances: InstanceDef[], event: PluginEvent): InstanceDef[] {
  const picked = instances.filter((i) => i.enabled !== false && (event.type === "refresh"
    ? firesOnRefresh(plugin, i)
    : triggersOf(plugin, i).some((t) => fires(t, event, i))));
  return plugin.exclusive ? picked.slice(0, 1) : picked;
}
