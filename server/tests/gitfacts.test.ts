import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as factsPOST } from "@/app/api/projects/[key]/git-facts/route";
import { describe as describeResults } from "@/lib/action-helpers";
import { computeProject, itemGitFacts, recomputing, resetGitFactsCache, storedFacts, trackList, type Fetch } from "@/lib/gitfacts";
import { recordCheckout } from "@/lib/checkouts";
import { child, item, set, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
  await w.d.exec("truncate git_facts");
  resetGitFactsCache();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "t");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const sha = (c: string) => c.repeat(40).slice(0, 40);
const n = (s: string) => s.slice(0, 12);
const [S, M, A, A2, B, C, Q] = ["s", "m", "a", "e", "b", "c", "f"].map(sha);

interface Spec {
  tips: Record<string, string>;
  track?: string;
  prs?: Record<string, Record<string, unknown>[]>;
  /** `tip...head` → commits oldest first, and the files head changes. Between main's and staging's tips it defaults to none. */
  u?: Record<string, { commits: string[]; files?: string[]; total?: number }>;
  /** `sha...tip` → compare status. */
  anc?: Record<string, string>;
  fail?: (path: string) => boolean;
  /** Answers for paths outside acme/web, such as another repo's PR. */
  other?: (path: string) => Response | undefined;
}

/** GitHub as recorded responses: the repo, its branches, PRs, and compares by commit pair; anything else 404s. */
function fakeGitHub(spec: Spec) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push(path);
    if (spec.fail?.(path)) return new Response("rate limited", { status: 403 });
    const other = spec.other?.(path);
    if (other) return other;
    if (path === "/repos/acme/web") return Response.json({ default_branch: "main" });
    if (path.startsWith("/repos/acme/web/branches?")) {
      return Response.json(path.endsWith("page=1") ? Object.entries(spec.tips).map(([name, s]) => ({ name, commit: { sha: s } })) : []);
    }
    if (path === "/repos/acme/web/contents/.todo-plugins/plugins.yaml?ref=main") {
      return spec.track === undefined ? new Response("", { status: 404 }) : Response.json({ content: b64(spec.track) });
    }
    const closedInto = path.match(/\/pulls\?state=closed&base=([^&]+)&/);
    if (closedInto) {
      const base = decodeURIComponent(closedInto[1]);
      return Response.json(Object.entries(spec.prs ?? {}).flatMap(([ref, rows]) => rows
        .filter((p: any) => p.state === "closed" && p.base?.ref === base)
        .map((p: any) => ({ draft: false, html_url: "u", ...p, head: { ...p.head, ref } }))));
    }
    const pulls = path.match(/\/pulls\?head=acme%3A([^&]+)&/);
    if (pulls) return Response.json((spec.prs?.[decodeURIComponent(pulls[1])] ?? []).map((p) => ({ draft: false, html_url: "u", ...p })));
    const cmp = path.match(/\/compare\/(\w+)\.\.\.(\w+)(\?.*)?$/);
    if (cmp && cmp[3]) {
      const longLived = [spec.tips.main, spec.tips.staging];
      const hit = spec.u?.[`${n(cmp[1])}...${n(cmp[2])}`] ?? (longLived.includes(cmp[1]) && longLived.includes(cmp[2]) ? { commits: [] } : undefined);
      if (!hit) return new Response("", { status: 404 });
      return Response.json({ total_commits: hit.total ?? hit.commits.length, commits: hit.commits.map((s) => ({ sha: s })),
                             files: (hit.files ?? []).map((filename) => ({ filename })) });
    }
    if (cmp) {
      const status = spec.anc?.[`${n(cmp[1])}...${n(cmp[2])}`];
      return status ? Response.json({ status }) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }) as Fetch;
  return { impl, calls };
}

const TRACK = "track: [staging, main]\n";
const u = (tip: string, head: string, commits: string[], files: string[] = []) => ({ [`${n(tip)}...${n(head)}`]: { commits, files } });
const merged = (number: number, head: string, merge: string) => ({ number, state: "closed", merged_at: "t", head: { sha: head }, merge_commit_sha: merge, base: { ref: "staging" } });
const open = (number: number, head: string, base = "staging") => ({ number, state: "open", merged_at: null, head: { sha: head }, base: { ref: base } });

async function items(...rows: [string, string[], string?][]) {
  for (const [uid, branches, status] of rows) {
    await w.one("alice", item(uid, { id: uid.toLowerCase(), status: status ?? "in-progress", extra: { repo: "acme/web", branches } }));
  }
}
const stackedSpec = (extra: Partial<Spec> = {}): Spec => ({
  tips: { main: M, staging: S, "feat/a": A, "feat/b": B }, track: TRACK,
  u: { ...u(S, A, [A], ["a.txt"]), ...u(S, B, [A, B], ["a.txt", "b.txt"]) }, ...extra,
});
const facts = (uid: string) => storedFacts(w.d, "p", uid);

describe("trackList", () => {
  it("reads flow and block lists, indented or not, and nothing else", () => {
    expect(trackList("track: [staging, main]\n")).toEqual(["staging", "main"]);
    expect(trackList("plugins: {}\ntrack:\n  - staging\n  - 'main'\nother: 1\n")).toEqual(["staging", "main"]);
    expect(trackList("track:\n- staging\n- main\n")).toEqual(["staging", "main"]);
    expect(trackList("track: [staging,\n  main]\nplugins: {}\n")).toEqual(["staging", "main"]);
    expect(trackList("plugins: {}\n")).toEqual([]);
  });
});

