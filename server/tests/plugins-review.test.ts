// The server runner's safety and delivery rules: which repos and connections it
// will use, what it keeps secret, and how it delivers each event exactly once.
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as pluginsGET, PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { POST as credentialsPOST } from "@/app/api/projects/[key]/plugins/credentials/route";
import { GET as reposGET, PUT as reposPUT } from "@/app/api/projects/[key]/plugins/repos/route";
import { POST as webhookPOST } from "@/app/api/github/webhook/route";
import { OWNERS_UNSET, recordCheckout, repoKey } from "@/lib/checkouts";
import { migrate } from "@/lib/db";
import { listDocs } from "@/lib/docs";
import { itemGitFacts, resetGitFactsCache, type Fetch } from "@/lib/gitfacts";
import { queuePluginEvent } from "@/lib/plugins/queue";
import { flushPluginRuns, itemsOnBranch, LEASE_MS, pluginTick, pluginUid, requestKey } from "@/lib/plugins/server";
import { SHIPPED } from "@/lib/plugins/shipped";
import { child, item, world, type World } from "./helpers";
import { API, fakeGitHub, params, PR, publicDns, req, type Spec } from "./plugin-github";

let w: World;
let files: string;
beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_SECRET_KEY", "");
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", "");
  vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "");
  resetGitFactsCache();
  files = mkdtempSync(path.join(tmpdir(), "plugins-"));
  process.env.TODO_FILES_DIR = files;
  delete process.env.S3_BUCKET;
  delete process.env.VERCEL;
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
});
afterEach(() => {
  rmSync(files, { recursive: true, force: true });
  delete process.env.TODO_FILES_DIR;
});

const host = { sleep: async () => {}, guard: { allow: [] as string[], lookup: publicDns } };
const run = (f: Fetch, limit = 50) => flushPluginRuns(w.d, { fetch: f, host }, limit);
const tick = (f: Fetch) => pluginTick(w.d, { fetch: f, host });
const events = () => w.d.query("select * from plugin_events order by id");
const runs = () => w.d.query("select * from plugin_runs order by id");
const links = () => w.d.query("select uid, text from notes where project = 'p' and item_uid = 'I1' and kind = 'link' order by n");
const setItem = (data: Record<string, unknown>) =>
  w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1", data });
const push = (branch: string) => queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch }, "alice");
async function onBranch(branches: string[], data: Record<string, unknown> = {}, repo = "acme/web") {
  await w.one("alice", item("I1", { status: "in-progress", extra: { repo, branches }, ...data }));
}
/** A repo file with one plugin per name, each attaching a log line from a value step. */
const logPlugins = (...names: string[]) => ["plugins:", ...names.flatMap((n) => [
  `  ${n}:`, "    on: [push]", "    steps: [{name: v, value: '`1`'}]", `    attach: [{log: '${n} ran'}]`])].join("\n");

