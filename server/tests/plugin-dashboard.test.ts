import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { item, world, type World } from "./helpers";
import { fakeGitHub, params, req } from "./plugin-github";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const act = await import("@/app/plugin-actions");
const { GET: pluginsGET, PUT: pluginsPUT } = await import("@/app/api/projects/[key]/plugins/route");
const { itemButtons, itemNotices, pluginsPage } = await import("@/lib/plugin-views");
const { draftPlugin, editInstance, savedInstances } = await import("@/lib/plugin-form");
const { putGrants } = await import("@/lib/plugins/store");

const FILE = [
  "connections:",
  "  hooks: {http: {url: 'https://hooks.example', auth: bearer}}",
  "plugins:",
  "  note:",
  "    on: [manual]",
  "    settings:",
  "      greeting: {label: Greeting, type: text, default: hi}",
  "      key: {label: Key, type: secret, optional: true}",
  "    steps: [{name: v, value: '`1`'}]",
  "    attach: [{log: '{{settings.greeting}} from {{item.id}}'}]",
  "  ping: {connections: [hooks], on: [push], steps: [{http: {method: GET, path: /}}], attach: []}",
  "  broken: {on: [nope]}",
  "instances:",
  "  note: [{id: go, name: Go, button: Say hi}]",
].join("\n");

let w: World;
beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", "");
  vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "acme/web=hooks.example");
  vi.stubGlobal("fetch", fakeGitHub({ file: FILE }).impl);
  jar.clear();
  jar.set("todo_token", w.tokens.alice);
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
  await w.one("alice", item("I1", { status: "in-progress", extra: { repo: "acme/web", branches: ["feat/x"] } }));
});

describe("the plugins settings page", () => {
  it("lists each repo's plugins with their instances, declared ones, connections and load errors", async () => {
    const page = await pluginsPage(w.d, "p");
    expect(page.ownersSet).toBe(true);
    expect(page.repos.map((r) => [r.repo, r.listed?.by, r.checkout, r.refusal])).toEqual([["acme/web", "alice", false, null]]);
    const [repo] = page.repos;
    expect(repo.plugins.map((p) => [p.name, p.shipped, p.always])).toEqual([["pr-link", true, true], ["note", false, false], ["ping", false, false]]);
    const note = repo.plugins.find((p) => p.name === "note")!;
    expect(note).toMatchObject({ on: ["manual"], declared: { go: { id: "go", name: "Go", button: "Say hi" } }, exclusive: false });
    expect(note.instances[0]).toMatchObject({ id: "go", server_runs: true });
    expect(repo.errors.join("\n")).toContain("plugin broken");
    expect(repo.connections.map((c) => [c.name, c.origin, c.needsSecret, c.held, c.usedBy])).toEqual([
      ["github", "host", true, true, ["pr-link"]], ["hooks", "repo", true, false, ["ping"]]]);
  });

  it("names the plugins file it read from the default branch, the repo's deploy branches and what the file's plugins do", async () => {
    vi.stubGlobal("fetch", fakeGitHub({ file: `track: [staging, main]\n${FILE.replace("  note:\n", "  note:\n    description: Says hi.\n")}` }).impl);
    const [repo] = (await pluginsPage(w.d, "p")).repos;
    expect(repo.source).toEqual({ path: ".todo-plugins/plugins.yaml", branch: "main", exists: true, commit: "s1" });
    expect(repo.track).toEqual(["staging", "main"]);
    expect(repo.plugins.map((p) => [p.name, p.description])).toEqual([
      ["pr-link", "Links each of the item's branches to its pull requests on GitHub."], ["note", "Says hi."], ["ping", null]]);
    expect(repo.offered.map((o) => o.name)).toEqual(["db-request", "jira-issue", "jira-transition", "rest", "vercel-preview", "watchtower-session"]);
    expect(repo.offered.find((o) => o.name === "vercel-preview")).toEqual({
      name: "vercel-preview", description: "Links each of the item's branches to its newest ready Vercel preview.", connections: ["vercel"] });
  });

  it("says a repo has no plugins file, so no deploy branches, and offers every shipped plugin it doesn't run", async () => {
    vi.stubGlobal("fetch", fakeGitHub({}).impl);
    const [repo] = (await pluginsPage(w.d, "p")).repos;
    expect(repo.source).toEqual({ path: ".todo-plugins/plugins.yaml", branch: "main", exists: false, commit: "s1" });
    expect(repo.track).toEqual([]);
    expect(repo.plugins.map((p) => p.name)).toEqual(["pr-link"]);
    expect(repo.offered.map((o) => o.name)).toContain("rest");
    expect(repo.errors).toEqual([]);
  });

  it("says when GitHub doesn't show the repo at all", async () => {
    vi.stubGlobal("fetch", fakeGitHub({}).impl);
    await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/gone', 'alice')");
    const gone = (await pluginsPage(w.d, "p")).repos.find((r) => r.repo === "acme/gone")!;
    expect(gone.source).toEqual({ path: ".todo-plugins/plugins.yaml", branch: null, exists: false, commit: null });
  });

  it("says why a repo gets no plugins", async () => {
    vi.stubEnv("TODO_PLUGIN_OWNERS", "");
    const page = await pluginsPage(w.d, "p");
    expect(page.ownersSet).toBe(false);
    expect(page.repos[0].refusal).toContain("TODO_PLUGIN_OWNERS");
    expect(page.repos[0].plugins).toEqual([]);
  });

  it("shows who granted a capability and when", async () => {
    await putGrants(w.d, "p", "acme/web", "pr-link", ["post-request"], "bob");
    const pr = (await pluginsPage(w.d, "p")).repos[0].plugins.find((p) => p.name === "pr-link")!;
    expect(pr.grant).toMatchObject({ capabilities: ["post-request"], by: "bob" });
    expect(Date.parse(pr.grant!.at)).not.toBeNaN();
  });

  it("saves an edited instance through PUT /plugins and reads it back, a stored secret kept untouched", async () => {
    const put = (instances: unknown) => pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "note", instances }), params("p"));
    expect((await put([{ id: "go", name: "Go", settings: { key: "s3cret" } }, { id: "two", name: "Two" }])).status).toBe(200);
    const load = async () => (await pluginsPage(w.d, "p")).repos[0].plugins.find((p) => p.name === "note")!;
    const note = await load();
    expect(note.instances.map((i) => [i.id, i.settings ?? {}])).toEqual([["go", { key: { set: true } }], ["two", {}]]);
    let draft = draftPlugin(note, note.instances, note.declared);
    draft = editInstance(draft, draft.instances[1].key, { settings: { greeting: "hello", key: { state: "unset" } }, dryRun: true });
    const saved = savedInstances(note, draft);
    expect(saved.errors).toEqual([]);
    expect(saved.instances).toEqual([{ id: "go", name: "Go", settings: { key: { set: true } } },
                                     { id: "two", name: "Two", dry_run: true, settings: { greeting: "hello" } }]);
    expect((await put(saved.instances)).status).toBe(200);
    const again = await load();
    expect(again.instances.map((i) => [i.id, i.button ?? null, i.dry_run ?? false, i.settings])).toEqual([
      ["go", "Say hi", false, { key: { set: true } }], ["two", null, true, { greeting: "hello" }]]);
    const [secret] = await w.d.query("select secrets_enc from plugin_instances where id = 'go'");
    expect(secret.secrets_enc).toBeTruthy();
  });

  it("lists each instance's runs, newest first, with the item and what it attached", async () => {
    const r = await act.runPlugin({ project: "p", itemUid: "I1", plugin: "note", instance: "go" });
    expect(r).toMatchObject({ ok: true, done: true });
    const note = (await pluginsPage(w.d, "p")).repos[0].plugins.find((p) => p.name === "note")!;
    expect(note.runs.go).toHaveLength(1);
    expect(note.runs.go[0]).toMatchObject({ item: { id: "i1", title: "Item I1" }, event: { type: "manual", instance: "go" }, dryRun: false,
                                            attached: [{ kind: "log", text: "hi from i1" }], skipped: null, error: null });
  });
});

