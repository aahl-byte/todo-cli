import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as factsPOST } from "@/app/api/projects/[key]/git-facts/route";
import { computeProject, itemGitFacts, resetGitFactsCache, storedFacts, trackList, type Fetch } from "@/lib/gitfacts";
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
const sha = (c: string) => c.repeat(40);

/** Recorded GitHub responses by path; anything unrecorded is a 404. */
function fakeGitHub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push(path);
    return path in routes ? Response.json(routes[path]) : new Response("not found", { status: 404 });
  }) as Fetch;
  return { impl, calls };
}

const repo = (extra: Record<string, unknown> = {}) => ({
  "/repos/acme/web": { default_branch: "main" },
  "/repos/acme/web/contents/.todo-plugins/plugins.yaml?ref=main": { content: b64("track: [staging, main]\n"), encoding: "base64" },
  "/repos/acme/web/branches/staging": { commit: { sha: sha("s") } },
  "/repos/acme/web/branches/main": { commit: { sha: sha("m") } },
  ...extra,
});
const noPr = (b: string) => ({ [`/repos/acme/web/pulls?head=acme%3A${encodeURIComponent(b)}&state=all&per_page=20`]: [] });
const pr = (b: string, p: Record<string, unknown>) =>
  ({ [`/repos/acme/web/pulls?head=acme%3A${encodeURIComponent(b)}&state=all&per_page=20`]: [{ draft: false, html_url: "u", ...p }] });
const branch = (b: string, head: string) => ({ [`/repos/acme/web/branches/${b}`]: { commit: { sha: head } } });
const compare = (base: string, head: string, body: Record<string, unknown>) =>
  ({ [`/repos/acme/web/compare/${base}...${head}`]: { files: [], ...body } });

async function items(...rows: [string, string[], string?][]) {
  for (const [uid, branches, status] of rows) {
    await w.one("alice", item(uid, { id: uid.toLowerCase(), status: status ?? "in-progress", extra: { repo: "acme/web", branches } }));
  }
}

/** A on feat/a; B cut from it on feat/b. */
const stacked = (extra: Record<string, unknown> = {}) => repo({
  ...branch("feat/a", sha("a")), ...branch("feat/b", sha("b")), ...noPr("feat/a"), ...noPr("feat/b"),
  ...compare(sha("a"), sha("b"), { status: "ahead", merge_base_commit: { sha: sha("a") }, files: [{ filename: "b.txt" }] }),
  ...compare(sha("b"), sha("a"), { status: "behind", merge_base_commit: { sha: sha("a") } }),
  ...compare(sha("a"), sha("m"), { status: "diverged" }),
  ...compare(sha("m"), sha("a"), { status: "ahead", ahead_by: 1, commits: [{ sha: sha("a") }] }),
  ...extra,
});

describe("trackList", () => {
  it("reads flow and block lists, and nothing else", () => {
    expect(trackList("track: [staging, main]\n")).toEqual(["staging", "main"]);
    expect(trackList("plugins: {}\ntrack:\n  - staging\n  - 'main'\nother: 1\n")).toEqual(["staging", "main"]);
    expect(trackList("plugins: {}\n")).toEqual([]);
  });
});

