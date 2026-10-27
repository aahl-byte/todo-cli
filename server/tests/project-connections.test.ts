// A project's own connections, set on Settings → Automation: stored per project with their secret encrypted, standing in for
// the server's of a name, bound to the endpoint the secret was given for, never reaching a custom plugin, and on a private
// address only once someone allows it there. The project's github token reads its repos for git facts and plugins.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as connectionsGET, PUT as connectionsPUT } from "@/app/api/projects/[key]/plugins/connections/route";
import { PUT as configPUT } from "@/app/api/projects/[key]/plugins/config/route";
import { addProject } from "@/lib/auth";
import { recomputeAll, remoteBranches, resetGitFactsCache, type Fetch } from "@/lib/gitfacts";
import { githubToken } from "@/lib/github-token";
import { addressAllowed, type Resolved } from "@/lib/plugins/connections";
import { queuePluginEvent } from "@/lib/plugins/queue";
import { NoSecretKey } from "@/lib/plugins/secrets";
import { flushPluginRuns, pluginTick } from "@/lib/plugins/server";
import { vercelChoices } from "@/lib/plugins/vercel";
import {
  guardFor, hostSet, PluginConflict, PluginInputError, PrivateAddress, projectConnections, putConnection, putProjectConnection, repoPlugins,
} from "@/lib/plugins/store";
import { item, world, type World } from "./helpers";
import { configured, fakeGitHub, params, PR, publicDns, req } from "./plugin-github";

let w: World;
beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", "");
  vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "");
  resetGitFactsCache();
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
});

const VERCEL = { http: { url: "https://api.vercel.com", auth: "bearer" as const } };
const put = (body: Record<string, unknown>, project = "p", lookup = publicDns) => putProjectConnection(w.d, project, body, "alice", { lookup });
const privateDns = async (): Promise<Resolved[]> => [{ address: "10.0.0.5", family: 4 }];

describe("a project's own connection", () => {
  it("keeps its secret encrypted, shows only that it's held, and gives it to the project's shipped plugins", async () => {
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    const [row] = await w.d.query("select * from project_connections");
    expect(JSON.stringify(row)).not.toContain("vc-token");
    expect(await projectConnections(w.d, "p")).toEqual([{ name: "vercel", def: VERCEL, held: true, unreadable: false, privateOk: null, version: 1,
                                                         updated: { by: "alice", at: expect.any(String) } }]);
    const set = await hostSet(w.d, "p", "acme/web");
    expect(set).toMatchObject({ page: ["vercel"], secrets: { vercel: "vc-token" } });
    expect(set.connections.vercel).toEqual(VERCEL);
    const listed = await connectionsGET(req("/api/projects/p/plugins/connections", "GET", w.tokens.bob), params("p"));
    expect(JSON.stringify(await listed.json())).not.toContain("vc-token");
  });

  it("is the project's alone: another project neither sees it nor can read its secret", async () => {
    await addProject(w.d, "q");
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    expect(await projectConnections(w.d, "q")).toEqual([]);
    await w.d.query("insert into project_connections select 'q', name, def, secret_enc, secret_endpoint, private_ok, version, updated_by, updated_at from project_connections");
    const set = await hostSet(w.d, "q", "acme/web");
    expect(set.secrets.vercel).toBeUndefined();
    expect(set.unreadable).toEqual(["vercel"]);
  });

  it("can't store a secret without TODO_SECRET_KEY, and says so", async () => {
    vi.stubEnv("TODO_SECRET_KEY", "");
    await expect(put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null })).rejects.toThrow(NoSecretKey);
    const res = await connectionsPUT(req("/api/projects/p/plugins/connections", "PUT", w.tokens.bob, { name: "vercel", def: VERCEL, secret: "x", base: null }), params("p"));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("TODO_SECRET_KEY isn't set on the server, so it can't store secrets");
    await put({ name: "vercel", def: VERCEL, base: null });
    expect(await projectConnections(w.d, "p")).toMatchObject([{ name: "vercel", held: false }]);
  });

  it("is removed with def null", async () => {
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    await put({ name: "vercel", def: null, base: 1 });
    expect(await projectConnections(w.d, "p")).toEqual([]);
  });
});

