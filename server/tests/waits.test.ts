import { describe, expect, it } from "vitest";
import { GUARDED } from "@/lib/gitfacts";
import { forceLabel, GUARDED_MOVES, waitLines } from "@/lib/waits";

describe("the edges a stage or deploy waits on, as the move dialog lists them", () => {
  it("names what each waits on, its branch and state, and why", () => {
    expect(waitLines([
      { id: "api-tokens", branch: "feat/api-tokens", state: "waiting", source: "git", evidence: "feat/hooks's PR is based on feat/api-tokens" },
      { needs: "https://github.com/acme/db/pull/560", state: "unknown", source: "plugin", reason: "not checked yet", evidence: "db-request #12 add index" },
      { id: "old", state: "stale", source: "git", evidence: "its PR closed unmerged", cycle: "old and this wait on each other" },
    ])).toEqual([
      { item: "api-tokens", needs: null, branch: "feat/api-tokens", state: "waiting", why: "feat/hooks's PR is based on feat/api-tokens" },
      { item: null, needs: "https://github.com/acme/db/pull/560", branch: null, state: "unknown", why: "db-request #12 add index (unknown: not checked yet)" },
      { item: "old", needs: null, branch: null, state: "stale", why: "its PR closed unmerged; old and this wait on each other" },
    ]);
  });

  it("says unknown with no reason as not computed", () => {
    expect(waitLines([{ needs: "feat/x", state: "unknown", source: "git" }])[0].why).toBe("(unknown: not computed)");
  });

  it("guards the moves the server guards", () => {
    expect(GUARDED_MOVES).toEqual(GUARDED);
  });

  it("labels the forced move by where it goes", () => {
    expect(forceLabel("ready-to-deploy")).toBe("Stage anyway");
    expect(forceLabel("deployed")).toBe("Deploy anyway");
  });
});