describe("computeProject", () => {
  it("finds that a stacked branch needs the one it was cut from", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ id: "a", item: "A", branch: "feat/a", via: "feat/b", target: "staging", state: "waiting", source: "git", shared: 1 }]);
    expect(b.waits_on).toEqual(["a"]);
    expect((await facts("A")).needed_by).toMatchObject([{ id: "b", branch: "feat/b", via: "feat/a", state: "waiting" }]);
    expect((await facts("A")).needs).toEqual([]);
  });

  it("follows a PR based on another item's branch to that branch's target, and needs it", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: { "feat/b": [open(8, B, "feat/a")] } })).impl);
    const b = await facts("B");
    expect(b.branches).toMatchObject([{ name: "feat/b", target: "staging", chain: ["feat/a"] }]);
    expect(b.needs).toMatchObject([{ id: "a", state: "waiting" }]);
  });

  it("resolves a squash-merged dependency through its PR", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({
      prs: { "feat/a": [merged(7, A, Q)], "feat/b": [open(8, B)] },
      anc: { [`${n(Q)}...${n(S)}`]: "identical", [`${n(Q)}...${n(M)}`]: "diverged" },
    })).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "landed" }]);
    expect((await facts("B")).waits_on).toEqual([]);
    expect((await facts("A")).branches).toMatchObject([{ name: "feat/a", pr: { number: 7, state: "merged", merge_commit: Q }, landed: Q,
                                                         in: { staging: true, main: false } }]);
  });

  it("waits again on a branch reused after its PR merged", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub({
      tips: { main: M, staging: S, "feat/a": A2, "feat/b": B }, track: TRACK,
      prs: { "feat/a": [open(9, A2), merged(7, A, Q)], "feat/b": [open(8, B)] },
      u: { ...u(S, A2, [A, A2]), ...u(S, B, [A, A2, B]) },
      anc: { [`${n(A2)}...${n(A)}`]: "behind", [`${n(Q)}...${n(S)}`]: "identical" },
    }).impl);
    expect((await facts("A")).branches![0].prs!.map((p) => p.number)).toEqual([9, 7]);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "waiting" }]);
  });

  it("calls branches that each carry the other's unlanded commits ambiguous, blocking nothing", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub({
      tips: { main: M, staging: S, "feat/a": A2, "feat/b": B }, track: TRACK,
      u: { ...u(S, A2, [A, A2]), ...u(S, B, [A, B]) },
    }).impl);
    for (const [uid, other] of [["A", "b"], ["B", "a"]]) {
      const f = await facts(uid);
      expect(f.needs).toEqual([]);
      expect(f.shares).toMatchObject([{ id: other, shared: 1 }]);
      expect(f.waits_on).toEqual([]);
    }
  });

  it("doesn't deadlock branches cut from a staging that's ahead of main", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]], ["C", ["feat/c"]]);
    await computeProject(w.d, "p", fakeGitHub({
      tips: { main: M, staging: S, "feat/a": A, "feat/b": B, "feat/c": C }, track: TRACK,
      u: { ...u(S, A, [A]), ...u(S, B, [B]), ...u(S, C, [C]) },
    }).impl);
    for (const uid of ["A", "B", "C"]) expect(await facts(uid)).toMatchObject({ needs: [], shares: [], waits_on: [] });
  });

  it("keeps landed-in after the branch is deleted, without refetching its PRs", async () => {
    await items(["A", ["feat/a"]]);
    const pr = { number: 7, state: "merged", base: "staging", head: A, merge_commit: Q };
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ branches: [{ name: "feat/a", head: A, pr_head: A, pr, prs: [pr], target: "staging" }] })]);
    const gh = fakeGitHub({ tips: { main: M, staging: S }, track: TRACK, u: u(S, A, [A]),
                            anc: { [`${n(Q)}...${n(S)}`]: "ahead", [`${n(Q)}...${n(M)}`]: "behind" } });
    await computeProject(w.d, "p", gh.impl);
    expect((await facts("A")).branches).toMatchObject([{ name: "feat/a", head: A, gone: true, landed: Q, in: { staging: true, main: false } }]);
    expect(gh.calls.some((c) => c.includes("/pulls?head="))).toBe(false);
  });

  it("flags files both of two unrelated branches change as an overlap, and keeps the CLI's conflicts", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ conflicts: [{ id: "b", branch: "feat/b", via: "feat/a", files: ["x.ts"] }] })]);
    await computeProject(w.d, "p", fakeGitHub({
      tips: { main: M, staging: S, "feat/a": A, "feat/b": B }, track: TRACK,
      u: { ...u(S, A, [A], ["x.ts", "a.ts"]), ...u(S, B, [B], ["x.ts"]) },
    }).impl);
    const a = await facts("A");
    expect(a.needs).toEqual([]);
    expect(a.overlaps).toEqual([{ id: "b", item: "B", branch: "feat/b", via: "feat/a", files: ["x.ts"] }]);
    expect(a.conflicts).toEqual([{ id: "b", branch: "feat/b", via: "feat/a", files: ["x.ts"] }]);
  });

  it("marks an edge stale when the dependency is deferred", async () => {
    await items(["A", ["feat/a"], "deferred"], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "stale" }]);
  });

  it("turns dependency notes into edges", async () => {
    await items(["A", ["feat/a"]], ["B", []]);
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "item:A", in: "staging", because: "migrations" } }));
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/a": A }, track: TRACK, u: u(S, A, [A]),
                                                anc: { [`${n(A)}...${n(S)}`]: "diverged" } }).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "waiting", source: "plugin", evidence: "migrations" }]);
    expect((await facts("A")).needed_by).toMatchObject([{ id: "b" }]);
  });

  it("lands a dependency note on an item with no branches once that item is complete", async () => {
    await items(["X", [], "done"], ["Y", [], "cancelled"], ["B", ["feat/b"]]);
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "item:X" } }));
    await w.one("alice", child("note", "N2", "B", { kind: "dependency", text: "y", meta: { needs: "item:Y" } }));
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/b": B }, track: TRACK, u: u(S, B, [B]) }).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "x", state: "landed" }, { id: "y", state: "stale" }]);
  });

  it("leaves a branch whose target was deleted unknown", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, "feat/a": A, "feat/b": B }, track: TRACK,
                                                prs: { "feat/b": [open(8, B)] }, u: u(M, A, [A]) }).impl);
    const b = await facts("B");
    expect(b.branches).toMatchObject([{ name: "feat/b", target: "staging", in: { staging: null } }]);
    expect(b.branches![0].unknown).toContain("staging");
  });

  it("leaves a branch past the commit cap unknown", async () => {
    await items(["A", ["feat/a"]]);
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/a": A }, track: TRACK,
                                                u: { [`${n(S)}...${n(A)}`]: { commits: [A], total: 2001 } } }).impl);
    expect((await facts("A")).branches![0].unknown).toContain("2000");
  });

  it("keeps the stored edge, marked unknown, when GitHub errors", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    resetGitFactsCache();
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ fail: (p) => p.includes("/compare/") })).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ id: "a", state: "unknown" }]);
    expect(b.error).toContain("403");
    expect(b.waits_on).toEqual(["a"]);
  });

  it("does nothing for a push to a branch no item or track knows about, and refetches no PRs when only staging moves", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    const bot = fakeGitHub(stackedSpec({ tips: { main: M, staging: S, "feat/a": A, "feat/b": B, bot: C } }));
    await computeProject(w.d, "p", bot.impl);
    expect(bot.calls.filter((c) => !c.startsWith("/repos/acme/web/branches?") && c !== "/repos/acme/web")).toEqual([]);
    const moved = fakeGitHub({ tips: { main: M, staging: Q, "feat/a": A, "feat/b": B }, track: TRACK,
                               u: { ...u(Q, A, [A]), ...u(Q, B, [A, B]) } });
    await computeProject(w.d, "p", moved.impl);
    expect(moved.calls.filter((c) => c.includes("/pulls?"))).toEqual([
      "/repos/acme/web/pulls?state=closed&base=staging&sort=updated&direction=desc&per_page=100"]);
    expect(moved.calls.some((c) => c.includes(`/compare/${Q}...`))).toBe(true);
  });
});