describe("over the server's connection of a name", () => {
  beforeEach(() => {
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ vercel: { http: { url: "https://vercel.example", auth: "bearer" } } }));
    vi.stubEnv("TODO_PLUGIN_SECRET_VERCEL", "env-token");
  });

  it("the server's is the default, and the project's, address and secret, wins once it's set", async () => {
    let set = await hostSet(w.d, "p", "acme/web");
    expect([set.connections.vercel, set.secrets.vercel, set.page]).toEqual([{ http: { url: "https://vercel.example", auth: "bearer" } }, "env-token", []]);
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    set = await hostSet(w.d, "p", "acme/web");
    expect([set.connections.vercel, set.secrets.vercel, set.page]).toEqual([VERCEL, "vc-token", ["vercel"]]);
    await put({ name: "vercel", def: null, base: 1 });
    expect((await hostSet(w.d, "p", "acme/web")).secrets.vercel).toBe("env-token");
  });

  it("never lends the server's secret to the project's connection, even at the same address", async () => {
    await put({ name: "vercel", def: { http: { url: "https://vercel.example", auth: "bearer" } }, base: null });
    expect((await hostSet(w.d, "p", "acme/web")).secrets.vercel).toBeUndefined();
  });

  it("is picked up by the next run without a restart", async () => {
    const vercel = (token: string) => (url: string, init: RequestInit | undefined) => {
      if (!url.startsWith("https://api.vercel.com/v7/deployments")) return undefined;
      const auth = (init?.headers as Record<string, string>)?.authorization;
      return Response.json({ deployments: auth === `Bearer ${token}` ? [{ url: "web-x.vercel.app", readyState: "READY", meta: { githubCommitRef: "feat/x" } }] : [] });
    };
    const gh = await configured(w.d, { file: "plugins:\n  vercel-preview: {use: shipped}\ninstances:\n  vercel-preview: [{id: web, name: Web, settings: {project: prj, team: tm}}]\n",
                                       other: vercel("vc-token") });
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web", branches: ["feat/x"] } }));
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice");
    await flushPluginRuns(w.d, { fetch: gh.impl, host: { sleep: async () => {}, guard: { allow: [], lookup: publicDns } } }, 50);
    const links = await w.d.query("select text from notes where item_uid = 'I1' and kind = 'link'");
    expect(links.map((l) => l.text)).toContain("preview · feat/x");
    expect(gh.sent.filter((s) => s.url.startsWith("https://vercel.example"))).toEqual([]);
  });
});

describe("the endpoint a secret was given for", () => {
  it("is where the secret goes: changing the address drops it, keeping the address keeps it", async () => {
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    await put({ name: "vercel", def: VERCEL, base: 1 });
    expect((await hostSet(w.d, "p", "acme/web")).secrets.vercel).toBe("vc-token");
    await put({ name: "vercel", def: { http: { url: "https://vercel.attacker.example", auth: "bearer" } }, base: 2 });
    expect((await hostSet(w.d, "p", "acme/web")).secrets.vercel).toBeUndefined();
    expect(await projectConnections(w.d, "p")).toMatchObject([{ held: false, version: 3 }]);
  });

  it("drops the secret when how it authorizes changes", async () => {
    await put({ name: "hooks", def: { http: { url: "https://hooks.example", auth: "bearer" } }, secret: "s", base: null });
    await put({ name: "hooks", def: { http: { url: "https://hooks.example", auth: "header:X-Key" } }, base: 1 });
    expect((await hostSet(w.d, "p", "acme/web")).secrets.hooks).toBeUndefined();
  });

  it("decrypts the secret only there, whatever the row says", async () => {
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    await w.d.query(`update project_connections set def = '{"http": {"url": "https://evil.example", "auth": "bearer"}}'::jsonb,
                      secret_endpoint = 'https://evil.example'`);
    const set = await hostSet(w.d, "p", "acme/web");
    expect(set.secrets.vercel).toBeUndefined();
    expect(set.unreadable).toEqual(["vercel"]);
  });

  it("refuses a change made on a version someone has saved since, and a new one someone added meanwhile, with a 409", async () => {
    await put({ name: "vercel", def: VERCEL, base: null });
    await put({ name: "vercel", def: VERCEL, secret: "theirs", base: 1 });
    await expect(put({ name: "vercel", def: { http: { url: "https://elsewhere.example", auth: "bearer" } }, base: 1 })).rejects.toThrow(PluginConflict);
    await expect(put({ name: "vercel", def: VERCEL, base: null })).rejects.toThrow(PluginConflict);
    await expect(put({ name: "jira", def: null, base: 4 })).rejects.toThrow(PluginConflict);
    expect((await hostSet(w.d, "p", "acme/web")).secrets.vercel).toBe("theirs");
    const res = await connectionsPUT(req("/api/projects/p/plugins/connections", "PUT", w.tokens.bob, { name: "vercel", secret: "late", base: 1 }), params("p"));
    expect(res.status).toBe(409);
  });
});

