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
  "agent-handoff": "an agent can't hand work to QA",
  "group-rolled-back": "nothing was applied",
  removed: "it was removed",
  "no-item": "the item no longer exists",
  "request-locked": "the request can only change while the item is requested",
};

export function describe(results: Result[]): ActionState {
  for (const r of results) {
    for (const x of r.rejected ?? []) {
      if (x.reason === "stale") {
        const value = typeof x.server_value === "string" ? x.server_value : JSON.stringify(x.server_value);
        return { ok: false, message: `${x.by ?? "Someone"} set ${x.field.replace(/^meta\./, "")} → ${value}`, when: x.at ?? null, at: Date.now() };
      }
      return { ok: false, message: `Not applied: ${REASONS[x.reason] ?? x.reason}.`, at: Date.now() };
    }
    if (r.status === "rejected") {
      return { ok: false, message: `Not applied: ${REASONS[r.reason ?? ""] ?? r.reason}.`, at: Date.now() };
    }
  }
  return { ok: true, at: Date.now() };
}
