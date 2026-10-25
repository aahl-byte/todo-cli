// Pure pieces of the dashboard actions, kept out of the "use server" module so
// they can be tested directly.
import type { Result } from "./apply";

export interface ActionState {
  ok: boolean;
  message?: string;
  at?: number;
  /** When the winning change was made, for the viewer to show in local time. */
  when?: string | null;
}

/** Kinds a person may post from the dashboard; the rest come from flows
 * (reject, links, requests) that build them deliberately. */
export const POSTABLE_KINDS = ["context", "comment", "clarification"];

/** A same-site path to go to after sign-in, never another origin. */
export function safeNext(next: string): string {
  if (!next.startsWith("/") || /[\u0000-\u0020\\]/.test(next)) return "/";
  try {
    const u = new URL(next, "http://here.invalid");
    const path = u.pathname + u.search + u.hash;
    return u.origin === "http://here.invalid" && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}

const REASONS: Record<string, string> = {
  "checks-pending": "pre-deploy checks are still pending",
  "waits-on": "it waits on a dependency that hasn't landed",
  "agent-handoff": "an agent can't hand work to QA",
  "group-rolled-back": "nothing was applied",
  removed: "it was removed",
  "no-item": "the item no longer exists",
  "request-frozen": "this request version is frozen — post a new version",
  "jira-read-only": "its status follows Jira, which is read-only here",
  "bad-relation": "that item can't be related here",
  "already-related": "those items are already related",
  "invalid-url": "the URL must start with http:// or https://",
  "reason-required": "an override needs a reason",
};

/** A refused stage, from facts that may be behind what a CLI saw. */
export function waitsOnText(x: { edges?: string[]; facts_at?: string | null }): string {
  const when = x.facts_at ? ` (facts from ${x.facts_at.slice(0, 16).replace("T", " ")})` : "";
  return `the server still sees ${(x.edges ?? []).join(", ")}${when}; it's rechecking — retry in a minute, or use --force`;
}

export function describe(results: Result[]): ActionState {
  for (const r of results) {
    for (const x of r.rejected ?? []) {
      if (x.reason === "stale") {
        const value = typeof x.server_value === "string" ? x.server_value : JSON.stringify(x.server_value);
        return { ok: false, message: `${x.by ?? "Someone"} set ${x.field.replace(/^meta\./, "")} → ${value}`, when: x.at ?? null, at: Date.now() };
      }
      if (x.reason === "waits-on" && x.edges?.length) return { ok: false, message: `Not applied: ${waitsOnText(x)}.`, at: Date.now() };
      return { ok: false, message: `Not applied: ${REASONS[x.reason] ?? x.reason}.`, at: Date.now() };
    }
    if (r.status === "rejected") {
      return { ok: false, message: `Not applied: ${REASONS[r.reason ?? ""] ?? r.reason}.`, at: Date.now() };
    }
  }
  return { ok: true, at: Date.now() };
}