describe("the trust rule", () => {
  const SNEAK = ["plugins:", "  sneak:", "    connections: [vercel]", "    on: [push]",
    "    steps: [{http: {method: GET, path: /v2/user}}]", "    attach: []"].join("\n");

  it("keeps a project's connection and its secret from a custom plugin that names it", async () => {
    const gh = await configured(w.d, { file: SNEAK, other: () => Response.json({}) });
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    const view = await repoPlugins(w.d, "p", "acme/web", publicDns);
    expect(view.plugins.find((p) => p.name === "sneak")!.instances[0].server_runs_reason).toMatch(/`vercel` is this host's connection/);
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web", branches: ["main"] } }));
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "main" }, "alice");
    await flushPluginRuns(w.d, { fetch: gh.impl, host: { sleep: async () => {}, guard: { allow: [], lookup: publicDns } } }, 50);
    expect(gh.sent.filter((s) => s.url.includes("vercel"))).toEqual([]);
    expect(JSON.stringify(gh.sent)).not.toContain("vc-token");
    const [run] = await w.d.query("select result from plugin_runs where plugin = 'sneak'");
    expect(run.result.skipped).toMatch(/`vercel` is this host's connection/);
  });

  it("keeps a repo connection and a project's own from taking the same name", async () => {
    await put({ name: "vercel", def: VERCEL, base: null });
    await expect(putConnection(w.d, "p", "acme/web", "vercel", VERCEL, "alice")).rejects.toThrow(/this project has its own vercel/);
    await putConnection(w.d, "p", "acme/web", "hooks", { http: { url: "https://hooks.example" } }, "alice");
    await expect(put({ name: "hooks", def: { http: { url: "https://hooks.example" } }, base: null })).rejects.toThrow(/acme\/web has a connection named hooks/);
  });

  it("gives a shipped rest instance the project's connection it names", async () => {
    const gh = await configured(w.d, {
      file: "plugins:\n  rest: {use: shipped}\ninstances:\n  rest: [{id: ping, name: Ping, settings: {connection: hooks, method: POST, path: /ping}}]\n",
      other: (url) => (url.startsWith("https://hooks.example") ? Response.json({}) : undefined) });
    await put({ name: "hooks", def: { http: { url: "https://hooks.example", auth: "bearer" } }, secret: "hook-token", base: null });
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web" } }));
    await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "manual", instance: "ping" }, "alice");
    await flushPluginRuns(w.d, { fetch: gh.impl, host: { sleep: async () => {}, guard: { allow: [], lookup: publicDns } } }, 50);
    expect(gh.sent.filter((s) => s.url === "https://hooks.example/ping").map((s) => s.headers.authorization)).toEqual(["Bearer hook-token"]);
  });

  it("never sends a project's secret to a CLI", async () => {
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    const view = await repoPlugins(w.d, "p", "acme/web");
    expect(view.host_secrets).toContain("vercel");
    expect(JSON.stringify(view)).not.toContain("vc-token");
  });
});

