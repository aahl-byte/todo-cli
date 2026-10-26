import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as changesGET } from "@/app/api/projects/[key]/changes/route";
import { GET as pluginsGET, PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { POST as credentialsPOST } from "@/app/api/projects/[key]/plugins/credentials/route";
import { POST as webhookPOST } from "@/app/api/github/webhook/route";
import { GET as tickGET } from "@/app/api/plugins/tick/route";
import { listDocs } from "@/lib/docs";
import { readLocal } from "@/lib/files";
import { resetGitFactsCache, type Fetch } from "@/lib/gitfacts";
import { flushPluginRuns, pluginTick, pluginUid } from "@/lib/plugins/server";
import { queuePluginEvent } from "@/lib/plugins/queue";
import { SHIPPED } from "@/lib/plugins/shipped";
import { hashUid } from "@/lib/ulid";
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

async function onBranch(uid: string, branches: string[], data: Record<string, unknown> = {}) {
  await w.one("alice", item(uid, { status: "in-progress", extra: { repo: "acme/web", branches }, ...data }));
}
const linkNotes = async (uid = "I1") => w.d.query("select uid, kind, text, meta from notes where project = 'p' and item_uid = $1 and kind = 'link' order by n", [uid]);
const runs = () => w.d.query("select * from plugin_runs order by id");
const events = () => w.d.query("select * from plugin_events order by id");
const hostDeps = { sleep: async () => {}, guard: { allow: [], lookup: publicDns } };
const run = (f: Fetch, host = {}) => flushPluginRuns(w.d, { fetch: f, host: { ...hostDeps, ...host } }, 50);
const tick = (f: Fetch) => pluginTick(w.d, { fetch: f, host: hostDeps });

describe("hashUid", () => {
  it("matches the CLI's hash_uid", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const py = execFileSync("python3", ["-c", "from todo.uids import hash_uid; print(hash_uid('plugin', 'pr-link/default', 'I1', 'link:https://x/1'))"],
                            { cwd: root, encoding: "utf8" }).trim();
    expect(pluginUid("pr-link/default", "I1", "link:https://x/1")).toBe(py);
    expect(hashUid("plugin", "pr-link/default", "I1", "link:https://x/1")).toBe(py);
  });
});