describe("PR base chains and other edge cases", () => {
  const chainPrs = { "feat/a": [open(7, A)], "feat/b": [open(8, B, "feat/a")] };

  it("makes a PR based on a cancelled item's branch a stale edge", async () => {
    await items(["A", ["feat/a"], "cancelled"], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: chainPrs })).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ id: "a", branch: "feat/a", state: "stale", chain: true }]);
    expect(b.needs![0].evidence).toContain("cancelled");
    expect(b.waits_on).toEqual(["a"]);
  });

  it("makes a PR based on an archived item's branch a stale edge", async () => {
    await items(["A", ["feat/a"], "done"], ["B", ["feat/b"]]);
    await w.d.query("update items set extra = extra || '{\"archived\": true}'::jsonb where uid = 'A'");
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: chainPrs })).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "stale" }]);
    expect((await facts("B")).needs![0].evidence).toContain("archived");
  });

  it("makes a PR based on a branch no item tracks an unknown edge that blocks", async () => {
    await items(["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: chainPrs, u: u(A, B, [B]) })).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ needs: "branch:feat/a", state: "unknown", reason: "PR based on feat/a, which no item tracks" }]);
    expect(b.needs![0].evidence).toContain("retarget the PR");
    expect(b.branches![0].target).toBe("feat/a");
  });

  it("keeps a stacked PR's edge after its parent is rebased", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: chainPrs })).impl);
    resetGitFactsCache();
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/a": A2, "feat/b": B }, track: TRACK,
      prs: { "feat/a": [open(7, A2)], "feat/b": [open(8, B, "feat/a")] }, u: { ...u(S, A2, [A2]), ...u(S, B, [A, B]) } }).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "waiting", chain: true }]);
  });

  it("holds a dependent whose parent was rewritten while it still carries the old commits", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    resetGitFactsCache();
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/a": A2, "feat/b": B }, track: TRACK,
      u: { ...u(S, A2, [A2]), ...u(S, B, [A, B]) } }).impl);
    const [e] = (await facts("B")).needs!;
    expect(e).toMatchObject({ id: "a", state: "waiting" });
    expect(e.evidence).toContain("rewritten");
  });

  it("demotes a rewritten parent's edge to a hint once its current work lands, and keeps the hint", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    const rewrittenSpec = (status: string) => fakeGitHub({ tips: { main: M, staging: S, "feat/a": A2, "feat/b": B }, track: TRACK,
      u: { ...u(S, A2, [A2]), ...u(S, B, [A, B]) }, anc: { [`${n(A2)}...${n(S)}`]: status } });
    resetGitFactsCache();
    await computeProject(w.d, "p", rewrittenSpec("diverged").impl);
    expect((await facts("B")).waits_on).toEqual(["a"]);
    resetGitFactsCache();
    await computeProject(w.d, "p", rewrittenSpec("ahead").impl);
    for (let i = 0; i < 2; i++) {
      const b = await facts("B");
      expect(b.needs).toEqual([]);
      expect(b.waits_on).toEqual([]);
      expect(b.shares).toMatchObject([{ id: "a", rewritten: true }]);
      expect(b.shares![0].evidence).toContain("still carries its old commits");
      expect(b.shares![0].evidence).toContain("merge staging into feat/b");
      resetGitFactsCache();
      await computeProject(w.d, "p", rewrittenSpec("ahead").impl);
    }
  });

  it("clears the rewritten hint once the dependent merges the target in", async () => {
    const B2 = sha("7");
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec()).impl);
    const landed = (bHead: string, bCommits: string[], extra: Record<string, string> = {}) => fakeGitHub({
      tips: { main: M, staging: S, "feat/a": A2, "feat/b": bHead }, track: TRACK,
      u: { ...u(S, A2, [A2]), ...u(S, bHead, bCommits) }, anc: { [`${n(A2)}...${n(S)}`]: "ahead", ...extra } });
    resetGitFactsCache();
    await computeProject(w.d, "p", landed(B, [A, B]).impl);
    expect((await facts("B")).shares).toMatchObject([{ id: "a", rewritten: true }]);
    resetGitFactsCache();
    await computeProject(w.d, "p", landed(B2, [A, B, B2], { [`${n(A2)}...${n(B2)}`]: "ahead" }).impl);
    const b = await facts("B");
    expect(b.shares).toEqual([]);
    expect(b.needs).toEqual([]);
  });

  it("lands a chain dependency merged without a PR", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: { "feat/b": [open(8, B, "feat/a")] },
      u: { ...u(S, A, []), ...u(S, B, [B]) }, anc: { [`${n(A)}...${n(S)}`]: "ahead" } })).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "landed", chain: true }]);
  });

  it("lands a chain onto an archived dependency that already reached the target", async () => {
    await items(["A", ["feat/a"], "done"], ["B", ["feat/b"]]);
    await w.d.query("update items set extra = extra || '{\"archived\": true}'::jsonb where uid = 'A'");
    const pr = { number: 7, state: "merged", base: "staging", head: A, merge_commit: Q };
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ branches: [{ name: "feat/a", head: A, pr, prs: [pr], target: "staging" }] })]);
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ prs: { "feat/a": [merged(7, A, Q)], "feat/b": [open(8, B, "feat/a")] },
      u: u(S, B, [B]), anc: { [`${n(Q)}...${n(S)}`]: "identical" } })).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "landed" }]);
  });

  it("names the cycle when items wait on each other", async () => {
    const [A1, B1, B2, A3] = ["1", "2", "3", "4"].map(sha);
    await items(["A", ["a1", "a2"]], ["B", ["b1", "b2"]]);
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, a1: A1, b1: B1, b2: B2, a2: A3 }, track: TRACK,
      u: { ...u(S, A1, [A1]), ...u(S, B1, [A1, B1]), ...u(S, B2, [B2]), ...u(S, A3, [B2, A3]) } }).impl);
    const want = "a and b wait on each other through b2←a2 and a1←b1: merge them in one order, or split the items";
    for (const uid of ["A", "B"]) expect((await facts(uid)).needs!.map((e) => e.cycle)).toEqual([want]);
  });

  it("never lets an item that lists staging own it", async () => {
    await items(["R", ["staging"]], ["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub({ tips: { main: M, staging: S, "feat/a": A, "feat/b": B }, track: TRACK,
      prs: { staging: [open(1, S, "main")], "feat/a": [open(2, A)], "feat/b": [open(3, B)] },
      u: { ...u(S, A, [A]), ...u(S, B, [B]), ...u(M, S, [S]) } }).impl);
    for (const uid of ["A", "B"]) {
      const f = await facts(uid);
      expect(f.branches![0]).toMatchObject({ target: "staging" });
      expect(f.branches![0].chain).toBeUndefined();
      expect(f.waits_on).toEqual([]);
    }
  });

  it("skips the compare for a deleted branch its merged PR landed", async () => {
    await items(["A", ["feat/a"]]);
    const pr = { number: 7, state: "merged", base: "staging", head: A, merge_commit: Q };
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ branches: [{ name: "feat/a", head: A, pr_head: A, pr, prs: [pr], target: "staging" }] })]);
    const gh = fakeGitHub({ tips: { main: M, staging: S }, track: TRACK, anc: { [`${n(Q)}...${n(S)}`]: "ahead" } });
    await computeProject(w.d, "p", gh.impl);
    expect((await facts("A")).branches).toMatchObject([{ merged_gone: true, landed: Q }]);
    expect((await facts("A")).branches![0].unknown).toBeUndefined();
    expect(gh.calls.some((c) => c.includes(`/compare/${S}...`))).toBe(false);
  });

  it("recomputes when a branch a dependency note names moves", async () => {
    const X = sha("9"), X2 = sha("8");
    await items(["B", ["feat/b"]]);
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "branch:feat/x", in: "staging" } }));
    const spec = (x: string, status: string) => fakeGitHub({ tips: { main: M, staging: S, "feat/b": B, "feat/x": x }, track: TRACK,
      u: u(S, B, [B]), anc: { [`${n(x)}...${n(S)}`]: status } });
    await computeProject(w.d, "p", spec(X, "ahead").impl);
    await computeProject(w.d, "p", spec(X, "ahead").impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "landed" }]);
    await computeProject(w.d, "p", spec(X2, "diverged").impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "waiting" }]);
  });

  it("renders the page while GitHub hangs", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const hang = (() => new Promise(() => {})) as unknown as Fetch;
    const t = Date.now();
    expect((await itemGitFacts(w.d, "p", "B", hang)).hints).toBeDefined();
    expect(Date.now() - t).toBeLessThan(1000);
    resetGitFactsCache();
  });
});