describe("connections an instance names", () => {
  it("lists the names each rest instance uses as used, offers the repo's and the server's, and says why a repo-declared one gets no server connection", async () => {
    vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ jira: { http: { url: "https://93.184.216.34" } } }));
    vi.stubGlobal("fetch", fakeGitHub({ file: `${FILE}\n  rest: [{id: r, name: R, settings: {connection: jira, path: /a}}]\n`
      .replace("plugins:\n", "plugins:\n  rest: {use: shipped}\n") }).impl);
    const [repo] = (await pluginsPage(w.d, "p")).repos;
    expect(repo.available).toEqual({ repo: ["hooks"], host: ["github", "jira"] });
    expect(repo.connections.map((c) => [c.name, c.usedBy])).toEqual([["github", ["pr-link"]], ["hooks", ["ping"]], ["jira", ["rest"]]]);
    const rest = repo.plugins.find((p) => p.name === "rest")!;
    expect(rest.instances[0]).toMatchObject({ id: "r", from_repo: true, server_runs: false,
      server_runs_reason: expect.stringContaining("declared in the repo's plugins file") });
  });
});

describe("the repo allowlist", () => {
  it("adds and removes a repo, refusing a name that isn't owner/name", async () => {
    expect((await act.addPluginRepo("p", "Acme/API")).ok).toBe(true);
    expect((await pluginsPage(w.d, "p")).repos.map((r) => r.repo)).toEqual(["acme/api", "acme/web"]);
    expect(await act.addPluginRepo("p", "not a repo")).toMatchObject({ ok: false, message: "not a GitHub owner/name: not a repo" });
    expect((await act.removePluginRepo("p", "acme/web")).ok).toBe(true);
    // An item still names acme/web, so it stays on the page, now one the project can't use.
    expect((await pluginsPage(w.d, "p")).repos.map((r) => [r.repo, !!r.listed, !!r.refusal])).toEqual([["acme/api", true, false], ["acme/web", false, true]]);
  });

  it("keeps a repo a member's checkout reported, as a checkout", async () => {
    await w.d.query("insert into checkouts (project, handle, repo, dir) values ('p', 'bob', 'acme/cli', '/src/cli')");
    expect((await pluginsPage(w.d, "p")).repos.map((r) => [r.repo, !!r.listed, r.checkout])).toEqual([["acme/web", true, false], ["acme/cli", false, true]]);
  });

  it("puts the repos items name and the listed ones first, folds checkout-only ones away, and offers to add an item's repo it can't use", async () => {
    await w.d.query("insert into checkouts (project, handle, repo, dir) values ('p', 'bob', 'acme/cli', '/src/cli'), ('p', 'bob', 'acme/api', '/src/api')");
    await w.one("alice", item("I2", { extra: { repo: "git@github.com:Acme/API.git" } }));
    await w.one("alice", item("I3", { extra: { repo: "acme/docs" } }));
    await w.one("alice", item("I4", { extra: { repo: "other/thing" } }));
    const rows = (await pluginsPage(w.d, "p")).repos.map((r) => [r.repo, r.items, r.folded, r.addable, !!r.refusal]);
    expect(rows).toEqual([
      ["acme/api", 1, false, false, false],
      ["acme/docs", 1, false, true, true],
      ["acme/web", 1, false, false, false],
      ["other/thing", 1, false, false, true],
      ["acme/cli", 0, true, false, false],
    ]);
  });
});

