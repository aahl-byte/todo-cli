import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as factsPOST } from "@/app/api/projects/[key]/git-facts/route";
import { computeProject, itemGitFacts, recomputing, resetGitFactsCache, storedFacts, trackList, type Fetch } from "@/lib/gitfacts";
import { child, item, set, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
  await w.d.exec("truncate git_facts");
  resetGitFactsCache();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "t");
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const sha = (c: string) => c.repeat(40).slice(0, 40);
const n = (s: string) => s.slice(0, 12);
const [S, M, A, A2, B, C, Q] = ["s", "m", "a", "e", "b", "c", "f"].map(sha);

interface Spec {
  tips: Record<string, string>;
  track?: string;
  prs?: Record<string, Record<string, unknown>[]>;
  /** `tip...head` → commits oldest first, and the files head changes. */
  u?: Record<string, { commits: string[]; files?: string[]; total?: number }>;
  /** `sha...tip` → compare status. */
  anc?: Record<string, string>;
  fail?: (path: string) => boolean;
}

/** GitHub as recorded responses: the repo, its branches, PRs, and compares by commit pair; anything else 404s. */
function fakeGitHub(spec: Spec) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push(path);
    if (spec.fail?.(path)) return new Response("rate limited", { status: 403 });
    if (path === "/repos/acme/web") return Response.json({ default_branch: "main" });
    if (path.startsWith("/repos/acme/web/branches?")) {
      return Response.json(path.endsWith("page=1") ? Object.entries(spec.tips).map(([name, s]) => ({ name, commit: { sha: s } })) : []);
    }
    if (path === "/repos/acme/web/contents/.todo-plugins/plugins.yaml?ref=main") {
      return spec.track === undefined ? new Response("", { status: 404 }) : Response.json({ content: b64(spec.track) });
    }
    const pulls = path.match(/\/pulls\?head=acme%3A([^&]+)&/);
    if (pulls) return Response.json((spec.prs?.[decodeURIComponent(pulls[1])] ?? []).map((p) => ({ draft: false, html_url: "u", ...p })));
    const cmp = path.match(/\/compare\/(\w+)\.\.\.(\w+)(\?.*)?$/);
    if (cmp && cmp[3]) {
      const hit = spec.u?.[`${n(cmp[1])}...${n(cmp[2])}`];
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
    expect(gh.calls.some((c) => c.includes("/pulls?"))).toBe(false);
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
    expect(moved.calls.some((c) => c.includes("/pulls?"))).toBe(false);
    expect(moved.calls.some((c) => c.includes(`/compare/${Q}...`))).toBe(true);
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