describe("running plugins", () => {
  it("delivers a status move to an instance it fires, linking the PR under a deterministic uid that reaches /changes", async () => {
    const gh = fakeGitHub({ prs: { "feat/x": [PR(5, "Login")] } });
    vi.stubGlobal("fetch", gh.impl);
    const put = await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, {
      repo: "acme/web", plugin: "pr-link", instances: [{ id: "default", name: "default", on: [{ status: { to: "review" } }] }] }), params("p"));
    expect(await put.json()).toEqual({ ok: true });
    await onBranch("I1", ["feat/x"]);
    await w.d.query("delete from plugin_events");
    await w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1", data: { status: "review" } });
    expect((await events()).map((e) => e.event)).toEqual([{ type: "status", from: "in-progress", to: "review" }]);
    expect(await run(gh.impl)).toEqual({ ran: 1, failed: 0 });

    const uid = pluginUid("pr-link/default", "I1", "link:https://github.com/acme/web/pull/5");
    expect(await linkNotes()).toEqual([{ uid, kind: "link", text: "#5 · Login", meta: expect.objectContaining({
      url: "https://github.com/acme/web/pull/5", type: "pr", label: "#5 · Login", plugin: "pr-link/default",
      plugin_key: "link:https://github.com/acme/web/pull/5" }) }]);
    expect(gh.sent.find((s) => s.url.includes("/pulls?"))!.headers.authorization).toBe("Bearer gh-token");
    const pull = await (await changesGET(req("/api/projects/p/changes?since=0", "GET", w.tokens.bob), params("p"))).json();
    expect(pull.changes.find((c: { uid: string }) => c.uid === uid)).toMatchObject({ entity: "note", data: { kind: "link", author: "plugin" } });
    const [r] = await runs();
    expect(r).toMatchObject({ plugin: "pr-link", instance: "default", applied: [uid] });
    expect((await events())[0]).toMatchObject({ error: null, errors: [] });
  });

  it("replaces an instance's links by key: adds new, updates changed, removes missing", async () => {
    const prs: Record<string, unknown[]> = { "feat/x": [PR(5), PR(6)] };
    const gh = fakeGitHub({ prs });
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    expect((await linkNotes()).map((n) => n.text)).toEqual(["#5 · PR 5", "#6 · PR 6"]);

    prs["feat/x"] = [PR(6, "renamed"), PR(7)];
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
    await run(gh.impl);
    const notes = await linkNotes();
    expect(notes.map((n) => n.text)).toEqual(["#6 · renamed", "#7 · PR 7"]);
    expect(notes[0].uid).toBe(pluginUid("pr-link/default", "I1", "link:https://github.com/acme/web/pull/6"));
    const [tomb] = await w.d.query("select uid from tombstones");
    expect(tomb.uid).toBe(pluginUid("pr-link/default", "I1", "link:https://github.com/acme/web/pull/5"));
  });

  it("changes nothing when a run errors or skips", async () => {
    const prs: Record<string, unknown[]> = { "feat/x": [PR(5)] };
    let down = false;
    const gh = fakeGitHub({ prs, other: (url) => (down && url.includes("/pulls?") ? new Response("boom", { status: 500 }) : undefined) });
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    down = true;
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
    await run(gh.impl);
    expect((await linkNotes()).length).toBe(1);
    expect((await runs()).at(-1)!.result.error).toMatch(/answered 500/);
  });

  it("skips a link whose URL is already on the item, and says so in the run log", async () => {
    const gh = fakeGitHub({ prs: { "feat/x": [PR(5)] } });
    await onBranch("I1", ["feat/x"]);
    await w.one("alice", child("note", "N1", "I1", { kind: "link", text: "by hand", meta: { url: "https://github.com/acme/web/pull/5", type: "pr" } }));
    await run(gh.impl);
    expect((await linkNotes()).map((n) => n.uid)).toEqual(["N1"]);
    expect((await runs())[0].result.log).toContain("skipped https://github.com/acme/web/pull/5: already linked on the item");
  });

  it("retries an event while GitHub can't be read, and doesn't rerun plugins that already ran", async () => {
    let down = true;
    const gh = fakeGitHub({ prs: { "feat/x": [PR(5)] }, other: (url) => (down && url === `${API}/repos/acme/web` ? new Response("", { status: 502 }) : undefined) });
    await onBranch("I1", ["feat/x"]);
    expect(await run(gh.impl)).toEqual({ ran: 0, failed: 1 });
    const [e] = await events();
    expect(e).toMatchObject({ attempts: 1, done_at: null });
    expect(e.error).toMatch(/502/);
    down = false;
    await w.d.query("update plugin_events set next_attempt_at = now()");
    expect(await run(gh.impl)).toEqual({ ran: 1, failed: 0 });
    expect((await linkNotes()).length).toBe(1);
  });

  it("reads the repo file once per default-branch head", async () => {
    const gh = fakeGitHub({ file: "track: [main]\n", prs: { "feat/x": [PR(5)] } });
    await onBranch("I1", ["feat/x"]);
    await onBranch("I2", ["feat/x"]);
    await run(gh.impl);
    expect(gh.sent.filter((s) => s.url.includes("/contents/")).length).toBe(1);
    const [defs] = await w.d.query("select sha, default_branch, files from plugin_defs");
    expect(defs).toEqual({ sha: "s1", default_branch: "main", files: { "plugins.yaml": "track: [main]\n" } });
  });

  it("refuses a repo connection that starts a command", async () => {
    const gh = fakeGitHub({ file: [
      "connections:", "  local: {mcp: {command: /bin/echo}}",
      "plugins:", "  local-tool:", "    connections: [local]", "    on: [push]",
      "    steps: [{tool: anything}]", "    attach: []",
    ].join("\n") });
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    const local = (await runs()).find((r) => r.plugin === "local-tool")!;
    expect(local.result.skipped).toMatch(/`local` runs a command, which this host doesn't allow/);
  });

  it("runs a repo's code plugin in the worker", async () => {
    const dir = path.join(import.meta.dirname, "fixtures/plugins");
    // Named apart from the shipped watchtower-session, which a repo can only enable.
    const file = readFileSync(path.join(dir, "watchtower.yaml"), "utf8").replace("http://leaf-rain:10011", "https://wt.example")
      .replaceAll("watchtower-session:", "wt-agent:");
    const answers: Record<string, unknown> = {
      "GET /api/roster": { sessions: [] }, "POST /api/sessions": { id: "s9" }, "GET /api/sessions/s9": { state: "active", status: "idle" },
      "POST /api/sessions/s9/message": {},
    };
    const gh = fakeGitHub({ file, code: { "watchtower-session.js": readFileSync(path.join(dir, "watchtower-session.js"), "utf8") },
      other: (url, init) => {
        if (!url.startsWith("https://wt.example")) return undefined;
        const body = answers[`${init?.method ?? "GET"} ${url.slice("https://wt.example".length)}`];
        return body === undefined ? new Response("", { status: 404 }) : Response.json(body);
      } });
    await onBranch("I1", ["feat/x"], { id: "fix-login" });
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "manual", instance: "start" }, "alice");
    await run(gh.impl);
    const wt = (await runs()).find((r) => r.plugin === "wt-agent")!;
    expect(wt.result.error).toBeUndefined();
    const [log] = await w.d.query("select uid, text from logs where item_uid = 'I1'");
    expect(log).toEqual({ uid: pluginUid("wt-agent/start", "I1", "log:started Watchtower session todo: fix-login: s9"),
                          text: "started Watchtower session todo: fix-login: s9" });
  });

  it("writes and later drops a plugin's doc through the docs store", async () => {
    SHIPPED["test-doc"] = { def: { connections: [], on: ["push"], steps: [{ name: "v", value: "`1`" }],
      attach: [{ when: "event.branch == 'feat/x'", doc: { name: "notes.md", content: "# hi {{event.branch}}" } }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  test-doc: {use: shipped}\n" });
      await onBranch("I1", ["feat/x"]);
      await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
      await run(gh.impl);
      const [doc] = await listDocs(w.d, "p", "I1");
      expect(doc).toMatchObject({ name: "notes.md", by: "plugin", plugin: "test-doc/default" });
      expect(String(await readLocal(doc.file_key))).toBe("# hi feat/x");
      await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/y" }, "alice");
      await run(gh.impl);
      expect(await listDocs(w.d, "p", "I1")).toEqual([]);
    } finally {
      delete SHIPPED["test-doc"];
    }
  });

  it("stores a doc the host fetched by url through a host connection, its bytes as they came", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ files: { http: { url: "https://files.example", auth: "bearer" } } }));
    vi.stubEnv("TODO_PLUGIN_SECRET_FILES", "f-token");
    SHIPPED["test-fetch"] = { def: { connections: ["files"], on: ["push"], steps: [{ name: "v", value: "`1`" }],
      attach: [{ doc: { name: "shot.png", url: "/a/1?redirect=false" } }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  test-fetch: {use: shipped}\n",
        other: (url) => (url === "https://files.example/a/1?redirect=false" ? new Response(png, { headers: { "content-type": "image/png" } }) : undefined) });
      await onBranch("I1", ["feat/x"]);
      await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
      await run(gh.impl);
      expect((await runs()).find((r) => r.plugin === "test-fetch")!.result.error).toBeUndefined();
      const [doc] = await listDocs(w.d, "p", "I1");
      expect(doc).toMatchObject({ name: "shot.png", plugin: "test-fetch/default" });
      expect(Buffer.from((await readLocal(doc.file_key))!).equals(png)).toBe(true);
      expect(gh.sent.find((s) => s.url.startsWith("https://files.example"))!.headers.authorization).toBe("Bearer f-token");
    } finally {
      delete SHIPPED["test-fetch"];
    }
  });

  it("posts a request only once the plugin is granted post-request", async () => {
    SHIPPED["test-request"] = { def: { connections: [], on: ["push"], capabilities: ["post-request"],
      steps: [{ name: "v", value: "`1`" }], attach: [{ request: "From Jira: {{event.branch}}" }] } };
    try {
      const gh = fakeGitHub({ file: "plugins:\n  test-request: {use: shipped}\n" });
      await onBranch("I1", ["feat/x"], { status: "requested" });
      await run(gh.impl);
      const requests = () => w.d.query("select uid, text from notes where kind = 'ticket-request'");
      expect(await requests()).toEqual([]);

      const put = await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice,
        { repo: "acme/web", plugin: "test-request", grants: ["post-request"] }), params("p"));
      expect(put.status).toBe(200);
      const [grant] = await w.d.query("select capabilities, granted_by from plugin_grants");
      expect(grant).toEqual({ capabilities: ["post-request"], granted_by: "alice" });
      await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
      await run(gh.impl);
      expect(await requests()).toEqual([{ uid: pluginUid("test-request/default", "I1", "request:From Jira: feat/x#v1"), text: "From Jira: feat/x" }]);
    } finally {
      delete SHIPPED["test-request"];
    }
  });

  it("queues one refresh for a new item, and a push for a branch an item gains", async () => {
    await onBranch("I1", ["feat/x"]);
    await w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1",
                                                           data: { "extra.branches": ["feat/x", "feat/y"] } });
    expect((await events()).map((e) => e.event)).toEqual([{ type: "refresh" }, { type: "push", branch: "feat/y" }]);
  });

  it("queues nothing without GITHUB_TOKEN", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    await onBranch("I1", ["feat/x"]);
    expect(await events()).toEqual([]);
  });
});