describe("a PR based on a branch nothing tracks", () => {
  // Alpha's work is merged into staging, which main lacks; Beta was cut from staging after, with a PR based on it.
  const aheadSpec = (track?: string): Spec => ({
    tips: { main: M, staging: S, "feat/a": A, "feat/b": B }, track, prs: { "feat/b": [open(8, B)] },
    u: { ...u(M, A, [A]), ...u(S, A, []), ...u(M, B, [A, S, B]), ...u(S, B, [B]) },
  });

  it("without a track list, ends the chain at staging, adds no edge, leaves a hint, and lets it stage", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"], "qa-approved"]);
    await computeProject(w.d, "p", fakeGitHub(aheadSpec()).impl);
    const b = await facts("B");
    expect(b).toMatchObject({ needs: [], shares: [], waits_on: [] });
    expect((await facts("A")).needed_by).toEqual([]);
    expect(b.branches![0]).toMatchObject({ name: "feat/b", target: "staging" });
    expect(b.branches![0].orphan).toBeUndefined();
    expect(b.branches![0].hint).toBe("feat/b's PR is based on staging; if staging is long-lived, add it under track: in .todo-plugins/plugins.yaml");
    const [r] = await w.d.query("select versions from items where uid = 'B'");
    expect((await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: r.versions.status }))).status).toBe("applied");
  });

  it("with staging tracked, has no hint and no edge", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(aheadSpec(TRACK)).impl);
    const b = await facts("B");
    expect(b).toMatchObject({ needs: [], waits_on: [] });
    expect(b.branches![0].target).toBe("staging");
    expect(b.branches![0].hint).toBeUndefined();
  });

  it("with a track list that leaves the base out, keeps the edge blocking", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"], "qa-approved"]);
    await computeProject(w.d, "p", fakeGitHub(aheadSpec("track: [main]\n")).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ needs: "branch:staging", state: "unknown", reason: "PR based on staging, which no item tracks" }]);
    expect(b.branches![0].target).toBe("staging");
    expect(b.branches![0].hint).toBeUndefined();
    const [r] = await w.d.query("select versions from items where uid = 'B'");
    expect((await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: r.versions.status }))).rejected![0].reason).toBe("waits-on");
  });
});

