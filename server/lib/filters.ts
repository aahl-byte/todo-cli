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
    const e = entries[Math.min(Math.max(Math.trunc(tab) || 0, 0), entries.length - 1)];
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
  if (q.mine === "1") next.set("view", "merged");
  return next.toString();
}

/** URL params that make up a work-queue filter, remembered per project. */
export const FILTER_KEYS = ["f", "view", "tab", "type", "app", "review", "parked"];
export const SHARED_KEYS = ["f", "view", "tab", "type", "app"];
export const filterCookie = (project: string) => `todo_filter_${project.replace(/[^\w-]/g, "_")}`;

/** The query string a filter cookie holds, decoded once if it is still encoded. */
export function cookieQuery(raw: string): string {
  if (raw.includes("=")) return raw;
  try { return decodeURIComponent(raw); } catch { return ""; }
}

/** The filter part of a query string, or "" when there is none. */
export function filterPart(q: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) { const v = q.get(k); if (v) out.set(k, v); }
  return out.toString();
}

/** The query string to redirect to when the URL has no filter but one is
 * remembered, or null. */
export function restoreFilter(q: Record<string, string | undefined>, cookie: string | undefined): string | null {
  if (!cookie || FILTER_KEYS.some((k) => q[k])) return null;
  const saved = new URLSearchParams(filterPart(new URLSearchParams(cookieQuery(cookie))));
  if (!saved.toString()) return null;
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) next.set(k, v);
  for (const [k, v] of saved) next.set(k, v);
  return next.toString();
}