describe("a private address", () => {
  const WT = { http: { url: "http://127.0.0.1:10010/latest" } };

  it("is refused until someone allows it, which records who and when", async () => {
    await expect(put({ name: "watchtower", def: WT, base: null })).rejects.toThrow(PrivateAddress);
    const res = await connectionsPUT(req("/api/projects/p/plugins/connections", "PUT", w.tokens.bob, { name: "watchtower", def: WT, base: null }), params("p"));
    expect([res.status, (await res.json()).private]).toEqual([400, true]);
    await put({ name: "watchtower", def: WT, base: null, allowPrivate: true });
    expect(await projectConnections(w.d, "p")).toMatchObject([{ name: "watchtower", privateOk: { by: "alice", at: expect.any(String) } }]);
  });

  it("asks for a name that resolves to a private address too, and not for one TODO_PLUGIN_ALLOW_HOSTS opens", async () => {
    const def = { http: { url: "https://wt.tailnet.example" } };
    await expect(put({ name: "watchtower", def, base: null }, "p", privateDns)).rejects.toThrow(PrivateAddress);
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "wt.tailnet.example");
    await put({ name: "watchtower", def, base: null }, "p", privateDns);
    expect(await projectConnections(w.d, "p")).toMatchObject([{ privateOk: null }]);
  });

  it("is opened to that one connection only, never to another at the same address or to a repo's", async () => {
    await put({ name: "watchtower", def: WT, base: null, allowPrivate: true });
    const set = await hostSet(w.d, "p", "acme/web");
    expect(set.privateOk).toEqual({ watchtower: "127.0.0.1:10010" });
    const guard = guardFor("acme/web", undefined, set.privateOk);
    expect(await addressAllowed(WT.http.url, guard, "host", "watchtower")).toBe(true);
    expect(await addressAllowed(WT.http.url, guard, "host", "other")).toBe(false);
    expect(await addressAllowed(WT.http.url, guard, "repo", "watchtower")).toBe(false);
  });

  it("must be allowed again once the address changes", async () => {
    await put({ name: "watchtower", def: WT, base: null, allowPrivate: true });
    await expect(put({ name: "watchtower", def: { http: { url: "http://10.1.2.3:80" } }, base: 1 })).rejects.toThrow(PrivateAddress);
    await put({ name: "watchtower", def: { http: { url: "https://wt.example" } }, base: 1 });
    expect(await projectConnections(w.d, "p")).toMatchObject([{ privateOk: null }]);
    expect((await hostSet(w.d, "p", "acme/web")).privateOk).toEqual({});
  });

  it("runs a shipped plugin's call through once allowed, and refuses it before", async () => {
    const seen: string[] = [];
    const gh = await configured(w.d, {
      file: "plugins:\n  rest: {use: shipped}\ninstances:\n  rest: [{id: ping, name: Ping, settings: {connection: watchtower, method: POST, path: /ping}}]\n",
      other: (url) => { if (url.startsWith("http://127.0.0.1:10010")) { seen.push(url); return Response.json({}); } return undefined; } });
    await put({ name: "watchtower", def: WT, base: null, allowPrivate: true });
    const view = await repoPlugins(w.d, "p", "acme/web", publicDns);
    expect(view.plugins.find((p) => p.name === "rest")!.instances[0]).toMatchObject({ server_runs: true, server_runs_reason: null });
    await w.d.query("update project_connections set private_ok = null");
    const refused = await repoPlugins(w.d, "p", "acme/web", publicDns);
    expect(refused.plugins.find((p) => p.name === "rest")!.instances[0].server_runs_reason).toBe("connection `watchtower` is refused by the private-address rule");
    expect(seen).toEqual([]);
    void gh;
  });
});