describe("the plugins API", () => {
  it("lists shipped and repo plugins with every instance, grants, secrets held and the last run", async () => {
    const gh = fakeGitHub({ file: [
      "connections:", "  hooks: {http: {url: 'https://hooks.example', auth: bearer}}",
      "plugins:", "  ping:", "    connections: [hooks]", "    on: [push]", "    every: 1h",
      "    settings: {path: {label: Path, type: text}}",
      "    steps: [{http: {method: POST, path: '/{{settings.path}}'}}]", "    attach: []",
      "instances:", "  ping: [{id: a, name: A, settings: {path: x}}]",
    ].join("\n"), prs: { "feat/x": [] } });
    vi.stubGlobal("fetch", gh.impl);
    await w.d.query(`insert into plugin_instances (project, repo, plugin, id, def, position, updated_by)
                     values ('p', 'acme/web', 'ping', 'b', '{"id": "b", "name": "B", "enabled": false}', 0, 'alice')`);
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    const body = await (await pluginsGET(req("/api/projects/p/plugins?repo=Acme/Web", "GET", w.tokens.bob), params("p"))).json();
    expect(body.instances).toEqual({ ping: [{ id: "b", name: "B", enabled: false }] });
    expect(body.grants).toEqual({});
    expect(body.secrets).toEqual([]);
    expect(body.host_secrets).toEqual(["github"]);
    expect(body.plugins).toEqual([
      { name: "pr-link", connections: ["github"], on: ["push", "pr"], every: null, settings: {},
        instances: [{ id: "default", name: "default", server_runs: true, server_runs_reason: null }], shipped: true },
      { name: "ping", connections: ["hooks"], on: ["push"], every: "1h", settings: { path: { label: "Path", type: "text" } },
        instances: [{ id: "a", name: "A", settings: { path: "x" }, server_runs: false, server_runs_reason: "`hooks` not authorized here" },
                    { id: "b", name: "B", enabled: false, server_runs: false, server_runs_reason: "`hooks` not authorized here" }],
        shipped: false },
    ]);
    expect(body.runs["pr-link/default"]).toMatchObject({ item: "I1" });
    expect(body.runs["ping/a"]).toMatchObject({ item: "I1", skipped: "ping: `hooks` not authorized here" });
  });

  it("offers host-wide connections from the environment, with their secrets, to shipped plugins", async () => {
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ hooks: { http: { url: "https://hooks.example", auth: "bearer" } } }));
    vi.stubEnv("TODO_PLUGIN_SECRET_HOOKS", "host-hook-secret");
    SHIPPED["test-ping"] = { def: { connections: ["hooks"], on: ["push"], steps: [{ http: { method: "POST", path: "/ping" } }], attach: [] } };
    const gh = fakeGitHub({ file: "plugins:\n  test-ping: {use: shipped}\n",
                            other: (url) => (url.startsWith("https://hooks.example") ? Response.json({}) : undefined) });
    vi.stubGlobal("fetch", gh.impl);
    await onBranch("I1", ["feat/x"]);
    try {
      await run(gh.impl);
    } finally {
      delete SHIPPED["test-ping"];
    }
    expect(gh.sent.find((s) => s.url === "https://hooks.example/ping")!.headers.authorization).toBe("Bearer host-hook-secret");
    const body = await (await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob), params("p"))).json();
    expect(body.secrets).toEqual([]);
    expect(body.host_secrets).toEqual(["github", "hooks"]);
    expect(JSON.stringify(body)).not.toContain("host-hook-secret");
  });

  it("rejects malformed instances", async () => {
    const r = await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice,
      { repo: "acme/web", plugin: "pr-link", instances: [{ name: "no id" }] }), params("p"));
    expect(r.status).toBe(400);
    expect((await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice,
      { repo: "acme/web", plugin: "pr-link", grants: ["root"] }), params("p"))).status).toBe(400);
    expect((await pluginsGET(req("/api/projects/p/plugins", "GET", null), params("p"))).status).toBe(401);
  });

  it("stores credentials encrypted, uses them for repo connections, and never returns them", async () => {
    const credential = (body: unknown) => credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, body), params("p"));
    const off = await credential({ repo: "acme/web", connection: "hooks", secret: "s3cret-value" });
    expect(off.status).toBe(503);
    expect((await off.json()).error).toMatch(/TODO_SECRET_KEY/);

    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "acme/web=hooks.example");
    expect(await (await credential({ repo: "acme/web", connection: "hooks", secret: "s3cret-value" })).json()).toEqual({ ok: true });
    const gh = fakeGitHub({ file: [
      "connections:", "  hooks: {http: {url: 'https://hooks.example', auth: bearer}}",
      "plugins:", "  ping:", "    connections: [hooks]", "    on: [push]",
      "    steps: [{http: {method: POST, path: '/ping', body: {item: '{{item.id}}'}}}]", "    attach: [{log: pinged}]",
    ].join("\n"), other: (url) => (url.startsWith("https://hooks.example") ? Response.json({ echoed: "s3cret-value" }) : undefined) });
    vi.stubGlobal("fetch", gh.impl);
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    expect(gh.sent.find((s) => s.url === "https://hooks.example/ping")!.headers.authorization).toBe("Bearer s3cret-value");

    const body = await (await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob), params("p"))).json();
    expect(body.secrets).toEqual(["hooks"]);
    expect(body.plugins.find((p: { name: string }) => p.name === "ping").instances[0].server_runs).toBe(true);
    expect(JSON.stringify(body)).not.toContain("s3cret-value");
    for (const t of ["plugin_credentials", "plugin_runs", "plugin_events", "notes", "logs", "changes", "applied_ops"]) {
      expect(JSON.stringify(await w.d.query(`select * from ${t}`))).not.toContain("s3cret-value");
    }
  });
});

