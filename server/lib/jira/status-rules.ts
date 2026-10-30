// jira-status-transitions' instances as editor rows: one instance per Jira
// move, its settings the row. Pure, so the page and the tests share it.
import type { InstanceDef } from "../plugins/types";
import type { Problem } from "./rules";

export const JIRA_STATUS_TRANSITIONS = "jira-status-transitions";

export interface StatusRule {
  jiraFrom: string;
  jiraTo: string;
  from: string;
  to: string;
  note: string;
  /** The instance id it saves under; absent for a new row. */
  id?: string;
  /** Its instance moves items, rather than only recording; absent for a new row. */
  live?: boolean;
  /** Its instance is switched off. */
  off?: boolean;
}

export interface StatusRules {
  /** Every row moves items (true), every row only records (false), or some of each (null). */
  moves: boolean | null;
  rules: StatusRule[];
}

const text = (v: unknown) => (typeof v === "string" ? v : "");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "any";

export function statusRules(instances: InstanceDef[]): StatusRules {
  const rules = instances.map((i): StatusRule => {
    const s = i.settings ?? {};
    return { jiraFrom: text(s.jira_from), jiraTo: text(s.jira_to), from: text(s.from), to: text(s.to), note: text(s.note),
             id: i.id, live: !i.dry_run, ...(i.enabled === false ? { off: true } : {}) };
  });
  const moves = !rules.length ? false : rules.every((r) => r.live) ? true : rules.every((r) => !r.live) ? false : null;
  return { moves, rules };
}

/** The instances a set of rows saves as. A row takes the switch's state once it's flipped, else keeps its own. */
export function statusRuleInstances(p: StatusRules): InstanceDef[] {
  const taken = new Set(p.rules.map((r) => r.id).filter((id): id is string => !!id));
  const unique = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  return p.rules.map((r) => {
    const live = p.moves === null ? !!r.live : p.moves;
    const [jiraFrom, jiraTo, note] = [r.jiraFrom.trim(), r.jiraTo.trim(), r.note.trim()];
    return {
      id: r.id ?? unique(`jira-${slug(jiraFrom)}-${slug(jiraTo)}`), name: `Jira ${jiraFrom} → ${jiraTo}: ${r.from} → ${r.to}`,
      settings: { jira_from: jiraFrom, jira_to: jiraTo, from: r.from, to: r.to, ...(note ? { note } : {}) },
      ...(live ? {} : { dry_run: true }), ...(r.off ? { enabled: false } : {}),
    };
  });
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** What's wrong with a set of rows; errors block a save, warnings don't. */
export function validateStatusRules(p: StatusRules, statuses: readonly string[], jiraStatuses?: string[] | null): Problem[] {
  const out: Problem[] = [];
  const add = (level: Problem["level"], message: string) => { if (!out.some((x) => x.message === message)) out.push({ level, message }); };
  p.rules.forEach((r, i) => {
    const name = `Jira ${r.jiraFrom || "?"} → ${r.jiraTo || "?"}`;
    if (!r.jiraFrom.trim() || !r.jiraTo.trim()) add("error", `${name} needs both Jira statuses.`);
    if (!statuses.includes(r.from) || !statuses.includes(r.to)) add("error", `${name} needs both todo statuses.`);
    else if (r.from === r.to) add("error", `${name} moves the item from ${r.from} to itself.`);
    const twin = p.rules.slice(0, i).find((x) => same(x.jiraFrom, r.jiraFrom) && same(x.jiraTo, r.jiraTo) && x.from === r.from);
    if (twin && r.jiraFrom.trim()) add("error", `${name} from ${r.from} has two rows.`);
    if (jiraStatuses?.length) {
      for (const s of [r.jiraFrom, r.jiraTo]) if (s.trim() && !jiraStatuses.some((j) => same(j, s))) add("warning", `Jira has no status ${s}.`);
    }
  });
  return out;
}