describe("computeProject", () => {
  it("finds that a stacked branch depends on the one it was cut from", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const gh = fakeGitHub(stacked());
    await computeProject(w.d, "p", gh.impl);
    const b = await storedFacts(w.d, "p", "B");
    expect(b.needs).toMatchObject([{ id: "a", item: "A", branch: "feat/a", via: "feat/b", state: "waiting", source: "git", shared: 1 }]);
    expect(b.waits_on).toEqual(["a"]);
    const a = await storedFacts(w.d, "p", "A");
    expect(a.needed_by).toMatchObject([{ id: "b", branch: "feat/b", via: "feat/a", state: "waiting" }]);
    expect(a.needs).toEqual([]);
  });

  it("resolves a squash-merged dependency through landed-in", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const gh = fakeGitHub(stacked({
      ...pr("feat/a", { number: 7, state: "closed", merged_at: "t", merge_commit_sha: sha("q"), base: { ref: "staging" } }),
      ...pr("feat/b", { number: 8, state: "open", merged_at: null, base: { ref: "staging" } }),
      ...compare(sha("a"), sha("s"), { status: "diverged" }),
      ...compare(sha("s"), sha("a"), { status: "ahead", ahead_by: 1, commits: [{ sha: sha("a") }] }),
      ...compare(sha("q"), sha("s"), { status: "identical" }),
      ...compare(sha("q"), sha("m"), { status: "diverged" }),
      ...compare(sha("b"), sha("s"), { status: "diverged" }),
      ...compare(sha("b"), sha("m"), { status: "diverged" }),
    }));
    await computeProject(w.d, "p", gh.impl);
    const b = await storedFacts(w.d, "p", "B");
    expect(b.needs).toMatchObject([{ id: "a", state: "landed" }]);
    expect(b.waits_on).toEqual([]);
    const a = await storedFacts(w.d, "p", "A");
    expect(a.branches).toMatchObject([{ name: "feat/a", pr: { number: 7, state: "merged", base: "staging", merge_commit: sha("q") },
                                        in: { staging: true, main: false } }]);
  });

  it("keeps landed-in after the branch is deleted, from the last recorded facts", async () => {
    await items(["A", ["feat/a"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'alice')",
      [JSON.stringify({ branches: [{ name: "feat/a", head: sha("a"), target: "staging",
                                     pr: { number: 7, state: "merged", base: "staging", merge_commit: sha("q") } }] })]);
    const gh = fakeGitHub(repo({ ...compare(sha("q"), sha("s"), { status: "ahead" }), ...compare(sha("q"), sha("m"), { status: "behind" }) }));
    await computeProject(w.d, "p", gh.impl);
    const a = await storedFacts(w.d, "p", "A");
    expect(a.branches).toMatchObject([{ name: "feat/a", head: sha("a"), gone: true, landed: sha("q"), in: { staging: true, main: false } }]);
    expect(gh.calls.some((c) => c.includes("/pulls?"))).toBe(false);
  });

  it("flags files both branches change as an overlap, and keeps the CLI's conflicts", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', $1::jsonb, 'alice')",
      [JSON.stringify({ conflicts: [{ id: "B", branch: "feat/b", via: "feat/a", files: ["x.ts"] }] })]);
    const gh = fakeGitHub(repo({
      ...branch("feat/a", sha("a")), ...branch("feat/b", sha("b")), ...noPr("feat/a"), ...noPr("feat/b"),
      ...compare(sha("a"), sha("b"), { status: "diverged", merge_base_commit: { sha: sha("s") }, files: [{ filename: "x.ts" }, { filename: "b.ts" }] }),
      ...compare(sha("b"), sha("a"), { status: "diverged", merge_base_commit: { sha: sha("s") }, files: [{ filename: "x.ts" }] }),
      ...compare(sha("s"), sha("m"), { status: "ahead" }),
    }));
    await computeProject(w.d, "p", gh.impl);
    const a = await storedFacts(w.d, "p", "A");
    expect(a.needs).toEqual([]);
    expect(a.overlaps).toEqual([{ id: "b", item: "B", branch: "feat/b", via: "feat/a", files: ["x.ts"] }]);
    expect(a.conflicts).toEqual([{ id: "B", branch: "feat/b", via: "feat/a", files: ["x.ts"] }]);
  });

  it("marks an edge stale when the dependency is deferred", async () => {
    await items(["A", ["feat/a"], "deferred"], ["B", ["feat/b"]]);
    await computeProject(w.d, "p", fakeGitHub(stacked()).impl);
    expect((await storedFacts(w.d, "p", "B")).needs).toMatchObject([{ id: "a", state: "stale" }]);
  });

  it("turns dependency notes into edges", async () => {
    await items(["A", ["feat/a"]], ["B", []]);
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "item:A", in: "staging", because: "migrations" } }));
    const gh = fakeGitHub(repo({ ...branch("feat/a", sha("a")), ...noPr("feat/a"), ...compare(sha("a"), sha("s"), { status: "diverged" }) }));
    await computeProject(w.d, "p", gh.impl);
    expect((await storedFacts(w.d, "p", "B")).needs).toMatchObject([{ id: "a", state: "waiting", source: "plugin", evidence: "migrations" }]);
    expect((await storedFacts(w.d, "p", "A")).needed_by).toMatchObject([{ id: "b" }]);
  });

  it("computes nothing without a token, leaving the CLI's facts", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    await items(["A", ["feat/a"]]);
    await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', 'A', '{\"waits_on\": [\"Z\"]}', 'alice')");
    const gh = fakeGitHub(repo());
    expect((await itemGitFacts(w.d, "p", "A", gh.impl)).waits_on).toEqual(["Z"]);
    expect(gh.calls).toEqual([]);
  });

  it("caches a project's computation briefly", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    const gh = fakeGitHub(stacked());
    await itemGitFacts(w.d, "p", "B", gh.impl);
    const n = gh.calls.length;
    expect((await itemGitFacts(w.d, "p", "B", gh.impl)).waits_on).toEqual(["a"]);
    expect(gh.calls.length).toBe(n);
  });
});

