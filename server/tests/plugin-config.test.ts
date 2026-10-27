// A repo's plugin config as todo stores it: deploy branches, shipped plugins
// switched on, connections and custom plugins, edited through the /plugins
// API and read back by the runner, the CLI and git facts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as configGET, PUT as configPUT } from "@/app/api/projects/[key]/plugins/config/route";
import { DELETE as customDELETE, POST as customPOST, PUT as customPUT } from "@/app/api/projects/[key]/plugins/custom/route";
import { GET as pluginsGET, PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { POST as credentialsPOST } from "@/app/api/projects/[key]/plugins/credentials/route";
import { deployBranches } from "@/lib/gitfacts";
import { branchList, checkCustom, composeConfig } from "@/lib/plugins/config";
import { readConfig } from "@/lib/plugins/host";
import { loadConfig, storedInstances } from "@/lib/plugins/store";
import { world, type World } from "./helpers";
import { params, req } from "./plugin-github";

const NOTES = `description: Links the item to its notes page.
on: [manual]
settings:
  title: {label: Link title, type: text, default: Notes}
attach:
  - link: {type: other, url: "https://notes.example/{{item.id}}", label: "{{settings.title}}"}
`;

describe("composeConfig", () => {
  it("gives the host one map: deploy branches, connections, shipped plugins switched on and custom ones in full", () => {
    const { config, errors } = composeConfig({
      track: ["staging", "main"], shipped: ["vercel-preview"], connections: { hooks: { http: { url: "https://hooks.example", auth: "bearer" } } },
      custom: [{ name: "notes", manifest: NOTES, code: null }, { name: "coded", manifest: "on: [push]\ncode: run.js\n", code: "export function run() {}" }],
    });
    expect(errors).toEqual([]);
    expect(config.code).toEqual({ coded: "export function run() {}" });
    const { file, errors: loadErrors } = readConfig(config);
    expect(loadErrors).toEqual([]);
    expect(file.track).toEqual(["staging", "main"]);
    expect(Object.keys(file.plugins ?? {})).toEqual(["vercel-preview", "notes", "coded"]);
    expect(file.plugins?.["vercel-preview"]).toEqual({ use: "shipped" });
    expect(file.connections).toEqual({ hooks: { http: { url: "https://hooks.example", auth: "bearer" } } });
  });

  it("leaves out a custom plugin whose YAML no longer parses, naming it", () => {
    const { config, errors } = composeConfig({ track: [], shipped: [], connections: {}, custom: [{ name: "bad", manifest: "on: [unclosed", code: null }] });
    expect(errors).toEqual([expect.stringMatching(/^plugin bad: its YAML doesn't parse: /)]);
    expect(readConfig(config).file.plugins).toBeUndefined();
  });
});

describe("branchList", () => {
  it("trims, drops blanks and repeats, and refuses what git wouldn't take", () => {
    expect(branchList([" staging", "main", "", "main", "release/2026"])).toEqual(["staging", "main", "release/2026"]);
    expect(() => branchList(["has space"])).toThrow("not a branch name: has space");
    expect(() => branchList(["a..b", "-x"])).toThrow("not a branch name: a..b, -x");
    expect(() => branchList("main")).toThrow("deploy branches are a list of branch names");
  });
});

describe("checkCustom", () => {
  const ctx = { reserved: ["pr-link", "rest", "notes"], connections: ["hooks"] };

  it("passes a clean manifest, warning about a connection the repo doesn't declare", () => {
    const out = checkCustom({ name: "ping", manifest: "connections: [hooks, other, github]\non: [push]\nsteps: [{connection: hooks, http: {method: GET, path: /}}]\n", code: null }, ctx);
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual(["it calls other, which isn't one of this repo's connections yet"]);
    expect(out.def).toMatchObject({ on: ["push"] });
  });

  it("names every problem load.ts finds, and the ones only a stored plugin has", () => {
    expect(checkCustom({ name: "", manifest: "", code: null }, ctx).errors).toEqual(["give the plugin a name"]);
    expect(checkCustom({ name: "9lives", manifest: "", code: null }, ctx).errors).toEqual(["a name starts with a letter and has only letters, digits, - and _"]);
    expect(checkCustom({ name: "rest", manifest: "on: [push]", code: null }, ctx).errors)
      .toEqual(["rest is taken: a plugin ships with todo or this repo has one by that name"]);
    expect(checkCustom({ name: "x", manifest: "on: [unclosed", code: null }, ctx).errors).toEqual([expect.stringMatching(/^the YAML doesn't parse: /)]);
    expect(checkCustom({ name: "x", manifest: "- a\n- b\n", code: null }, ctx).errors).toEqual(["the YAML is a map of the plugin's keys: description, on, steps…"]);
    expect(checkCustom({ name: "x", manifest: "use: shipped\n", code: null }, ctx).errors)
      .toEqual(["a custom plugin is defined here in full; a plugin that ships with todo is switched on with its own switch"]);
    expect(checkCustom({ name: "x", manifest: "on: [sometimes]\nwat: 1\n", code: null }, ctx).errors)
      .toEqual(['unknown key "wat"', 'on[0]: unknown trigger "sometimes"']);
    expect(checkCustom({ name: "x", manifest: "on: [push]\ncode: run.js\n", code: null }, ctx).errors).toEqual(["code names run.js: paste that file's code"]);
    expect(checkCustom({ name: "x", manifest: "on: [push]\n", code: "export function run() {}" }, ctx).errors)
      .toEqual(["the YAML names no code: file, so this code would never run"]);
    expect(checkCustom({ name: "x", manifest: "on: [push]\ncapabilities: [post-request]\n", code: null }, ctx).errors)
      .toEqual(["only plugins shipped with todo may declare post-request"]);
  });
});

describe("the config API", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
    vi.unstubAllEnvs();
    vi.stubEnv("GITHUB_TOKEN", "gh-token");
    vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
    vi.stubEnv("TODO_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ watchtower: { http: { url: "https://wt.example" } } }));
    await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
  });
  const put = async (body: Record<string, unknown>, who = "alice") =>
    configPUT(req("/api/projects/p/plugins/config", "PUT", w.tokens[who], { repo: "acme/web", ...body }), params("p"));
  const custom = (method: "PUT" | "POST" | "DELETE", body: Record<string, unknown>) =>
    (method === "PUT" ? customPUT : method === "POST" ? customPOST : customDELETE)(req("/api/projects/p/plugins/custom", method, w.tokens.alice, { repo: "acme/web", ...body }), params("p"));
  const listed = async () => (await (await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.bob), params("p"))).json());

  it("starts empty, and sets the deploy branches that git facts read", async () => {
    expect(await (await configGET(req("/api/projects/p/plugins/config?repo=acme/web", "GET", w.tokens.bob), params("p"))).json())
      .toEqual({ track: [], shipped: [], connections: {}, custom: [], updated: null });
    const res = await put({ track: ["staging", " main"] });
    expect(res.status).toBe(200);
    expect((await res.json()).config).toMatchObject({ track: ["staging", "main"], updated: { by: "alice" } });
    expect(await deployBranches(w.d, "p", "acme/web")).toEqual(["staging", "main"]);
    expect((await listed()).track).toEqual(["staging", "main"]);
    expect(await (await put({ track: ["no good"] })).json()).toEqual({ error: "not a branch name: no good", errors: ["not a branch name: no good"] });
    expect((await put({ track: [] })).status).toBe(200);
    expect(await deployBranches(w.d, "p", "acme/web")).toEqual([]);
  });

  it("keeps a project's config apart from another project's for the same repo", async () => {
    await w.d.query("insert into projects (key) values ('q')");
    await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('q', 'acme/web', 'alice')");
    await put({ track: ["main"] });
    expect(await deployBranches(w.d, "q", "acme/web")).toEqual([]);
  });

  it("switches a shipped plugin on and off, keeping its instances, and refuses unknown and always-on ones", async () => {
    expect((await listed()).plugins.map((p: { name: string }) => p.name)).toEqual(["pr-link"]);
    expect((await put({ enable: "vercel-preview" })).status).toBe(200);
    expect((await put({ enable: "vercel-preview" })).status).toBe(200);
    expect((await loadConfig(w.d, "p", "acme/web")).shipped).toEqual(["vercel-preview"]);
    const inst = [{ id: "web", name: "Web", settings: { project: "prj_1", team: "team_1" } }];
    expect((await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "vercel-preview", instances: inst }), params("p"))).status).toBe(200);
    expect((await listed()).plugins.map((p: { name: string }) => p.name)).toEqual(["pr-link", "vercel-preview"]);
    await put({ disable: "vercel-preview" });
    expect((await listed()).plugins.map((p: { name: string }) => p.name)).toEqual(["pr-link"]);
    expect((await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "vercel-preview", instances: inst }), params("p"))).status).toBe(400);
    await put({ enable: "vercel-preview" });
    expect((await listed()).instances["vercel-preview"]).toEqual(inst);
    expect(await (await put({ enable: "nope" })).json()).toMatchObject({ error: "no plugin named nope ships with todo" });
    expect(await (await put({ disable: "pr-link" })).json()).toMatchObject({ error: "pr-link is on for every repo; switch its instance off in its settings instead" });
  });

  it("declares and drops connections, forgetting a dropped one's credential, and never takes a command", async () => {
    expect((await put({ connection: { name: "hooks", def: { http: { url: "https://hooks.example", auth: "bearer" } } } })).status).toBe(200);
    await credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, { repo: "acme/web", connection: "hooks", secret: "s3" }), params("p"));
    expect((await listed()).secrets).toEqual(["hooks"]);
    expect((await loadConfig(w.d, "p", "acme/web")).connections).toEqual({ hooks: { http: { url: "https://hooks.example", auth: "bearer" } } });
    expect(await (await put({ connection: { name: "local", def: { mcp: { command: "node", args: ["x.js"] } } } })).json())
      .toMatchObject({ error: "connection local: give an MCP server's URL; the server never starts a command" });
    expect(await (await put({ connection: { name: "bad", def: { ftp: {} } } })).json()).toMatchObject({ error: "connection bad: is http or mcp" });
    expect(await (await put({ connection: { name: "item", def: { http: { url: "https://x" } } } })).json())
      .toMatchObject({ error: 'connection item: the name "item" is taken by the plugin\'s run() argument' });
    expect((await put({ connection: { name: "hooks" } })).status).toBe(400);
    await put({ connection: { name: "hooks", def: null } });
    expect((await loadConfig(w.d, "p", "acme/web")).connections).toEqual({});
    expect((await listed()).secrets).toEqual([]);
  });

  it("forgets a connection's credential when its endpoint changes, and refuses the server's own names", async () => {
    const hooks = (url: string) => put({ connection: { name: "hooks", def: { http: { url, auth: "bearer" } } } });
    await hooks("https://hooks.example");
    await credentialsPOST(req("/api/projects/p/plugins/credentials", "POST", w.tokens.alice, { repo: "acme/web", connection: "hooks", secret: "s3" }), params("p"));
    await hooks("https://hooks.example");
    expect((await listed()).secrets).toEqual(["hooks"]);
    await hooks("https://elsewhere.example");
    expect((await listed()).secrets).toEqual([]);
    for (const name of ["github", "watchtower"]) {
      expect(await (await put({ connection: { name, def: { http: { url: "https://x.example" } } } })).json()).toMatchObject({
        error: `connection ${name}: this server has its own ${name}, which plugins that ship with todo use; give the repo's another name` });
    }
    expect((await put({ connection: { name: "toString", def: { http: { url: "https://x.example" } } } })).status).toBe(400);
  });

  it("refuses names every object inherits, for a shipped plugin or a custom one", async () => {
    expect(await (await put({ enable: "toString" })).json()).toMatchObject({ error: "no plugin named toString ships with todo" });
    expect(await (await custom("PUT", { name: "constructor", manifest: "on: [manual]\n" })).json())
      .toMatchObject({ errors: ["constructor can't be a plugin's name"] });
    expect((await listed()).plugins.map((p: { name: string }) => p.name)).toEqual(["pr-link"]);
  });

  it("adds, checks, renames and removes a custom plugin, its instances following it", async () => {
    const check = await (await custom("POST", { name: "notes", manifest: "on: [manual]\nwat: 1\n" })).json();
    expect(check).toEqual({ errors: ['unknown key "wat"'], warnings: [] });
    const bad = await custom("PUT", { name: "notes", manifest: "on: [manual]\nwat: 1\n" });
    expect([bad.status, await bad.json()]).toEqual([400, { error: 'unknown key "wat"', errors: ['unknown key "wat"'] }]);
    expect(await (await custom("PUT", { name: "notes", manifest: NOTES })).json()).toEqual({ ok: true, warnings: [] });
    const view = await listed();
    expect(view.plugins.map((p: { name: string; shipped: boolean }) => [p.name, p.shipped])).toEqual([["pr-link", true], ["notes", false]]);
    expect(view.config.text).toContain("notes:");
    await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "notes", instances: [{ id: "go", name: "Go", button: "Notes" }] }), params("p"));
    expect(await (await custom("PUT", { name: "pr-link", manifest: NOTES })).json())
      .toMatchObject({ errors: ["pr-link is taken: a plugin ships with todo or this repo has one by that name"] });
    expect(await (await custom("PUT", { name: "notes-link", manifest: NOTES, was: "notes" })).json()).toMatchObject({ ok: true });
    expect((await loadConfig(w.d, "p", "acme/web")).custom.map((c) => c.name)).toEqual(["notes-link"]);
    expect((await listed()).instances).toEqual({ "notes-link": [{ id: "go", name: "Go", button: "Notes", settings: {} }] });
    expect(await (await custom("PUT", { name: "x", manifest: NOTES, was: "gone" })).json()).toMatchObject({ error: "no custom plugin named gone in acme/web" });
    expect((await custom("DELETE", { name: "notes-link" })).status).toBe(200);
    expect(await listed()).toMatchObject({ instances: {}, config: { code: {} } });
    expect((await listed()).plugins.map((p: { name: string }) => p.name)).toEqual(["pr-link"]);
    expect(await (await custom("DELETE", { name: "notes-link" })).json()).toEqual({ error: "no custom plugin named notes-link in acme/web" });
  });

  it("keeps an instance's secret setting readable when its custom plugin is renamed", async () => {
    const manifest = "on: [manual]\nsettings: {token: {label: Token, type: secret}}\nattach: [{log: hi}]\n";
    await custom("PUT", { name: "keyed", manifest });
    await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "keyed", instances: [{ id: "a", name: "A", settings: { token: "s3cret" } }] }), params("p"));
    expect(await (await custom("PUT", { name: "renamed", manifest, was: "keyed" })).json()).toMatchObject({ ok: true });
    expect((await storedInstances(w.d, "p", "acme/web", { secrets: true })).renamed).toEqual([{ id: "a", name: "A", settings: { token: "s3cret" } }]);
  });

  it("stores a code plugin's module and hands it to the CLI by plugin name", async () => {
    const code = "export function run({ attach }) { attach.log('hi'); }";
    expect(await (await custom("PUT", { name: "coded", manifest: "on: [manual]\ncode: run.js\n", code })).json()).toMatchObject({ ok: true });
    expect((await listed()).config.code).toEqual({ coded: code });
  });

  it("says a custom plugin calling a server connection runs nowhere until the repo declares its own", async () => {
    await custom("PUT", { name: "wt", manifest: "connections: [watchtower]\non: [manual]\nsteps: [{http: {method: GET, path: /}}]\n" });
    const [inst] = (await listed()).plugins.find((p: { name: string }) => p.name === "wt").instances;
    expect(inst).toMatchObject({ id: "default", server_runs: false,
      server_runs_reason: "`watchtower` is this host's connection, which only plugins shipped with todo use; declare a connection named watchtower in the repo's plugin config" });
  });

  it("refuses a repo the project doesn't use", async () => {
    const res = await configPUT(req("/api/projects/p/plugins/config", "PUT", w.tokens.alice, { repo: "acme/other", track: ["main"] }), params("p"));
    expect(res.status).toBe(404);
  });
});
