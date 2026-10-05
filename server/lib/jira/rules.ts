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

export interface Trigger { from: string; to: string; jira: string }

export interface OutboundRules {
  /** Whether this project's Jira calls are sent; off records them as dry runs. */
  writes: boolean;
  comments: boolean;
  /** Jira statuses no trigger may move an issue to. */
  never: string[];
  triggers: Trigger[];
}

export function outboundRules(raw: unknown): OutboundRules | null {
  const r = raw as Partial<OutboundRules> | null | undefined;
  if (!r || typeof r !== "object") return null;
  return { writes: !!r.writes, comments: r.comments !== false, never: r.never ?? [], triggers: r.triggers ?? [] };
}

/** The Jira status a todo move sends the issue to, or null. */
export function outboundTarget(rules: OutboundRules, from: string, to: string): string | null {
  const t = rules.triggers.find((x) => x.from === from && x.to === to);
  return t && !rules.never.some((n) => eq(n, t.jira)) ? t.jira : null;
}

export interface Problem { level: "error" | "warning"; message: string }

/** What's wrong with a rule set; errors block a save, warnings don't. */
export function validateRules(inbound: InboundRules, outbound: OutboundRules, statuses: readonly string[],
                              jiraStatuses?: string[] | null): Problem[] {
  const out: Problem[] = [];
  const error = (message: string) => out.push({ level: "error", message });
  const owner: Record<string, string> = {};
  for (const [jira, set] of Object.entries(inbound.statuses)) {
    if (!set.length) error(`${jira} covers no todo status.`);
    for (const s of set) {
      if (!statuses.includes(s)) error(`${s} under ${jira} isn't a todo status.`);
      else if (owner[s]) error(`${s} is under both ${owner[s]} and ${jira}.`);
      else owner[s] = jira;
    }
  }
  for (const t of inbound.transitions ?? []) {
    for (const side of [t.from, t.to]) if (!statusSet(inbound, side)) error(`The rule ${t.from} → ${t.to} names ${side}, which has no status set.`);
    if (!statuses.includes(t.status)) error(`The rule ${t.from} → ${t.to} lands on ${t.status}, which isn't a todo status.`);
  }
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
    const named = new Set([...Object.keys(inbound.statuses), ...(inbound.transitions ?? []).flatMap((t) => [t.from, t.to]),
                           ...outbound.triggers.map((t) => t.jira), ...outbound.never]);
    for (const n of named) {
      if (n && !jiraStatuses.some((j) => eq(j, n))) out.push({ level: "warning", message: `Jira has no status ${n}.` });
    }
  }
  return out;
}

/** What a todo move does in Jira under these rules, in words. */
export function describeMove(inbound: InboundRules | null, outbound: OutboundRules, from: string, to: string): string {
  const a = inbound ? jiraStatusFor(inbound, from) : null;
  const b = inbound ? jiraStatusFor(inbound, to) : null;
  const where = !inbound ? "" : a === b ? (a ? `both under ${a}; ` : "neither is mirrored; ") : `${a ?? "unmirrored"} → ${b ?? "unmirrored"}; `;
  const t = outbound.triggers.find((x) => x.from === from && x.to === to);
  if (!t) return `${where}no trigger${a && a !== b ? `, Jira stays in ${a}` : ""}.`;
  if (outbound.never.some((n) => eq(n, t.jira))) return `${where}the trigger is ignored: ${t.jira} is never moved to.`;
  return `${where}moves Jira to ${t.jira}.`;
}
