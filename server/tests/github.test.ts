import { beforeEach, describe, expect, it, vi } from "vitest";
import { checksState, linkPrStatuses, parsePrUrl, prState, prStatus, resetPrCache, type Fetch } from "@/lib/github";

beforeEach(() => {
  resetPrCache();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "");
});

function fakeGitHub(pulls: Record<string, any>, runs: any[] | null = [], statuses: any[] = [], threads: boolean[] | null = []) {
  const calls: string[] = [];
  const impl = (async (url: any) => {
    const path = String(url).replace("https://api.github.com", "");
    calls.push(path);
    if (path === "/graphql") {
      if (!threads) return new Response("", { status: 502 });
      return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads.map((isResolved) => ({ isResolved })) } } } } });
    }
    const pr = path.match(/\/pulls\/(\d+)$/);
    if (pr) return pulls[pr[1]] ? Response.json(pulls[pr[1]]) : new Response("not found", { status: 404 });
    if (path.includes("/check-runs")) return runs ? Response.json({ check_runs: runs }) : new Response("", { status: 500 });
    if (path.endsWith("/status")) return Response.json({ statuses });
    return new Response("?", { status: 500 });
  }) as Fetch;
  return { impl, calls };
}

const open = { state: "open", draft: false, merged_at: null, head: { sha: "abc" } };

describe("parsePrUrl", () => {
  it("reads owner, repo and number from a PR URL, including sub-pages", () => {
    expect(parsePrUrl("https://github.com/acme/web-app/pull/42")).toEqual({ owner: "acme", repo: "web-app", number: 42 });
    expect(parsePrUrl("https://github.com/acme/web.app/pull/7/files#diff")).toEqual({ owner: "acme", repo: "web.app", number: 7 });
  });
  it("ignores everything that isn't a GitHub PR", () => {
    expect(parsePrUrl("https://github.com/acme/web/issues/42")).toBeNull();
    expect(parsePrUrl("https://gitlab.com/acme/web/pull/42")).toBeNull();
    expect(parsePrUrl("https://github.com/acme/web/pull/42x")).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
  });
});

describe("prState", () => {
  it("tells merged from closed, and draft from open", () => {
    expect(prState({ state: "closed", merged_at: "2026-10-01T00:00:00Z" })).toBe("merged");
    expect(prState({ state: "closed", merged_at: null })).toBe("closed");
    expect(prState({ state: "open", draft: true })).toBe("draft");
    expect(prState({ state: "open", draft: false })).toBe("open");
  });
});

describe("checksState", () => {
  const done = (conclusion: string) => ({ status: "completed", conclusion });
  it("fails on any failing run or status, before anything pending", () => {
    expect(checksState([done("success"), { status: "in_progress", conclusion: null }, done("timed_out")], [])).toBe("fail");
    expect(checksState([done("success")], [{ state: "error" }])).toBe("fail");
  });
  it("is pending while anything is unfinished", () => {
    expect(checksState([done("success"), { status: "queued", conclusion: null }], [])).toBe("pending");
    expect(checksState([], [{ state: "pending" }])).toBe("pending");
  });
  it("passes when everything finished cleanly, skips included", () => {
    expect(checksState([done("success"), done("skipped"), done("neutral")], [{ state: "success" }])).toBe("pass");
  });
  it("is null with no checks at all", () => {
    expect(checksState([], [])).toBeNull();
  });
});

describe("prStatus", () => {
  const ref = { owner: "acme", repo: "web", number: 1 };

  it("reads an open PR's checks from its head commit", async () => {
    const gh = fakeGitHub({ 1: open }, [{ status: "completed", conclusion: "failure" }]);
    expect(await prStatus(ref, gh.impl)).toEqual({ state: "open", checks: "fail", unresolved: null });
    expect(gh.calls).toEqual(["/repos/acme/web/pulls/1", "/repos/acme/web/commits/abc/check-runs?per_page=100", "/repos/acme/web/commits/abc/status"]);
  });

  it("skips checks once a PR is merged", async () => {
    const gh = fakeGitHub({ 1: { ...open, state: "closed", merged_at: "2026-10-01T00:00:00Z" } });
    expect(await prStatus(ref, gh.impl)).toEqual({ state: "merged", checks: null, unresolved: null });
    expect(gh.calls).toHaveLength(1);
  });

  it("answers repeat lookups from the cache", async () => {
    const gh = fakeGitHub({ 1: open });
    await prStatus(ref, gh.impl);
    await prStatus({ owner: "ACME", repo: "Web", number: 1 }, gh.impl);
    expect(gh.calls).toHaveLength(3);
  });

  it("keeps the PR state when its checks fail to load, and retries them soon", async () => {
    const gh = fakeGitHub({ 1: open }, null);
    expect(await prStatus(ref, gh.impl)).toEqual({ state: "open", checks: null, unresolved: null });
    vi.setSystemTime(Date.now() + 60_000);
    await prStatus(ref, gh.impl);
    vi.useRealTimers();
    expect(gh.calls.filter((c) => c.endsWith("/pulls/1"))).toHaveLength(2);
  });

  it("counts unresolved review threads when a token is set, merged PRs included", async () => {
    const gh = fakeGitHub({ 1: { ...open, state: "closed", merged_at: "2026-10-01T00:00:00Z" } }, [], [], [false, true, false]);
    expect(await prStatus(ref, gh.impl, "t")).toEqual({ state: "merged", checks: null, unresolved: 2 });
    expect(gh.calls).toEqual(["/repos/acme/web/pulls/1", "/graphql"]);
  });

  it("skips the review-thread lookup without a token", async () => {
    const gh = fakeGitHub({ 1: open });
    await prStatus(ref, gh.impl);
    expect(gh.calls).not.toContain("/graphql");
  });

  it("keeps state and checks when review threads fail to load, and retries soon", async () => {
    const gh = fakeGitHub({ 1: open }, [{ status: "completed", conclusion: "success" }], [], null);
    expect(await prStatus(ref, gh.impl, "t")).toEqual({ state: "open", checks: "pass", unresolved: null });
    vi.setSystemTime(Date.now() + 60_000);
    await prStatus(ref, gh.impl, "t");
    vi.useRealTimers();
    expect(gh.calls.filter((c) => c === "/graphql")).toHaveLength(2);
  });

  it("is null when GitHub refuses", async () => {
    expect(await prStatus({ ...ref, number: 9 }, fakeGitHub({}).impl)).toBeNull();
  });
});

describe("linkPrStatuses", () => {
  it("keys statuses by link uid, leaving out non-PR links and failed lookups", async () => {
    const gh = fakeGitHub({ 1: { ...open, draft: true } });
    const links = [
      { uid: "a", meta: { url: "https://github.com/acme/web/pull/1" } },
      { uid: "b", meta: { url: "https://example.com/preview" } },
      { uid: "c", meta: { url: "https://github.com/acme/web/pull/2" } },
    ];
    expect(await linkPrStatuses(links, gh.impl, () => null)).toEqual({ a: { state: "draft", checks: null, unresolved: null } });
  });
});
