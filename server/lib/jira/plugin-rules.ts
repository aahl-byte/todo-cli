// jira-transition's instances as the Jira bridge's triggers: one instance per
// trigger, its status move the trigger and its `to` setting the Jira status, in
// order, since only the first that fits a move runs. Pure, so the page, the
// move from the bridge and the tests share it.
import type { InstanceDef } from "../plugins/types";
import { ANY, type OutboundRules, type Trigger } from "./rules";

/** One editor row: a trigger, and the instance it came from. */
export interface PluginTrigger extends Trigger {
  /** The instance id it saves under; absent for a new row. */
  id?: string;
  /** Its instance sends, rather than only recording; absent for a new row. */
  live?: boolean;
  /** Its instance is switched off. */
  off?: boolean;
  /** An instance the rows can't show, such as one with a button, saved back as it was. */
  kept?: InstanceDef;
}

export interface PluginRules {
  /** Every row sends (true), every row only records (false), or some of each (null). */
  writes: boolean | null;
  never: string[];
  triggers: PluginTrigger[];
}

const slug = (s: string) => (s === ANY ? "any" : s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The rows for jira-transition's stored instances. */
export function pluginRules(instances: InstanceDef[]): PluginRules {
  const taken = new Set(instances.map((i) => i.id));
  const triggers: PluginTrigger[] = [];
  let never: string[] | null = null;
  for (const i of instances) {
    const s = i.settings ?? {};
    if (!never && Array.isArray(s.never)) never = s.never.map(String);
    const on = i.on ?? [];
    if (on.some((t) => typeof t !== "object")) {
      triggers.push({ from: "", to: "", jira: typeof s.to === "string" ? s.to : "", id: i.id, kept: i });
      continue;
    }
    const base = { jira: typeof s.to === "string" ? s.to : "", live: !i.dry_run, ...(i.enabled === false ? { off: true } : {}) };
    if (!on.length) triggers.push({ from: "", to: "", ...base, id: i.id });
    on.forEach((t, n) => {
      const { from, to } = (t as { status: { from?: string; to?: string } }).status;
      triggers.push({ from: from ?? ANY, to: to ?? ANY, ...base, id: n ? unique(`${i.id}-${n + 1}`, taken) : i.id });
    });
  }
  const rows = triggers.filter((t) => !t.kept);
  const writes = !rows.length ? false : rows.every((t) => t.live) ? true : rows.every((t) => !t.live) ? false : null;
  return { writes, never: never ?? [], triggers };
}

/** The instances a set of rows saves as. A row takes the switch's state once it's flipped, else keeps its own. */
export function ruleInstances(p: PluginRules): InstanceDef[] {
  const taken = new Set(p.triggers.map((t) => t.id).filter((id): id is string => !!id));
  const never = p.never.map((n) => n.trim()).filter(Boolean);
  return p.triggers.map((t) => {
    if (t.kept) return t.kept;
    const jira = t.jira.trim();
    const status: { from?: string; to?: string } = {};
    if (t.from && t.from !== ANY) status.from = t.from;
    if (t.to && t.to !== ANY) status.to = t.to;
    const live = p.writes === null ? !!t.live : p.writes;
    return {
      id: t.id ?? unique(`jira-${slug(t.from)}-${slug(t.to)}`, taken), name: `${t.from} → ${t.to}: Jira ${jira}`, on: [{ status }],
      settings: { to: jira, never }, ...(live ? {} : { dry_run: true }), ...(t.off ? { enabled: false } : {}),
    };
  });
}

const runsOn = (i: InstanceDef) => (i.on ?? []).filter((t) => typeof t === "string").map((t) => (t === "manual" ? "a button press" : `a ${t}`));

/** The Jira bridge's triggers for jira-transition's instances, and what keeps them from going back. A switched-off instance stays behind. */
export function rulesOf(instances: InstanceDef[]): { rules: OutboundRules; problems: string[] } {
  const p = pluginRules(instances);
  const problems: string[] = [];
  const triggers: Trigger[] = [];
  for (const t of p.triggers) {
    if (t.kept) problems.push(`${t.kept.name || t.kept.id} runs on ${runsOn(t.kept).join(" or ")}, which the Jira bridge can't do.`);
    else if (t.off) continue;
    else if (t.from === ANY || t.to === ANY) problems.push(`The trigger ${t.from} → ${t.to} can't go back: the Jira bridge needs both statuses.`);
    else triggers.push({ from: t.from, to: t.to, jira: t.jira.trim() });
  }
  if (p.writes === null) problems.push("Some triggers send and some only record: set Send to Jira for all of them first.");
  return { rules: { writes: !!p.writes, never: p.never, triggers }, problems };
}
