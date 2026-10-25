// The todo → Jira triggers for one project: which todo moves transition the
// issues an item links, and to which Jira status.

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

export interface Trigger { from: string; to: string; jira: string }

export interface OutboundRules {
  /** Whether this project's Jira calls are sent; off records them as dry runs. */
  writes: boolean;
  /** Jira statuses no trigger may move an issue to. */
  never: string[];
  triggers: Trigger[];
}

export function outboundRules(raw: unknown): OutboundRules | null {
  const r = raw as Partial<OutboundRules> | null | undefined;
  if (!r || typeof r !== "object") return null;
  return { writes: !!r.writes, never: r.never ?? [], triggers: r.triggers ?? [] };
}

/** The Jira status a todo move sends the issue to, or null. */
export function outboundTarget(rules: OutboundRules, from: string, to: string): string | null {
  const t = rules.triggers.find((x) => x.from === from && x.to === to);
  return t && !rules.never.some((n) => eq(n, t.jira)) ? t.jira : null;
}

export interface Problem { level: "error" | "warning"; message: string }

/** What's wrong with a rule set; errors block a save, warnings don't. */
export function validateRules(outbound: OutboundRules, statuses: readonly string[], jiraStatuses?: string[] | null): Problem[] {
  const out: Problem[] = [];
  const error = (message: string) => out.push({ level: "error", message });
  const seen = new Set<string>();
  for (const t of outbound.triggers) {
    for (const s of [t.from, t.to]) if (!statuses.includes(s)) error(`The trigger ${t.from} → ${t.to} names ${s}, which isn't a todo status.`);
    if (!t.jira.trim()) error(`The trigger ${t.from} → ${t.to} has no Jira status.`);
    if (outbound.never.some((n) => eq(n, t.jira))) error(`The trigger ${t.from} → ${t.to} moves Jira to ${t.jira}, which is never moved to.`);
    const k = `${t.from}>${t.to}`;
    if (seen.has(k)) error(`${t.from} → ${t.to} has two triggers.`);
    seen.add(k);
  }
  if (jiraStatuses?.length) {
    const named = new Set([...outbound.triggers.map((t) => t.jira), ...outbound.never]);
    for (const n of named) {
      if (n && !jiraStatuses.some((j) => eq(j, n))) out.push({ level: "warning", message: `Jira has no status ${n}.` });
    }
  }
  return out;
}

/** What a todo move does in Jira under these rules, in words. */
export function describeMove(outbound: OutboundRules, from: string, to: string): string {
  const t = outbound.triggers.find((x) => x.from === from && x.to === to);
  if (!t) return "no trigger.";
  if (outbound.never.some((n) => eq(n, t.jira))) return `the trigger is ignored: ${t.jira} is never moved to.`;
  return `moves Jira to ${t.jira}.`;
}
