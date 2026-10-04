// Work-queue filters: entries pairing a role with a person (`dev:dana`,
// `qa:quinn`, `by:pat`), shown merged (any entry matches) or one tab each.
export type Role = "dev" | "qa" | "by";
export interface Entry { role: Role; who: string }
export const ROLES: { role: Role; label: string }[] = [
  { role: "dev", label: "assigned to" }, { role: "qa", label: "qa by" }, { role: "by", label: "created by" },
];
export const roleLabel = (r: Role) => ROLES.find((x) => x.role === r)!.label;

export function parseEntries(raw: string | null | undefined): Entry[] {
  const out: Entry[] = [];
  for (const part of (raw ?? "").split(",")) {
    const [role, who] = part.split(":");
    if (who && ROLES.some((r) => r.role === role) && !out.some((e) => e.role === role && e.who === who)) {
      out.push({ role: role as Role, who });
    }
  }
  return out;
}

export const formatEntries = (entries: Entry[]) => entries.map((e) => `${e.role}:${e.who}`).join(",");

interface Person { developer?: string | null; qa_assignee?: string | null; creator?: string | null }

export function matches(c: Person, e: Entry): boolean {
  return (e.role === "dev" ? c.developer : e.role === "qa" ? c.qa_assignee : c.creator) === e.who;
}

/** Merged: any entry. Tabs: the chosen entry alone. No entries: everything. */
export function matchEntries<T extends Person>(rows: T[], entries: Entry[], view: "merged" | "tabs", tab = 0): T[] {
  if (!entries.length) return rows;
  if (view === "tabs") {
    const e = entries[Math.min(Math.max(tab, 0), entries.length - 1)];
    return rows.filter((c) => matches(c, e));
  }
  return rows.filter((c) => entries.some((e) => matches(c, e)));
}

/** The query string for links from before entries existed (`mine`, `dev`, `qa`),
 * or null when there's nothing to rewrite. */
export function legacyQuery(q: Record<string, string | undefined>, me: string): string | null {
  if (!q.mine && !q.dev && !q.qa) return null;
  const entries = parseEntries(q.f);
  const add = (role: Role, who?: string) => { if (who && !entries.some((e) => e.role === role && e.who === who)) entries.push({ role, who }); };
  if (q.mine === "1") { add("dev", me); add("qa", me); add("by", me); }
  add("dev", q.dev);
  add("qa", q.qa);
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v && !["mine", "dev", "qa", "f"].includes(k)) next.set(k, v);
  if (entries.length) next.set("f", formatEntries(entries));
  return next.toString();
}