describe("the item page", () => {
  it("offers a button for each enabled manual instance while the item is open", async () => {
    const [it] = await w.d.query("select * from items where uid = 'I1'");
    expect(await itemButtons(w.d, "p", it)).toEqual([{ plugin: "note", instance: "go", label: "Say hi", server: true, reason: null }]);
    expect(await itemButtons(w.d, "p", { ...it, status: "done" })).toEqual([]);
    expect(await itemButtons(w.d, "p", { ...it, extra: { repo: "other/repo" } })).toEqual([]);
  });

  it("runs a manual instance and reports its outcome; refuses one that isn't a button here", async () => {
    const r = await act.runPlugin({ project: "p", itemUid: "I1", plugin: "note", instance: "go" });
    expect(r).toMatchObject({ ok: true, done: true, message: "Say hi: attached 1 log line" });
    const logs = await w.d.query("select text from logs where project = 'p' and item_uid = 'I1'");
    expect(logs.map((l) => l.text)).toContain("hi from i1");
    expect(await act.pluginRun({ project: "p", event: r.event!, label: "Say hi" })).toMatchObject({ done: true, message: "Say hi: attached 1 log line" });
    expect(await act.runPlugin({ project: "p", itemUid: "I1", plugin: "ping", instance: "default" }))
      .toMatchObject({ ok: false, message: "That plugin doesn't run from here." });
  });

  it("reports a dry run's would-send and refuses a CLI-only instance with its reason", async () => {
    await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "note",
      instances: [{ id: "go", name: "Go", dry_run: true }, { id: "need", name: "Need", on: ["manual"], settings: { greeting: "" } }] }), params("p"));
    const r = await act.runPlugin({ project: "p", itemUid: "I1", plugin: "note", instance: "go" });
    expect(r).toMatchObject({ ok: true, done: true, message: "Say hi: dry run: would send 0 calls, attached nothing" });
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "");
    await pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", plugin: "ping",
      instances: [{ id: "p1", name: "P1", on: ["manual"] }] }), params("p"));
    expect(await act.runPlugin({ project: "p", itemUid: "I1", plugin: "ping", instance: "p1" }))
      .toMatchObject({ ok: false, message: "P1 runs in a developer's CLI: `hooks` not authorized here" });
  });

  it("shows one quiet line per plugin whose last run here was skipped or failed, leaving out when-false skips", async () => {
    const add = (plugin: string, instance: string, result: unknown) => w.d.query(
      `insert into plugin_runs (project, item_uid, repo, plugin, instance, event, result, applied, dry_run)
       values ('p', 'I1', 'acme/web', $1, $2, '{"type":"push","branch":"feat/x"}', $3::jsonb, '[]', false)`, [plugin, instance, JSON.stringify(result)]);
    await add("vercel-preview", "default", { attached: [], wouldSend: [], log: [], skipped: "vercel-preview: `vercel` not authorized here" });
    await add("vercel-preview", "other", { attached: [], wouldSend: [], log: [], skipped: "setting project is not set" });
    await add("jira", "default", { attached: [], wouldSend: [], log: [], skipped: "jira: when is false: x" });
    await add("rest", "default", { attached: [], wouldSend: [], log: [], error: "hooks answered 500" });
    await add("pr-link", "default", { attached: [], wouldSend: [], log: [] });
    expect(await itemNotices(w.d, "p", "I1")).toEqual(["rest: failed: hooks answered 500", "vercel-preview: setting project is not set"]);
  });
});

describe("GET /plugins stays as it was", () => {
  it("still answers the CLI", async () => {
    const res = await pluginsGET(req("/api/projects/p/plugins?repo=acme/web", "GET", w.tokens.alice), params("p"));
    expect(res.status).toBe(200);
  });
});