describe("repos a project may use", () => {
  it("queues nothing and calls nothing for an item naming another repo", async () => {
    const evil = ["plugins:", "  x:", "    connections: [github]", "    on: [push]",
      "    steps: [{name: s, http: {method: GET, path: /repos/acme/private/contents/.env}}, {http: {method: DELETE, path: /repos/acme/web}}]",
      "    attach: [{log: 'leak {{s.path}}'}]"].join("\n");
    const gh = fakeGitHub({ file: evil });
    vi.stubGlobal("fetch", gh.impl);
    await w.one("bob", item("I1", { status: "in-progress", extra: { repo: "mallory/public", branches: ["main"] } }));
    expect(await queuePluginEvent(w.d, "p", "I1", "mallory/public", { type: "push", branch: "main" }, "bob")).toBeNull();
    expect(await events()).toEqual([]);
    await run(gh.impl);
    expect(gh.sent).toEqual([]);
    const r = await pluginsGET(req("/api/projects/p/plugins?repo=mallory/public", "GET", w.tokens.bob), params("p"));
    expect(r.status).toBe(404);
    expect((await pluginsGET(req("/api/projects/p/plugins?repo=not%20a%20repo", "GET", w.tokens.bob), params("p"))).status).toBe(400);
    expect(gh.sent).toEqual([]);
  });

  it("refuses GITHUB_TOKEN to a repo plugin in an allowed repo, so nothing it asks for is sent", async () => {
    const evil = ["plugins:", "  x:", "    connections: [github]", "    on: [push]",
      "    steps: [{http: {method: DELETE, path: /repos/acme/web}}]", "    attach: []"].join("\n");
    const gh = fakeGitHub({ file: evil, prs: { main: [] } });
    await onBranch(["main"]);
    await run(gh.impl);
    expect(gh.sent.filter((s) => s.method !== "GET")).toEqual([]);
    expect((await runs()).find((r) => r.plugin === "x")!.result.skipped).toMatch(/declare a repo connection/);
  });

  it("allows a repo a member's CLI has a checkout of, and one listed through the API", async () => {
    await w.d.query("delete from project_plugin_repos");
    await recordCheckout(w.d, "bob", "p", "/src/api", "git@github.com:acme/api.git");
    const put = await reposPUT(new Request("http://x/api/projects/p/plugins/repos", {
      method: "PUT", headers: { authorization: `Bearer ${w.tokens.alice}` }, body: JSON.stringify({ repos: ["Acme/Web"] }) }), params("p"));
    expect(await put.json()).toMatchObject({ ok: true, repos: [{ repo: "acme/web", added_by: "alice" }], checkouts: ["acme/api"] });
    const bad = await reposPUT(new Request("http://x/api/projects/p/plugins/repos", {
      method: "PUT", headers: { authorization: `Bearer ${w.tokens.alice}` }, body: JSON.stringify({ repos: ["not a repo"] }) }), params("p"));
    expect(bad.status).toBe(400);
    const listed = await (await reposGET(req("/api/projects/p/plugins/repos", "GET", w.tokens.bob), params("p"))).json();
    expect(listed.repos.map((r: { repo: string }) => r.repo)).toEqual(["acme/web"]);
    await onBranch(["feat/x"]);
    expect((await events()).length).toBe(1);
  });
});

