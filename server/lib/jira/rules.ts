// How Jira statuses translate into todo statuses for one project. A Jira
// status stands for a set of todo statuses (todo tracks finer steps than Jira),
// and a transition rule can give a specific move its own meaning.

export interface InboundRules {
  /** Jira status → the todo statuses it covers; the first is the default. */
  statuses: Record<string, string[]>;
  transitions?: { from: string; to: string; status: string }[];
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

export function inboundRules(raw: unknown): InboundRules | null {
  const r = raw as InboundRules | null | undefined;
  return r && r.statuses && Object.keys(r.statuses).length ? r : null;
}

/** The todo statuses a Jira status covers, or null when it isn't mapped. */
export function statusSet(rules: InboundRules, jiraStatus: string): string[] | null {
  const k = Object.keys(rules.statuses).find((s) => eq(s, jiraStatus));
  return k ? rules.statuses[k] : null;
}

/** The todo status an item moves to when Jira goes `from` → `to`, or null for no move. */
export function inboundStatus(rules: InboundRules, current: string | null, from: string | null, to: string): string | null {
  // A rule applies only to an item actually under `from`, so a stale or
  // replayed event can't reinterpret where the item is now.
  const rule = rules.transitions?.find((t) => eq(t.from, from) && eq(t.to, to)
    && (current === null || (statusSet(rules, t.from) ?? []).includes(current)));
  if (rule) return rule.status === current ? null : rule.status;
  const set = statusSet(rules, to);
  if (!set?.length || (current && set.includes(current))) return null;
  return set[0];
}

/** The Jira status a todo status sits under. */
export function jiraStatusFor(rules: InboundRules, todoStatus: string): string | null {
  return Object.keys(rules.statuses).find((k) => rules.statuses[k].includes(todoStatus)) ?? null;
}