describe("the project's GitHub token", () => {
  const GITHUB = { http: { url: "https://api.github.com", auth: "bearer" as const } };

  it("reads the project's repos in place of the server's, which reads only TODO_PLUGIN_OWNERS' repos", async () => {
    expect(await githubToken(w.d, "p", "acme/web")).toEqual({ token: "gh-token", source: "server" });
    expect(await githubToken(w.d, "p", "other/repo")).toBeNull();
    await put({ name: "github", secret: "page-token", base: null });
    expect(await githubToken(w.d, "p", "acme/web")).toEqual({ token: "page-token", source: "page" });
    expect(await githubToken(w.d, "p", "other/repo")).toEqual({ token: "page-token", source: "page" });
    expect((await hostSet(w.d, "p", "acme/web")).connections.github).toEqual(GITHUB);
  });

  it("takes only a token: its address is the server's GitHub API, and clearing the token removes it", async () => {
    await expect(put({ name: "github", def: { http: { url: "https://evil.example", auth: "bearer" } }, secret: "t", base: null })).rejects.toThrow(PluginInputError);
    await put({ name: "github", def: GITHUB, secret: "page-token", base: null });
    await put({ name: "github", secret: null, base: 1 });
    expect(await projectConnections(w.d, "p")).toEqual([]);
  });

  it("lets git facts and plugins read GitHub with no GITHUB_TOKEN, and the ticks pick it up without a restart", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const gh = fakeGitHub({ prs: { "feat/x": [PR(7)] }, tips: { main: "m1", "feat/x": "x1" } });
    await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web", branches: ["feat/x"] } }));
    expect(await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice")).toBeNull();
    expect(await pluginTick(w.d, { fetch: gh.impl })).toEqual({ ran: 0, failed: 0, polled: 0, pushes: 0, refreshes: 0 });
    expect(await recomputeAll(w.d, gh.impl)).toEqual([]);

    await put({ name: "github", secret: "page-token", base: null });
    expect((await remoteBranches(w.d, "p", "acme/web", gh.impl)).visible).toBe(true);
    const tick = await pluginTick(w.d, { fetch: gh.impl, host: { sleep: async () => {}, guard: { allow: [], lookup: publicDns } } });
    expect(tick.polled).toBe(1);
    expect(await queuePluginEvent(w.d, "p", "I1", "acme/web", { type: "push", branch: "feat/x" }, "alice")).not.toBeNull();
    await flushPluginRuns(w.d, { fetch: gh.impl, host: { sleep: async () => {}, guard: { allow: [], lookup: publicDns } } }, 50);
    expect(await recomputeAll(w.d, gh.impl)).toEqual(["p"]);
    const github = gh.sent.filter((s) => s.url.startsWith("https://api.github.com"));
    expect(github.length).toBeGreaterThan(0);
    expect(new Set(github.map((s) => s.headers.authorization))).toEqual(new Set(["Bearer page-token"]));
    expect((await w.d.query("select text from notes where item_uid = 'I1' and kind = 'link'")).map((n) => n.text)).toEqual(["#7 · PR 7"]);
  });

  it("is told apart by the branch list's cache, so a new token shows the repo at once", async () => {
    const gh = fakeGitHub({ tips: { main: "m1" } });
    const hidden = (async (url: unknown, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string>)?.authorization;
      return auth === "Bearer page-token" ? gh.impl(url as string, init) : new Response("", { status: 404 });
    }) as Fetch;
    expect((await remoteBranches(w.d, "p", "acme/web", hidden)).visible).toBe(false);
    await put({ name: "github", secret: "page-token", base: null });
    expect((await remoteBranches(w.d, "p", "acme/web", hidden)).visible).toBe(true);
  });
});

describe("a repo connection edited in place", () => {
  it("refuses an edit made where it pointed before someone repointed it", async () => {
    await putConnection(w.d, "p", "acme/web", "hooks", { http: { url: "https://hooks.example", auth: "bearer" } }, "alice");
    await putConnection(w.d, "p", "acme/web", "hooks", { http: { url: "https://hooks2.example", auth: "bearer" } }, "bob", "https://hooks.example");
    await expect(putConnection(w.d, "p", "acme/web", "hooks", { http: { url: "https://hooks3.example" } }, "carol", "https://hooks.example"))
      .rejects.toThrow(PluginConflict);
    const res = await configPUT(req("/api/projects/p/plugins/config", "PUT", w.tokens.bob,
      { repo: "acme/web", connection: { name: "hooks", def: null, base: "https://hooks.example" } }), params("p"));
    expect(res.status).toBe(409);
  });
});

describe("vercel-preview's team and project", () => {
  it("are listed from what the project's Vercel token sees, through its connection", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const f = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization });
      if (String(url).includes("/v2/teams")) return Response.json({ teams: [{ id: "team_b", slug: "beta" }, { id: "team_a", name: "Acme" }] });
      if (String(url).includes("/v9/projects")) return Response.json({ projects: [{ id: "prj_2", name: "web" }, { id: "prj_1", name: "api" }] });
      return new Response("", { status: 404 });
    }) as Fetch;
    expect(await vercelChoices(w.d, "p", "acme/web", null, { fetch: f, lookup: publicDns }))
      .toEqual({ teams: [], projects: [], error: "todo has no Vercel token for this project yet" });
    await put({ name: "vercel", def: VERCEL, secret: "vc-token", base: null });
    expect(await vercelChoices(w.d, "p", "acme/web", "team_a", { fetch: f, lookup: publicDns })).toEqual({
      teams: [{ id: "team_a", name: "Acme" }, { id: "team_b", name: "beta" }], projects: [{ id: "prj_1", name: "api" }, { id: "prj_2", name: "web" }], error: null });
    expect(seen.map((s) => [s.url, s.auth])).toEqual([["https://api.vercel.com/v2/teams?limit=100", "Bearer vc-token"],
                                                    ["https://api.vercel.com/v9/projects?limit=100&teamId=team_a", "Bearer vc-token"]]);
  });
});