describe("the private-address guard", () => {
  it("keeps repo connections off loopback and the metadata address, and off a private github the repo redefines", async () => {
    const file = ["connections:", "  pg: {http: {url: 'http://127.0.0.1:5432'}}", "  meta: {http: {url: 'http://169.254.169.254'}}",
      "  github: {http: {url: 'http://10.0.0.5'}}",
      "plugins:", "  y:", "    connections: [pg, meta]", "    on: [push]",
      "    steps:", "      - {connection: pg, http: {method: GET, path: /}}", "      - {connection: meta, http: {method: GET, path: /latest/meta-data/}}",
      "    attach: []"].join("\n");
    const gh = fakeGitHub({ file });
    await onBranch(["main"]);
    await push("main");
    await run(gh.impl);
    expect(gh.sent.filter((s) => !s.url.startsWith(API)).map((s) => s.url)).toEqual([]);
    for (const r of await runs()) expect(r.result.error ?? r.result.skipped).toMatch(/isn't an address this host connects to/);
  });

  const localPlugin = ["connections:", "  wt: {http: {url: 'http://127.0.0.1:8710'}}",
    "plugins:", "  y:", "    connections: [wt]", "    on: [push]", "    steps: [{http: {method: GET, path: /}}]", "    attach: []"].join("\n");
  async function reachesLocal(allow: string): Promise<boolean> {
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", allow);
    const gh = fakeGitHub({ file: localPlugin, other: (url) => (url.startsWith("http://127.0.0.1:8710") ? Response.json({}) : undefined) });
    await push("main");
    await flushPluginRuns(w.d, { fetch: gh.impl, host: { sleep: async () => {} } }, 50);
    return gh.sent.some((s) => s.url === "http://127.0.0.1:8710/");
  }

  it("lets a private host through for a repo's connections once TODO_PLUGIN_ALLOW_HOSTS names it for that repo", async () => {
    await onBranch([]);
    expect(await reachesLocal("leaf-rain:10011, acme/web=127.0.0.1:8710")).toBe(true);
  });

  it("keeps a private host listed for another repo, or listed host-wide, from this repo's connections", async () => {
    await onBranch([]);
    expect(await reachesLocal("acme/api=127.0.0.1:8710")).toBe(false);
    expect(await reachesLocal("127.0.0.1:8710")).toBe(false);
    expect((await runs()).filter((r) => r.plugin === "y").every((r) => /isn't an address/.test(r.result.error))).toBe(true);
  });
});

describe("deletions", () => {
  it("lets a plugin bring back a link a plugin run removed, but not one a person removed", async () => {
    const gh = fakeGitHub({ prs: { a: [PR(1)], b: [PR(2)] } });
    await onBranch(["a", "b"]);
    await run(gh.impl);
    expect((await links()).length).toBe(2);
    await setItem({ "extra.branches": ["b"] });
    await push("b");
    await run(gh.impl);
    expect((await links()).map((n) => n.text)).toEqual(["#2 · PR 2"]);
    const [tomb] = await w.d.query("select by, by_plugin from tombstones");
    expect(tomb).toEqual({ by: "plugin", by_plugin: true });

    await setItem({ "extra.branches": ["b", "a"] });
    await run(gh.impl);
    expect((await links()).map((n) => n.text).sort()).toEqual(["#1 · PR 1", "#2 · PR 2"]);

    const one = pluginUid("pr-link/default", "I1", "link:https://github.com/acme/web/pull/1");
    await w.one({ handle: "alice", unconditional: true }, { op: "remove", entity: "note", uid: one, item_uid: "I1" });
    await push("a");
    await run(gh.impl);
    expect((await links()).map((n) => n.text)).toEqual(["#2 · PR 2"]);
    expect((await runs()).at(-1)!.result.log.join(" ")).toMatch(/removed from the item by a person/);
  });

  it("lets a CLI's plugin note come back after a plugin removal, and answers removed after a person's", async () => {
    await onBranch([]);
    const note = (uid: string) => child("note", uid, "I1", { kind: "link", text: "x", meta: { url: `https://x/${uid}`, type: "pr", plugin: "pr-link/default" } });
    await w.one("bob", note("N1"));
    const remove = (extra = {}) => w.one({ handle: "bob", unconditional: true }, { op: "remove", entity: "note", uid: "N1", item_uid: "I1", ...extra });
    expect((await remove({ plugin: true })).status).toBe("applied");
    expect((await w.one("bob", note("N1"))).status).toBe("applied");
    expect((await remove()).status).toBe("applied");
    expect(await w.one("bob", note("N1"))).toMatchObject({ status: "rejected", reason: "removed" });
  });
});

describe("webhooks", () => {
  const SECRET = "s";
  const hook = (kind: string, payload: unknown, id: string = crypto.randomUUID(), body = JSON.stringify(payload)) => webhookPOST(new Request("http://x/api/github/webhook", {
    method: "POST", body, headers: { "x-github-event": kind, "x-github-delivery": id,
                                     "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}` } }));
  const repository = { full_name: "acme/web", default_branch: "main" };
  beforeEach(async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    vi.stubGlobal("fetch", fakeGitHub({}).impl);
    await onBranch(["feat/x"]);
    await w.d.query("delete from plugin_events");
  });
  const settle = () => vi.waitFor(async () => expect((await events()).every((e) => e.done_at)).toBe(true));

  it("drops a replayed delivery", async () => {
    const payload = { action: "opened", repository, pull_request: { head: { ref: "feat/x" } } };
    for (let i = 0; i < 3; i++) await hook("pull_request", payload, "same-id");
    expect((await events()).length).toBe(1);
    expect((await w.d.query("select id from github_deliveries order by id")).map((r) => r.id.split(":")[0])).toEqual(["body", "id"]);
    await settle();
  });

  it("runs pull_request only for actions that change what's linked, and counts the events it queued", async () => {
    const pr = (action: string, extra = {}) => hook("pull_request", { action, repository, pull_request: { head: { ref: "feat/x" } }, ...extra });
    for (const a of ["labeled", "synchronize", "assigned", "edited"]) expect(await (await pr(a)).json()).toMatchObject({ queued: 0 });
    expect(await (await pr("edited", { changes: { base: { ref: { from: "main" } } } })).json()).toMatchObject({ queued: 1 });
    expect(await (await pr("closed")).json()).toMatchObject({ queued: 1, projects: ["p"] });
    await settle();
  });

  it("runs deployment_status on success, failure and error only", async () => {
    for (const state of ["pending", "in_progress", "queued", "inactive", "success", "failure", "error"]) {
      await hook("deployment_status", { repository, deployment: { ref: "feat/x" }, deployment_status: { state } });
    }
    expect((await events()).length).toBe(3);
    await settle();
  });

  it("runs nothing for a deleted branch, and only a push counts as a webhook for polling", async () => {
    await hook("ping", { zen: "hi", repository });
    await hook("pull_request", { action: "opened", repository, pull_request: { head: { ref: "feat/x" } } });
    expect(await w.d.query("select * from repo_polls")).toEqual([]);
    await settle();
    const before = (await events()).length;
    await hook("push", { ref: "refs/heads/feat/x", deleted: true, after: "0000", repository });
    expect((await events()).length).toBe(before);
    expect((await w.d.query("select hook_at from repo_polls"))[0].hook_at).not.toBeNull();
  });

  it("refuses a body over 5 MB before checking it", async () => {
    const big = "x".repeat(5 * 1024 * 1024 + 1);
    const r = await webhookPOST(new Request("http://x/api/github/webhook", { method: "POST", body: big, headers: { "x-github-event": "push" } }));
    expect(r.status).toBe(413);
  });
});

describe("finished items", () => {
  it("get no push, pr or every: runs, while a status move still fires", async () => {
    const gh = fakeGitHub({ prs: { "feat/x": [] } });
    await onBranch(["feat/x"], { status: "done" });
    expect(await events()).toEqual([]);
    expect(await push("feat/x")).toBeNull();
    await setItem({ status: "in-progress" });
    await setItem({ status: "deployed" });
    expect((await events()).map((e) => e.event.type)).toEqual(["status", "status"]);
    await w.d.query("delete from plugin_events");
    await setItem({ "extra.archived": true });
    expect(await tick(gh.impl)).toMatchObject({ polled: 0, refreshes: 0 });
  });
});

describe("delivery", () => {
  it("takes at most N events per flush and leaves the rest", async () => {
    const gh = fakeGitHub({ prs: {} });
    await onBranch([]);
    for (const b of ["a", "b", "c", "d", "e", "f", "g"]) await push(b);
    expect(await flushPluginRuns(w.d, { fetch: gh.impl, host })).toMatchObject({ ran: 5 });
    expect((await events()).filter((e) => !e.done_at).length).toBe(3);
  });

  it("never claims an event another delivery holds, and on redelivery skips the instances already finished", async () => {
    const gh = fakeGitHub({ file: logPlugins("a", "b") });
    await onBranch([]);
    await w.d.query("delete from plugin_events");
    const id = await push("main");
    await w.d.query("update plugin_events set claimed_at = now(), lease = 'other', attempts = 1 where id = $1", [id]);
    expect(await run(gh.impl)).toEqual({ ran: 0, failed: 0 });

    await w.d.query("update plugin_events set claimed_at = now() - make_interval(secs => $2), finished = '{a/default}' where id = $1",
      [id, LEASE_MS / 1000 + 1]);
    expect(await run(gh.impl)).toEqual({ ran: 1, failed: 0 });
    expect((await runs()).map((r) => r.plugin).filter((p) => p !== "pr-link")).toEqual(["b"]);
    expect((await events())[0].finished).toEqual(["a/default", "pr-link/default", "b/default"]);
  });

  it("applies nothing once another delivery has taken the event over", async () => {
    let first = true;
    const file = ["plugins:", "  slow:", "    connections: [hooks]", "    on: [push]", "    steps: [{name: r, http: {method: GET, path: /}}]",
      "    attach: [{link: {type: pr, url: 'https://x/1'}}]", "connections:", "  hooks: {http: {url: 'https://hooks.example'}}"].join("\n");
    const gh = fakeGitHub({ file, other: async (url) => {
      if (!url.startsWith("https://hooks.example")) return undefined;
      if (first) await w.d.query("update plugin_events set lease = 'someone-else'");
      first = false;
      return Response.json({});
    } });
    await onBranch([]);
    await w.d.query("delete from plugin_events");
    await push("main");
    await run(gh.impl);
    expect(await links()).toEqual([]);
    expect((await runs()).filter((r) => r.plugin === "slow")).toEqual([]);
  });

  it("retries a read-only instance that failed transiently, and only that one", async () => {
    let down = true;
    const file = ["connections:", "  hooks: {http: {url: 'https://hooks.example'}}", "plugins:",
      "  flaky:", "    connections: [hooks]", "    on: [push]", "    steps: [{http: {method: GET, path: /}}]", "    attach: [{log: flaky ran}]",
      "  steady:", "    on: [push]", "    steps: [{name: v, value: '`1`'}]", "    attach: [{log: steady ran}]"].join("\n");
    const gh = fakeGitHub({ file, other: (url) => (url.startsWith("https://hooks.example") ? (down ? new Response("", { status: 503 }) : Response.json({})) : undefined) });
    await onBranch([]);
    await w.d.query("delete from plugin_events");
    await push("main");
    expect(await run(gh.impl)).toEqual({ ran: 0, failed: 1 });
    const [e] = await events();
    expect(e.done_at).toBeNull();
    expect(e.finished).toEqual(["pr-link/default", "steady/default"]);
    down = false;
    await w.d.query("update plugin_events set next_attempt_at = now()");
    expect(await run(gh.impl)).toEqual({ ran: 1, failed: 0 });
    expect((await w.d.query("select text from logs order by n")).map((r) => r.text)).toEqual(["steady ran", "flaky ran"]);
  });

  it("doesn't retry a run that wrote before failing", async () => {
    const file = ["connections:", "  hooks: {http: {url: 'https://hooks.example'}}", "plugins:",
      "  poster:", "    connections: [hooks]", "    on: [push]", "    steps: [{http: {method: POST, path: /}}]", "    attach: []"].join("\n");
    const gh = fakeGitHub({ file, other: (url) => (url.startsWith("https://hooks.example") ? new Response("", { status: 503 }) : undefined) });
    await onBranch([]);
    await w.d.query("delete from plugin_events");
    await push("main");
    expect(await run(gh.impl)).toEqual({ ran: 1, failed: 0 });
  });

  it("runs a dry-run instance without attaching, and keeps the docs of earlier real runs tracked", async () => {
    SHIPPED["test-doc"] = { def: { connections: [], on: ["push"], steps: [{ name: "v", value: "`1`" }],
      attach: [{ when: "event.branch == 'a'", doc: { name: "notes.md", content: "hi" } }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  test-doc: {use: shipped}\n" });
      vi.stubGlobal("fetch", gh.impl);
      await onBranch([]);
      await push("a");
      await run(gh.impl);
      expect((await listDocs(w.d, "p", "I1")).map((x) => x.name)).toEqual(["notes.md"]);
      await w.d.query(`insert into plugin_instances (project, repo, plugin, id, def, updated_by)
                       values ('p', 'acme/web', 'test-doc', 'default', '{"id": "default", "name": "default", "dry_run": true}', 'alice')`);
      await push("b");
      await run(gh.impl);
      expect((await listDocs(w.d, "p", "I1")).length).toBe(1);
      expect((await runs()).at(-1)).toMatchObject({ dry_run: true, result: expect.objectContaining({ log: ["dry run: nothing was attached"] }) });
      await w.d.query("delete from plugin_instances");
      await push("b");
      await run(gh.impl);
      expect(await listDocs(w.d, "p", "I1")).toEqual([]);
    } finally {
      delete SHIPPED["test-doc"];
    }
  });

  it("leaves a plugin doc someone edited since", async () => {
    SHIPPED["test-doc"] = { def: { connections: [], on: ["push"], steps: [{ name: "v", value: "`1`" }],
      attach: [{ when: "event.branch == 'a'", doc: { name: "notes.md", content: "v{{event.branch}}" } }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  test-doc: {use: shipped}\n" });
      await onBranch([]);
      await push("a");
      await run(gh.impl);
      await w.d.query("update docs set sha256 = 'edited'");
      await push("b");
      await run(gh.impl);
      expect((await listDocs(w.d, "p", "I1")).length).toBe(1);
      expect((await runs()).at(-1)!.result.log.join(" ")).toMatch(/edited since the plugin wrote it/);
    } finally {
      delete SHIPPED["test-doc"];
    }
  });

  it("posts a request whose text returns to an earlier version as a new version", async () => {
    SHIPPED["rq"] = { def: { connections: [], on: ["push"], capabilities: ["post-request"], steps: [{ name: "v", value: "`1`" }],
      attach: [{ request: "{{event.branch}}" }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  rq: {use: shipped}\n" });
      await onBranch([]);
      await w.d.query("insert into plugin_grants (project, repo, plugin, capabilities, granted_by) values ('p', 'acme/web', 'rq', '{post-request}', 'alice')");
      for (const b of ["A", "B", "A", "A"]) {
        await push(b);
        await run(gh.impl);
      }
      const notes = await w.d.query("select uid, text, meta->>'version' as v from notes where kind = 'ticket-request' order by n");
      expect(notes.map((n) => [n.text, n.v])).toEqual([["A", "1"], ["B", "2"], ["A", "3"]]);
      expect(notes[2].uid).toBe(pluginUid("rq/default", "I1", requestKey("request:A", 3)));
    } finally {
      delete SHIPPED["rq"];
    }
  });
});

describe("polling", () => {
  it("asks every page with its own ETag, so a moved tip on page 2 is seen behind an unchanged page 1", async () => {
    const tips = (page: number, moved: boolean) => Array.from({ length: page === 1 ? 100 : 5 }, (_, i) =>
      ({ name: `b${page}-${i}`, commit: { sha: page === 2 && i === 0 && moved ? "y" : "x" } }));
    let moved = false;
    const asked: [number, string | undefined][] = [];
    const gh = fakeGitHub({ prs: {}, other: (url, init) => {
      const m = url.match(/\/branches\?per_page=100&page=(\d+)/);
      if (!m) return undefined;
      const page = Number(m[1]);
      const inm = (init?.headers as Record<string, string>)["if-none-match"];
      asked.push([page, inm]);
      const etag = `"p${page}${page === 2 && moved ? "m" : ""}"`;
      if (inm === etag) return new Response(null, { status: 304 });
      return Response.json(tips(page, moved), { headers: { etag } });
    } });
    await onBranch(["b2-0"]);
    await run(gh.impl);
    await tick(gh.impl);
    expect(await tick(gh.impl)).toMatchObject({ pushes: 0 });
    moved = true;
    expect(await tick(gh.impl)).toMatchObject({ polled: 1, pushes: 1 });
    expect(asked.slice(-2)).toEqual([[1, '"p1"'], [2, '"p2"']]);
  });
});

describe("secrets", () => {
  const SPEC: Spec = { file: ["connections:", "  hooks: {http: {url: 'https://hooks.example'}}",
    "plugins:", "  ping:", "    connections: [hooks]", "    on: [push]",
    "    settings: {token: {label: Token, type: secret}, path: {label: Path, type: text}}",
    "    steps: [{http: {method: POST, path: '/{{settings.path}}', body: {t: '{{settings.token}}'}}}]", "    attach: []"].join("\n") };
  const putPing = (settings: Record<string, unknown>) => pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice,
    { repo: "acme/web", plugin: "ping", instances: [{ id: "a", name: "A", settings }] }), params("p"));
  const shown = async () => (await (await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob), params("p"))).json());

  it("keeps secret-type settings encrypted, shows only that they're set, keeps them on {set: true} and clears them on null", async () => {
    const gh = fakeGitHub({ ...SPEC, other: (url) => (url.startsWith("https://hooks.example") ? Response.json({}) : undefined) });
    vi.stubGlobal("fetch", gh.impl);
    expect((await putPing({ token: "tok-123", path: "x" })).status).toBe(503);
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("hex"));
    expect((await putPing({ token: "tok-123", path: "x" })).status).toBe(200);
    expect(JSON.stringify(await w.d.query("select * from plugin_instances"))).not.toContain("tok-123");
    let body = await shown();
    expect(body.instances.ping[0].settings).toEqual({ path: "x", token: { set: true } });
    expect(body.plugins.find((p: { name: string }) => p.name === "ping").instances[0].settings).toEqual({ path: "x", token: { set: true } });
    expect(JSON.stringify(body)).not.toContain("tok-123");

    expect((await putPing({ token: { set: true }, path: "y" })).status).toBe(200);
    await onBranch([]);
    await push("main");
    await run(gh.impl);
    expect(gh.sent.find((s) => s.url === "https://hooks.example/y")!.body).toEqual({ t: "tok-123" });
    expect(JSON.stringify(await runs())).not.toContain("tok-123");

    expect((await putPing({ token: null, path: "y" })).status).toBe(200);
    body = await shown();
    expect(body.instances.ping[0].settings).toEqual({ path: "y" });
  });

  it("forgets a credential without the key, and names a key that doesn't decode to 32 bytes", async () => {
    const credential = (b: unknown) => credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, b), params("p"));
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    await credential({ repo: "acme/web", connection: "hooks", secret: "abc" });
    vi.stubEnv("TODO_SECRET_KEY", "");
    expect((await credential({ repo: "acme/web", connection: "hooks", secret: null })).status).toBe(200);
    expect(await w.d.query("select * from plugin_credentials")).toEqual([]);
    for (const bad of ["c2hvcnQ=", "zz".repeat(32), crypto.randomBytes(31).toString("base64"), `${crypto.randomBytes(32).toString("base64")}x`]) {
      vi.stubEnv("TODO_SECRET_KEY", bad);
      const r = await credential({ repo: "acme/web", connection: "hooks", secret: "abc" });
      expect(r.status).toBe(503);
      expect((await r.json()).error).toMatch(/must be 32 bytes/);
    }
    expect((await credential({ repo: "mallory/x", connection: "hooks", secret: null })).status).toBe(404);
  });

  it("says an instance runs on the server only when it can: allowed repo, token, credentials, no command, a reachable address", async () => {
    const uses = (c: string) => [`  use-${c}:`, `    connections: [${c}]`, "    on: [push]", "    steps: [{http: {method: GET, path: /}}]", "    attach: []"];
    const file = ["connections:", "  hooks: {http: {url: 'https://hooks.example', auth: bearer}}", "  local: {mcp: {command: /bin/echo}}",
      "  lan: {http: {url: 'http://192.168.1.4'}}", "plugins:", ...["hooks", "local", "lan", "github"].flatMap(uses)].join("\n");
    vi.stubGlobal("fetch", fakeGitHub({ file }).impl);
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "acme/web=hooks.example");
    const runsHere = async () => Object.fromEntries((await shown()).plugins.map((p: { name: string; instances: { server_runs: boolean }[] }) =>
      [p.name, p.instances[0]?.server_runs]));
    expect(await runsHere()).toEqual({ "pr-link": true, "use-hooks": false, "use-local": false, "use-lan": false, "use-github": false });
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    await w.d.query("delete from plugin_defs");
    await credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, { repo: "acme/web", connection: "hooks", secret: "k" }), params("p"));
    expect((await runsHere())["use-hooks"]).toBe(true);
    vi.stubEnv("GITHUB_TOKEN", "");
    expect(Object.values(await runsHere()).every((v) => v === false)).toBe(true);
  });
});

describe("owners the server reads", () => {
  it("allows no repo while TODO_PLUGIN_OWNERS is unset, and says so on the rail", async () => {
    vi.stubEnv("TODO_PLUGIN_OWNERS", "");
    const gh = fakeGitHub({});
    vi.stubGlobal("fetch", gh.impl);
    await onBranch(["feat/x"]);
    expect(await events()).toEqual([]);
    expect((await itemGitFacts(w.d, "p", "I1", gh.impl)).blocked).toBe(OWNERS_UNSET);
    expect((await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob), params("p"))).status).toBe(404);
    expect(gh.sent).toEqual([]);
  });

  it("refuses a repo outside the owners, even with a checkout or a listing", async () => {
    vi.stubEnv("TODO_PLUGIN_OWNERS", "Acme, beta_corp");
    const gh = fakeGitHub({});
    vi.stubGlobal("fetch", gh.impl);
    await recordCheckout(w.d, "bob", "p", "/tmp/fake", "git@github.com:mallory/x.git");
    await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'mallory/y', 'bob')");
    for (const repo of ["mallory/x", "mallory/y"]) {
      expect(await queuePluginEvent(w.d, "p", "I1", repo, { type: "refresh" }, "bob")).toBeNull();
      expect((await pluginsGET(req(`/api/projects/p/plugins?repo=${repo}`, "GET", w.tokens.bob), params("p"))).status).toBe(404);
    }
    expect(gh.sent).toEqual([]);
    await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'beta_corp/app', 'bob')");
    expect((await pluginsGET(req("/api/projects/p/plugins?repo=Beta_Corp/app", "GET", w.tokens.bob), params("p"))).status).toBe(200);
  });
});