describe("the stage and deploy guard", () => {
  const facts = (uid: string, data: unknown) =>
    w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', $1, $2::jsonb, 'alice')", [uid, JSON.stringify(data)]);

  async function approved(uid: string) {
    await w.one("alice", item(uid, { status: "qa-approved" }));
    const [r] = await w.d.query("select versions from items where uid = $1", [uid]);
    return r.versions.status;
  }

  it("refuses ready-to-deploy and deployed while an edge waits", async () => {
    const v = await approved("B");
    await facts("B", { needs: [{ id: "A", branch: "feat/a", state: "waiting", source: "git" }], waits_on: ["A"] });
    const r = await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: v }));
    expect(r.rejected![0]).toMatchObject({ field: "status", reason: "waits-on" });
    const d = await w.one("alice", set("item", "B", "B", { status: "deployed" }, { status: v }));
    expect(d.rejected![0].reason).toBe("waits-on");
  });

  it("passes with force and records the history forced", async () => {
    const v = await approved("B");
    await facts("B", { needs: [{ id: "A", state: "stale", source: "git" }] });
    const r = await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: v }, { force: true }));
    expect(r.status).toBe("applied");
    const [h] = await w.d.query("select to_status, forced from status_history where item_uid = 'B' order by n desc limit 1");
    expect(h).toEqual({ to_status: "ready-to-deploy", forced: true });
  });

  it("passes once every edge has landed, unforced", async () => {
    const v = await approved("B");
    await facts("B", { needs: [{ id: "A", state: "landed", source: "git" }] });
    const r = await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: v }, { force: true }));
    expect(r.status).toBe("applied");
    const [h] = await w.d.query("select forced from status_history where item_uid = 'B' order by n desc limit 1");
    expect(h.forced).toBe(false);
  });

  it("counts a dependency note the facts haven't checked yet as waiting", async () => {
    const v = await approved("B");
    await w.one("alice", child("note", "N1", "B", { kind: "dependency", text: "x", meta: { needs: "https://github.com/acme/db/pull/3" } }));
    const r = await w.one("alice", set("item", "B", "B", { status: "ready-to-deploy" }, { status: v }));
    expect(r.rejected![0].reason).toBe("waits-on");
  });
});

describe("POST /api/projects/:key/git-facts", () => {
  const req = (token: string | null, body: unknown) => new Request("http://x/api/projects/p/git-facts", {
    method: "POST", headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const params = (key: string) => ({ params: Promise.resolve({ key }) });

  it("stores the CLI's facts for the project's items, and skips unknown ones", async () => {
    await items(["A", ["feat/a"]]);
    const r = await factsPOST(req(w.tokens.bob, { facts: [{ item_uid: "A", data: { waits_on: ["B"] } }, { item_uid: "nope", data: {} }] }), params("p"));
    expect(await r.json()).toEqual({ ok: true, stored: 1 });
    const [row] = await w.d.query("select data, computed_by from git_facts where project = 'p' and item_uid = 'A'");
    expect(row).toEqual({ data: { waits_on: ["B"] }, computed_by: "bob" });
  });

  it("401s without a token and 404s an unknown project", async () => {
    expect((await factsPOST(req(null, { facts: [] }), params("p"))).status).toBe(401);
    expect((await factsPOST(req(w.tokens.bob, { facts: [] }), params("nope"))).status).toBe(404);
  });
});

describe("two branches that each carry the other's commits", () => {
  it("keeps only the edge from the branch cut later, by first-seen heads", async () => {
    await items(["A", ["feat/a"]], ["B", ["feat/b"]]);
    for (const [uid, name, first] of [["A", "feat/a", sha("a")], ["B", "feat/b", sha("b")]]) {
      await w.d.query("insert into git_facts (project, item_uid, data, computed_by) values ('p', $1, $2::jsonb, 'alice')",
        [uid, JSON.stringify({ branches: [{ name, head: first, first, target: "main" }] })]);
    }
    const gh = fakeGitHub(repo({
      ...branch("feat/a", sha("c")), ...branch("feat/b", sha("b")), ...noPr("feat/a"), ...noPr("feat/b"),
      ...compare(sha("c"), sha("b"), { status: "diverged", merge_base_commit: { sha: sha("a") } }),
      ...compare(sha("b"), sha("c"), { status: "diverged", merge_base_commit: { sha: sha("a") } }),
      ...compare(sha("a"), sha("m"), { status: "diverged" }),
      ...compare(sha("m"), sha("a"), { status: "ahead", ahead_by: 1, commits: [{ sha: sha("a") }] }),
      ...compare(sha("b"), sha("a"), { status: "diverged" }),
      ...compare(sha("a"), sha("b"), { status: "ahead" }),
    }));
    await computeProject(w.d, "p", gh.impl);
    expect((await storedFacts(w.d, "p", "B")).needs).toMatchObject([{ id: "a" }]);
    expect((await storedFacts(w.d, "p", "A")).needs).toEqual([]);
  });
});