describe("commits already on a long-lived branch", () => {
  // A hotfix (H, merged into main as M) staging lacks; feat/a and feat/b were cut from main after it, with PRs based on staging.
  const [H, F, D] = ["1", "2", "d"].map(sha);
  const hotfixSpec = (track?: string, extra: Partial<Spec> = {}): Spec => ({
    tips: { main: M, staging: S, "hotfix/x": H, "feat/a": A, "feat/b": B }, track,
    prs: { "feat/a": [open(7, A)], "feat/b": [open(8, B)] },
    u: { ...u(S, M, [H, M], ["hotfix.txt"]), ...u(S, H, [H], ["hotfix.txt"]), ...u(M, H, [], []),
         ...u(S, A, [H, M, A], ["a.txt", "hotfix.txt"]), ...u(M, A, [A], ["a.txt"]),
         ...u(S, B, [H, M, B], ["b.txt", "hotfix.txt"]), ...u(M, B, [B], ["b.txt"]) },
    ...extra,
  });
  const rowsOf = async (uid: string) => {
    const f = await facts(uid);
    return [...f.needs ?? [], ...f.needed_by ?? [], ...f.shares ?? [], ...f.overlaps ?? []];
  };

  for (const track of [undefined, TRACK]) {
    describe(track ? "with track: [staging, main]" : "without a track list", () => {
      it("never relates or overlaps branches cut from main after the hotfix", async () => {
        await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
        await computeProject(w.d, "p", fakeGitHub(hotfixSpec(track)).impl);
        for (const uid of ["A", "B"]) {
          expect(await rowsOf(uid)).toEqual([]);
          expect((await facts(uid)).waits_on).toEqual([]);
          expect((await facts(uid)).branches![0].target).toBe("staging");
        }
      });

      it("never makes them need an item on the hotfix branch", async () => {
        await items(["H", ["hotfix/x"]], ["A", ["feat/a"]]);
        await computeProject(w.d, "p", fakeGitHub(hotfixSpec(track, { prs: { "hotfix/x": [open(5, H)], "feat/a": [open(7, A)] } })).impl);
        expect(await rowsOf("H")).toEqual([]);
        expect(await rowsOf("A")).toEqual([]);
      });

      it("still finds branches that share a feature commit, counting only that commit", async () => {
        await items(["C", ["feat/c"]], ["D", ["feat/d"]]);
        await computeProject(w.d, "p", fakeGitHub(hotfixSpec(track, {
          tips: { main: M, staging: S, "feat/c": C, "feat/d": D },
          prs: { "feat/c": [open(9, C)], "feat/d": [open(10, D)] },
          u: { ...u(S, M, [H, M]), ...u(S, C, [H, M, F, C]), ...u(S, D, [H, M, F, D]) },
        })).impl);
        for (const [uid, other] of [["C", "d"], ["D", "c"]]) {
          const f = await facts(uid);
          expect(f.needs).toEqual([]);
          expect(f.shares).toMatchObject([{ id: other, shared: 1, commits: [F.slice(0, 7)] }]);
        }
      });
    });
  }

  it("drops the shares and edges stored through the hotfix", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const through = { branch: "feat/b", via: "feat/a", shared: 3, commits: [H, M, A].map((s) => s.slice(0, 7)) };
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ shares: [{ id: "b", item: "B", ...through, evidence: "x" }],
                        needs: [{ id: "b", item: "B", ...through, target: "staging", state: "waiting", source: "git", mb: n(H) }] })]);
    await computeProject(w.d, "p", fakeGitHub(hotfixSpec(TRACK, { anc: { [`${n(H)}...${n(S)}`]: "diverged" } })).impl);
    expect(await rowsOf("A")).toEqual([]);
    expect((await facts("A")).waits_on).toEqual([]);
  });

  it("leaves a branch unknown when main's commits staging lacks can't be listed", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(hotfixSpec(undefined, { u: { ...hotfixSpec().u, [`${n(S)}...${n(M)}`]: { commits: [M], total: 2001 } } })).impl);
    for (const uid of ["A", "B"]) {
      expect((await facts(uid)).branches![0].unknown).toContain("long-lived");
      expect(await rowsOf(uid)).toEqual([]);
    }
  });

  it("lists main's commits staging lacks once per compute, however many branches carry them", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const gh = fakeGitHub(hotfixSpec(TRACK));
    await computeProject(w.d, "p", gh.impl);
    expect(gh.calls.filter((c) => c.startsWith(`/repos/acme/web/compare/${S}...${M}?`))).toHaveLength(1);
  });
});