const SECRET = "hook-secret";
const sign = (body: string, secret = SECRET) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
const hook = (kind: string, payload: unknown, signature?: string) => {
  const body = JSON.stringify(payload);
  return webhookPOST(new Request("http://x/api/github/webhook", {
    method: "POST", body, headers: { "x-github-event": kind, ...(signature === "" ? {} : { "x-hub-signature-256": signature ?? sign(body) }) },
  }));
};

describe("the GitHub webhook", () => {
  beforeEach(() => vi.stubEnv("GITHUB_WEBHOOK_SECRET", SECRET));

  it("queues the event for open items on the branch, in every project, and invalidates definitions on a default-branch push", async () => {
    const gh = fakeGitHub({ prs: { "feat/x": [PR(5)] } });
    vi.stubGlobal("fetch", gh.impl);
    await onBranch("I1", ["feat/x"]);
    await onBranch("I2", ["feat/y"]);
    await onBranch("I3", ["feat/x"], { status: "cancelled" });
    await w.d.query("delete from plugin_events");
    await w.d.query("insert into plugin_defs (repo, sha, default_branch) values ('acme/web', 's0', 'main')");

    const repository = { full_name: "Acme/Web", default_branch: "main" };
    const r = await hook("pull_request", { action: "opened", repository, pull_request: { head: { ref: "feat/x" } } });
    expect(r.status).toBe(202);
    expect(await r.json()).toMatchObject({ repo: "acme/web", queued: 1, projects: ["p"] });
    expect((await events()).map((e) => [e.item_uid, e.event])).toEqual([["I1", { type: "pr", branch: "feat/x" }]]);
    await vi.waitFor(async () => expect((await events()).every((e) => e.done_at)).toBe(true));

    await hook("push", { ref: "refs/heads/main", after: "m2", repository });
    expect((await w.d.query("select stale from plugin_defs"))[0].stale).toBe(true);
    const [state] = await w.d.query("select tips, hook_at from repo_polls");
    expect(state.tips).toEqual({ main: "m2" });
    expect(state.hook_at).not.toBeNull();
  });

  it("answers 401 to a bad or missing signature", async () => {
    await onBranch("I1", ["feat/x"]);
    await w.d.query("delete from plugin_events");
    const payload = { ref: "refs/heads/feat/x", repository: { full_name: "acme/web" } };
    expect((await hook("push", payload, sign("other body"))).status).toBe(401);
    expect((await hook("push", payload, "")).status).toBe(401);
    expect((await hook("push", payload, sign(JSON.stringify(payload), "wrong"))).status).toBe(401);
    expect(await events()).toEqual([]);
  });
});

