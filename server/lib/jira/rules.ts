// The todo → Jira triggers for one project: which todo moves transition the
// issues an item links, and to which Jira status. The first trigger that fits a
// move is the one that runs; `*` fits any status where the rules allow it.

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/** Any todo status, on either side of a trigger jira-transition runs. */
export const ANY = "*";

export interface Trigger { from: string; to: string; jira: string }

const fits = (t: Pick<Trigger, "from" | "to">, from: string, to: string) =>
  (t.from === ANY || t.from === from) && (t.to === ANY || t.to === to);

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
  const t = rules.triggers.find((x) => fits(x, from, to));
  return t && !rules.never.some((n) => eq(n, t.jira)) ? t.jira : null;
}

export interface Problem { level: "error" | "warning"; message: string }

/** What's wrong with a rule set; errors block a save, warnings don't. `any`: a side may be `*`, as jira-transition's may. */
export function validateRules(outbound: OutboundRules, statuses: readonly string[], jiraStatuses?: string[] | null,
                              opts: { any?: boolean } = {}): Problem[] {
  const out: Problem[] = [];
  const error = (message: string) => { if (!out.some((p) => p.message === message)) out.push({ level: "error", message }); };
  const known = (s: string) => statuses.includes(s) || (!!opts.any && s === ANY);
  const seen = new Set<string>();
  outbound.triggers.forEach((t, i) => {
    for (const s of [t.from, t.to]) if (!known(s)) error(`The trigger ${t.from} → ${t.to} names ${s}, which isn't a todo status.`);
    if (!t.jira.trim()) error(`The trigger ${t.from} → ${t.to} has no Jira status.`);
    if (outbound.never.some((n) => eq(n, t.jira))) error(`The trigger ${t.from} → ${t.to} moves Jira to ${t.jira}, which is never moved to.`);
    const k = `${t.from}>${t.to}`;
    if (seen.has(k)) error(`${t.from} → ${t.to} has two triggers.`);
    else if (opts.any) {
      const first = outbound.triggers.slice(0, i).find((x) => fits(x, t.from, t.to));
      if (first) out.push({ level: "warning", message: `The trigger ${t.from} → ${t.to} never runs: ${first.from} → ${first.to} above it matches first.` });
    }
    seen.add(k);
  });
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
  const t = outbound.triggers.find((x) => fits(x, from, to));
  if (!t) return "no trigger.";
  if (outbound.never.some((n) => eq(n, t.jira))) return `the trigger is ignored: ${t.jira} is never moved to.`;
  return `moves Jira to ${t.jira}.`;
}