describe("a dependency note on a PR in another repo", () => {
  const DB_PR = "https://github.com/acme/db/pull/3";
  const D = sha("d");
  const dbPr = (state: "open" | "merged" | "closed") => Response.json({
    number: 3, state: state === "open" ? "open" : "closed", draft: false, merged_at: state === "merged" ? "t" : null,
    merge_commit_sha: state === "merged" ? D : null, base: { ref: "main" }, head: { sha: C }, html_url: DB_PR });
  const spec = (other: Spec["other"]): Spec => ({ tips: { main: M, staging: S, "feat/b": B }, track: TRACK, u: u(S, B, [B]), other });
  async function noted(meta: Record<string, unknown>) {
    await items(["B", ["feat/b"], "qa-approved"]);
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "migrations first", meta: { needs: DB_PR, ...meta } }));
  }
  const stage = async () => {
    const [r] = await w.d.query("select versions from items where uid = 'B'");
    return w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: r.versions.status }));
  };

  it("waits on an open PR, and the guard refuses", async () => {
    await noted({});
    await computeProject(w.d, "p", fakeGitHub(spec((p) => (p === "/repos/acme/db/pulls/3" ? dbPr("open") : undefined))).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ needs: DB_PR, note: "N1", state: "waiting", pr: { number: 3, state: "open" }, evidence: "migrations first" }]);
    expect(b.waits_on).toEqual([DB_PR]);
    expect((await stage()).rejected![0].reason).toBe("waits-on");
  });

  it("lands a merged PR without --in", async () => {
    await noted({});
    await computeProject(w.d, "p", fakeGitHub(spec((p) => (p === "/repos/acme/db/pulls/3" ? dbPr("merged") : undefined))).impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "landed" }]);
    expect((await stage()).status).toBe("applied");
  });

  it("lands a merged PR with --in staging only once its merge commit is in staging", async () => {
    await noted({ in: "staging" });
    const answer = (status: string) => (p: string) => p === "/repos/acme/db/pulls/3" ? dbPr("merged")
      : p === `/repos/acme/db/compare/${D}...staging` ? Response.json({ status }) : undefined;
    await computeProject(w.d, "p", fakeGitHub(spec(answer("diverged"))).impl);
    expect((await facts("B")).needs).toMatchObject([{ needs: DB_PR, target: "staging", state: "waiting" }]);
    resetGitFactsCache();
    await computeProject(w.d, "p", fakeGitHub(spec(answer("ahead"))).impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "landed" }]);
  });

  it("calls the edge unknown, and nothing else, when GitHub can't answer for the PR or its branch", async () => {
    await noted({ in: "staging" });
    await computeProject(w.d, "p", fakeGitHub(spec((p) => (p.startsWith("/repos/acme/db/") ? new Response("", { status: 403 }) : undefined))).impl);
    const b = await facts("B");
    expect(b.needs).toMatchObject([{ needs: DB_PR, state: "unknown", reason: "GitHub didn't answer for the PR" }]);
    expect(b.error).toBeUndefined();
    expect(b.branches).toMatchObject([{ name: "feat/b", target: "staging" }]);
    resetGitFactsCache();
    await computeProject(w.d, "p", fakeGitHub(spec((p) => (p === "/repos/acme/db/pulls/3" ? dbPr("merged") : undefined))).impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "unknown", reason: "couldn't check PR #3 against staging" }]);
  });

  it("reads no PR of an owner the server doesn't read", async () => {
    await noted({});
    await w.d.query("update notes set meta = jsonb_set(meta, '{needs}', '\"https://github.com/elsewhere/db/pull/3\"') where uid = 'N1'");
    const gh = fakeGitHub(spec(() => undefined));
    await computeProject(w.d, "p", gh.impl);
    expect((await facts("B")).needs).toMatchObject([{ state: "unknown", reason: expect.stringContaining("TODO_PLUGIN_OWNERS") }]);
    expect(gh.calls.some((c) => c.includes("elsewhere"))).toBe(false);
  });
});