describe("the tick", () => {
  it("polls branch tips with an ETag: unchanged queues nothing, a moved tip queues a push", async () => {
    vi.stubEnv("CRON_SECRET", "cron");
    const spec: Spec = { tips: { main: "m1", "feat/x": "x1" }, etag: '"e1"', prs: { "feat/x": [] } };
    const gh = fakeGitHub(spec);
    await onBranch("I1", ["feat/x"]);
    await run(gh.impl);
    const pushes = async () => (await events()).filter((e) => e.by === "plugin").length;

    expect(await tick(gh.impl)).toMatchObject({ polled: 1, pushes: 0 });
    expect(await tick(gh.impl)).toMatchObject({ polled: 1, pushes: 0 });
    const conditional = gh.sent.filter((s) => s.url.includes("/branches?"));
    expect(conditional.at(-1)!.headers["if-none-match"]).toBe('"e1"');
    expect(await pushes()).toBe(0);

    spec.tips = { main: "m1", "feat/x": "x2" };
    spec.etag = '"e2"';
    expect(await tick(gh.impl)).toMatchObject({ polled: 1, pushes: 1 });
    expect((await events()).at(-1)).toMatchObject({ item_uid: "I1", event: { type: "push", branch: "feat/x" } });

    expect((await tickGET(new Request("http://x/api/plugins/tick"))).status).toBe(401);
  });

  it("leaves a repo with a recent webhook to its webhook", async () => {
    const gh = fakeGitHub({ tips: { "feat/x": "x1" }, prs: { "feat/x": [] } });
    await onBranch("I1", ["feat/x"]);
    await w.d.query("insert into repo_polls (repo, hook_at) values ('acme/web', now())");
    expect(await tick(gh.impl)).toMatchObject({ polled: 0 });
  });

  it("queues a refresh for the plugins whose every: floor is due", async () => {
    const gh = fakeGitHub({ file: [
      "plugins:", "  hourly:", "    connections: [github]", "    every: 1h",
      "    steps: [{name: me, http: {method: GET, path: /user}}]", "    attach: [{log: checked}]",
    ].join("\n"), prs: { "feat/x": [] }, other: (url) => (url === `${API}/user` ? Response.json({}) : undefined) });
    await onBranch("I1", ["feat/x"], { status: "todo" });
    await w.d.query("delete from plugin_events");
    expect(await tick(gh.impl)).toMatchObject({ refreshes: 1, ran: 1 });
    expect((await events())[0]).toMatchObject({ event: { type: "refresh" }, only_plugins: ["hourly"] });
    expect((await runs()).map((r) => r.plugin)).toEqual(["hourly"]);
    expect(await tick(gh.impl)).toMatchObject({ refreshes: 0 });
  });
});
