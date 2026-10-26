// The unresolved dependency edges that stop an item staging or deploying, one
// line each as the move dialog lists them: what it waits on, where, and why,
// worded as the CLI's stage guard words them. Pure, so the page and the tests share it.
import type { Edge } from "./gitfacts";

export interface WaitLine {
  /** The item it waits on, by id, when it's one. */
  item: string | null;
  /** What it waits on otherwise, such as a PR URL or a branch. */
  needs: string | null;
  branch: string | null;
  state: string;
  why: string;
}

export function waitLines(edges: Edge[]): WaitLine[] {
  return edges.map((e) => {
    let why = e.evidence ?? "";
    if (e.state === "unknown") why += `${why ? " " : ""}(unknown: ${e.reason || "not computed"})`;
    if (e.cycle) why += `${why ? "; " : ""}${e.cycle}`;
    return { item: e.id ?? null, needs: e.id ? null : e.needs ?? "?", branch: e.branch ?? null, state: e.state, why };
  });
}

/** The moves the dependency guard refuses, as gitfacts.ts GUARDED lists them, for client code that can't import it. */
export const GUARDED_MOVES: readonly string[] = ["ready-to-deploy", "deployed"];

/** The forcing button of a move the guard refused. */
export const forceLabel = (to: string) => (to === "deployed" ? "Deploy anyway" : "Stage anyway");