describe("a tracked branch moving", () => {
  it("lists the PRs closed into it once, refetching only open PRs based elsewhere, so a squash merge that left the head alone is seen", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]], ["C", ["feat/c"]], ["D", ["feat/d"]]);
    const D = sha("d");
    const tips = { main: M, staging: S, "feat/a": A, "feat/b": B, "feat/c": C, "feat/d": D };
    await computeProject(w.d, "p", fakeGitHub(stackedSpec({ tips, prs: { "feat/a": [open(7, A)], "feat/b": [open(8, B)], "feat/c": [merged(6, C, C)],
                                                                         "feat/d": [open(9, D, "main")] },
                                                            u: { ...u(S, A, [A]), ...u(S, B, [A, B]), ...u(S, C, []), ...u(S, D, [D]) } })).impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "waiting" }]);
    const after = fakeGitHub({
      tips: { ...tips, staging: Q }, track: TRACK,
      prs: { "feat/a": [merged(7, A, Q)], "feat/b": [open(8, B)], "feat/c": [merged(6, C, C)], "feat/d": [open(9, D, "main")] },
      u: { ...u(Q, A, [A]), ...u(Q, B, [A, B]), ...u(Q, C, []), ...u(Q, D, [D]) },
    });
    await computeProject(w.d, "p", after.impl);
    expect((await facts("B")).needs).toMatchObject([{ id: "a", state: "landed" }]);
    expect((await facts("A")).branches![0].pr).toMatchObject({ number: 7, state: "merged" });
    const pulls = after.calls.filter((c) => c.includes("/pulls?"));
    expect(pulls.filter((c) => c.includes("state=closed"))).toEqual(["/repos/acme/web/pulls?state=closed&base=staging&sort=updated&direction=desc&per_page=100"]);
    expect(pulls.filter((c) => c.includes("head=")).map((c) => decodeURIComponent(c.split("head=acme%3A")[1].split("&")[0]))).toEqual(["feat/d"]);
  });
});

describe("itemGitFacts", () => {
  it("renders the stored row at once and recomputes after, one compute per project at a time", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const gh = fakeGitHub(stackedSpec());
    const first = await itemGitFacts(w.d, "p", "B", gh.impl);
    expect(first.needs).toBeUndefined();
    expect(first.hints.shares).toContain("can't tell which builds on which");
    await itemGitFacts(w.d, "p", "A", gh.impl);
    await recomputing("p");
    expect(gh.calls.filter((c) => c.startsWith("/repos/acme/web/branches?")).length).toBe(1);
    expect((await itemGitFacts(w.d, "p", "B", gh.impl)).waits_on).toEqual(["a"]);
    expect(recomputing("p")).toBeUndefined();
  });

  it("computes nothing without a token, showing the CLI's facts", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    await items(["A", ["feat/a"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', '{\"waits_on\": [\"z\"]}', 'alice')");
    const gh = fakeGitHub(stackedSpec());
    expect((await itemGitFacts(w.d, "p", "A", gh.impl)).waits_on).toEqual(["z"]);
    expect(recomputing("p")).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });
});

describe("the stage and deploy guard", () => {
  const stored = (uid: string, data: unknown) =>
    w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', $1, $2::jsonb, 'alice')", [uid, JSON.stringify(data)]);

  async function approved(uid: string) {
    await w.one("alice", item(uid, { status: "qa-approved" }));
    const [r] = await w.d.query("select versions from items where uid = $1", [uid]);
    return r.versions.status;
  }
  const stage = async (v: number, force = false) =>
    w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: v }, force ? { force: true } : {}));

  it("refuses ready-to-deploy and deployed while an edge waits", async () => {
    const v = await approved("B");
    await stored("B", { needs: [{ id: "a", branch: "feat/a", state: "waiting", source: "git" }], waits_on: ["a"] });
    expect((await stage(v)).rejected![0]).toMatchObject({ field: "status", reason: "waits-on" });
    const d = await w.one("alice", set("item", "B", "B", { status: "deployed" }, { status: v }));
    expect(d.rejected![0].reason).toBe("waits-on");
  });

  it("says what it saw and when, and rechecks, when it refuses a stage", async () => {
    const gh = fakeGitHub(stackedSpec());
    vi.stubGlobal("fetch", gh.impl);
    await items(["A", ["feat/a"]]);
    await w.one("alice", item("B", { id: "b", status: "qa-approved", extra: { repo: "acme/web", branches: ["feat/b"] } }));
    const v = (await w.d.query("select versions from items where uid = 'B'"))[0].versions.status;
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by, at) values ('p', 'B', $1::jsonb, 'server', '2026-10-23T23:05:09Z')",
      [JSON.stringify({ needs: [{ id: "a", branch: "feat/a", state: "waiting", source: "git" }], waits_on: ["a"] })]);
    const r = await stage(v);
    expect(r.rejected![0]).toMatchObject({ reason: "waits-on", edges: ["a (feat/a) waiting"], facts_at: "2026-10-23T23:05:09.000Z" });
    expect(describeResults([r]).message).toBe(
      "Not applied: the server still sees a (feat/a) waiting (facts from 2026-10-23 23:05); it's rechecking — retry in a minute, or use --force.");
    for (let i = 0; i < 50 && !gh.calls.length; i++) await new Promise((ok) => setTimeout(ok, 5));
    await recomputing("p");
    expect(gh.calls).toContain("/repos/acme/web/branches?per_page=100&page=1");
    vi.unstubAllGlobals();
  });

  it("refuses on an unknown edge and on an unknown branch of its own", async () => {
    const v = await approved("B");
    await stored("B", { needs: [{ id: "a", state: "unknown", source: "git", reason: "GitHub: 403" }] });
    expect((await stage(v)).rejected![0].reason).toBe("waits-on");
    await w.d.query("update git_facts set data = $1::jsonb where item_uid = 'B'",
      [JSON.stringify({ branches: [{ name: "feat/b", unknown: "its target staging isn't on the remote" }], needs: [] })]);
    expect((await stage(v)).rejected![0].reason).toBe("waits-on");
  });

  it("passes with force and records the history forced", async () => {
    const v = await approved("B");
    await stored("B", { needs: [{ id: "a", state: "stale", source: "git" }] });
    expect((await stage(v, true)).status).toBe("applied");
    const [h] = await w.d.query("select to_status, forced from status_history where item_uid = 'B' order by n desc limit 1");
    expect(h).toEqual({ to_status: "ready-to-deploy", forced: true });
  });

  it("passes unforced once every edge has landed", async () => {
    const v = await approved("B");
    await stored("B", { needs: [{ id: "a", state: "landed", source: "git" }] });
    const r = await stage(v);
    expect(r.status).toBe("applied");
    expect(r.rejected).toBeUndefined();
    const [h] = await w.d.query("select forced from status_history where item_uid = 'B' order by n desc limit 1");
    expect(h.forced).toBe(false);
  });

  it("counts a dependency note the facts haven't checked yet as unresolved", async () => {
    const v = await approved("B");
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "https://github.com/acme/db/pull/3" } }));
    expect((await stage(v)).rejected![0].reason).toBe("waits-on");
  });
});