describe("webhook replays under fresh ids", () => {
  const SECRET = "s";
  const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/web" }, pull_request: { head: { ref: "feat/x" } } });
  const hook = (id: string) => webhookPOST(new Request("http://x/api/github/webhook", {
    method: "POST", body, headers: { "x-github-event": "pull_request", "x-github-delivery": id,
                                     "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", SECRET).update(body).digest("hex")}` } }));
  beforeEach(async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET);
    vi.stubGlobal("fetch", fakeGitHub({}).impl);
    await onBranch(["feat/x"]);
    await w.d.query("delete from plugin_events");
  });

  it("drops the same signed body whatever its delivery id", async () => {
    for (const id of ["d1", "d1", "d2", "d3"]) await hook(id);
    expect((await events()).length).toBe(1);
    await vi.waitFor(async () => expect((await events()).every((e) => e.done_at)).toBe(true));
  });

  it("runs GitHub's redelivery of a delivery that failed", async () => {
    await w.d.exec("alter table plugin_events rename to plugin_events_away");
    await expect(hook("d1")).rejects.toThrow();
    await w.d.exec("alter table plugin_events_away rename to plugin_events");
    expect((await (await hook("d1")).json()).queued).toBe(1);
    await vi.waitFor(async () => expect((await events()).every((e) => e.done_at)).toBe(true));
  });
});

describe("a bad attachment", () => {
  it("fails only itself: the run's other attachments and the later instances still apply", async () => {
    SHIPPED["nul"] = { def: { connections: [], on: ["push"], steps: [{ name: "v", value: "`1`" }], attach: [
      { link: { type: "x", url: "https://ok.example/1", label: "fine" } }, { link: { type: "x", url: "https://ok.example/2", label: "bad\u0000label" } }] } };
    try {
      const gh = fakeGitHub({ file: `plugins:\n  nul: {use: shipped}\n${logPlugins("after").replace("plugins:\n", "")}\n` });
      await onBranch([]);
      await w.d.query("delete from plugin_events");
      await push("z");
      const r = await run(gh.impl);
      expect(r).toEqual({ ran: 1, failed: 0 });
      expect((await links()).map((n) => n.text)).toEqual(["fine"]);
      expect((await w.d.query("select text from logs")).map((r) => r.text)).toEqual(["after ran"]);
      const nul = (await runs()).find((r) => r.plugin === "nul")!;
      expect(nul.result.log.join(" ")).toMatch(/create note \w+ was refused: error/);
    } finally {
      delete SHIPPED["nul"];
    }
  });
});

describe("server_runs", () => {
  const shownRuns = async () => Object.fromEntries((await (await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob),
    params("p"))).json()).plugins.map((p: { name: string; instances: { id: string; server_runs: boolean }[] }) => [p.name, p.instances.map((i) => i.server_runs)]));

  it("is false for an instance missing a required setting, true once it's set; an item-level when doesn't matter", async () => {
    const file = ["plugins:", "  needs:", "    on: [push]", "    when: \"item.status == 'never'\"", "    settings: {path: {label: Path, type: text}}",
      "    steps: [{name: v, value: '`1`'}]", "    attach: [{log: hi}]", "instances:", "  needs: [{id: a, name: A}, {id: b, name: B, settings: {path: x}}]"].join("\n");
    vi.stubGlobal("fetch", fakeGitHub({ file }).impl);
    expect((await shownRuns()).needs).toEqual([false, true]);
  });

  it("is false when a stored credential won't decrypt", async () => {
    const file = ["connections:", "  hooks: {http: {url: 'https://hooks.example', auth: bearer}}", "plugins:",
      "  ping: {connections: [hooks], on: [push], steps: [{http: {method: GET, path: /}}], attach: []}"].join("\n");
    vi.stubGlobal("fetch", fakeGitHub({ file }).impl);
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "acme/web=hooks.example");
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    await credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, { repo: "acme/web", connection: "hooks", secret: "k" }), params("p"));
    expect((await shownRuns()).ping).toEqual([true]);
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    expect((await shownRuns()).ping).toEqual([false]);
  });

  it("is true for a host connection that runs a command, which the server does run", async () => {
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ local: { mcp: { command: "/bin/true" } } }));
    vi.stubGlobal("fetch", fakeGitHub({ file: "plugins:\n  loc: {connections: [local], on: [push], steps: [{tool: t}], attach: []}\n" }).impl);
    expect((await shownRuns()).loc).toEqual([true]);
  });
});

describe("older CLIs", () => {
  it("write a single extra.branch, which still routes webhooks to the item, and moving it moves the routing", async () => {
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web", branch: "feat/old" } }));
    expect((await itemsOnBranch(w.d, "acme/web", "feat/old")).map((i) => i.uid)).toEqual(["I1"]);
    await setItem({ "extra.branch": "feat/new" });
    expect(await itemsOnBranch(w.d, "acme/web", "feat/old")).toEqual([]);
    expect((await itemsOnBranch(w.d, "acme/web", "feat/new")).map((i) => i.uid)).toEqual(["I1"]);
    await setItem({ "extra.branch": null });
    expect(await itemsOnBranch(w.d, "acme/web", "feat/new")).toEqual([]);
  });

  it("have their legacy branch backfilled into branches by the migration", async () => {
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web" } }));
    await w.d.query(`update items set extra = extra - 'branches' || '{"branch": " feat/legacy "}'::jsonb where uid = 'I1'`);
    await migrate(w.d);
    expect((await w.d.query("select extra->'branches' as b from items where uid = 'I1'"))[0].b).toEqual(["feat/legacy"]);
  });
});

it("reads GitHub Enterprise owners with underscores", () => {
  expect(repoKey("git@github.com:Acme_Corp/web.git")).toBe("acme_corp/web");
});