describe("POST /api/projects/:key/git-facts", () => {
  const req = (token: string | null, body: unknown) => new Request("http://x/api/projects/p/git-facts", {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const params = (key: string) => ({ params: Promise.resolve({ key }) });
  const row = async () => (await w.d.query("select data, computed_by from git_facts where project = 'p' and item_uid = 'A'"))[0];
  const posted = { waits_on: ["b"], needs: [{ id: "b", state: "waiting", source: "git" }], conflicts: [{ id: "b", branch: "feat/b", via: "feat/a", files: ["x"] }] };

  it("without a token keeps the CLI's facts whole, and names the items it doesn't have", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    await items(["A", ["feat/a"]]);
    const r = await factsPOST(req(w.tokens.bob, { facts: [{ item_uid: "A", data: posted }, { item_uid: "nope", data: {} }] }), params("p"));
    expect(await r.json()).toEqual({ ok: true, stored: 1, skipped: ["nope"] });
    expect(await row()).toEqual({ data: posted, computed_by: "bob" });
  });

  it("with a token keeps only the CLI's conflicts beside the server's own facts", async () => {
    const gh = fakeGitHub({ tips: { main: M, staging: S, "feat/a": A }, track: TRACK, u: u(S, A, [A]) });
    vi.stubGlobal("fetch", gh.impl);
    await items(["A", ["feat/a"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'server')",
      [JSON.stringify({ needs: [], waits_on: [] })]);
    await factsPOST(req(w.tokens.bob, { facts: [{ item_uid: "A", data: posted }] }), params("p"));
    await recomputing("p");
    const r = await row();
    expect(r.computed_by).toBe("server");
    expect(r.data).toMatchObject({ conflicts: posted.conflicts, conflicts_by: "bob" });
    expect(r.data.waits_on ?? []).toEqual([]);
    expect(gh.calls.length).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it("400s facts of the wrong shape", async () => {
    await items(["A", ["feat/a"]]);
    for (const data of [{ waits_on: "b" }, { needs: [{ state: "maybe" }] }, { surprise: 1 }, []]) {
      expect((await factsPOST(req(w.tokens.bob, { facts: [{ item_uid: "A", data }] }), params("p"))).status).toBe(400);
    }
    expect(await row()).toBeUndefined();
  });

  it("401s without a token and 404s an unknown project", async () => {
    expect((await factsPOST(req(null, { facts: [] }), params("p"))).status).toBe(401);
    expect((await factsPOST(req(w.tokens.bob, { facts: [] }), params("nope"))).status).toBe(404);
  });
});

describe("repos a project may use", () => {
  it("reads nothing from GitHub for a repo the project hasn't got, and the rail says why", async () => {
    await w.d.query("delete from project_plugin_repos");
    await items(["A", ["feat/a"]]);
    const gh = fakeGitHub(stackedSpec());
    await computeProject(w.d, "p", gh.impl);
    expect(gh.calls).toEqual([]);
    const shown = await itemGitFacts(w.d, "p", "A", gh.impl);
    expect(shown.blocked).toMatch(/acme\/web isn't one of this project's repos.*Settings → Automation/);
    expect(gh.calls).toEqual([]);
  });

  it("uses a repo a member's CLI reported a checkout of", async () => {
    await w.d.query("delete from project_plugin_repos");
    await recordCheckout(w.d, "bob", "p", "/src/web", "git@github.com:Acme/web.git");
    await items(["A", ["feat/a"]]);
    const gh = fakeGitHub(stackedSpec());
    await computeProject(w.d, "p", gh.impl);
    expect(gh.calls.length).toBeGreaterThan(0);
    expect((await itemGitFacts(w.d, "p", "A", gh.impl)).blocked).toBeUndefined();
  });

  it("calls a repo field that isn't owner/name unusable", async () => {
    await w.one("alice", item("A", { id: "a", status: "in-progress", extra: { repo: "../../etc", branches: ["x"] } }));
    expect((await itemGitFacts(w.d, "p", "A")).blocked).toMatch(/isn't a GitHub owner\/name/);
  });
});
