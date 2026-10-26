// What the host gives the shipped plugins beyond plain steps: the tracked
// branches in scope, docs fetched through a connection, request templates held
// in settings, a connection an instance names, and retries with growing waits.
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "@/lib/plugins/load";
import { runInstance, wouldSkip } from "@/lib/plugins/host";
import type { InstanceDef, PluginEvent, PluginItem, ResolvedConnection, RunInput } from "@/lib/plugins/types";
import { fakeServer, type FakeServer, type Recorded } from "./plugin-fakes";

const ITEM: PluginItem = {
  id: "fix-login", uid: "U1", title: 'Fix "login"', type: "bug", status: "in-progress", priority: "high",
  repo: "o/r", repo_owner: "o", repo_name: "r", branches: ["feat/x"], jira: ["SR-1"], app: null,
  section: null, developer: "alice", qa_assignee: null, dir: "/src/r", links: [],
};

const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(responses: Recorded[]) {
  const s = await fakeServer(responses);
  servers.push(s);
  return s;
}

async function run(yaml: string, responses: Recorded[], over: Partial<RunInput> & { instance?: InstanceDef } = {}) {
  const file = loadPlugins(yaml);
  const [name, plugin] = Object.entries(file.plugins!)[0];
  const server = await serve(responses);
  const connections: Record<string, ResolvedConnection> = over.connections ?? { api: { kind: "http", url: server.url } };
  const result = await runInstance({
    plugin, name, instance: { id: "i1", name: "default" }, item: ITEM, event: { type: "manual", instance: "i1" } as PluginEvent,
    dryRun: false, ...over, connections,
  });
  return { result, server };
}

describe("the tracked branches in scope", () => {
  it("fills {{track.0}} from the repo's track list, and leaves it out when there is none", async () => {
    const yaml = `plugins:\n  p:\n    on: [manual]\n    attach:\n      - edge: {needs: "https://gh/o/m/pull/5", in: "{{track.0}}", because: x}\n`;
    const tracked = await run(yaml, [], { track: ["staging", "main"] });
    expect(tracked.result.attached).toEqual([
      { kind: "edge", key: "edge:https://gh/o/m/pull/5 in staging", needs: "https://gh/o/m/pull/5", in: "staging", because: "x" }]);
    const bare = await run(yaml, []);
    expect(bare.result.attached).toEqual([{ kind: "edge", key: "edge:https://gh/o/m/pull/5", needs: "https://gh/o/m/pull/5", because: "x" }]);
  });

  it("refuses a step named track", () => {
    expect(() => loadPlugins(`plugins:\n  p:\n    steps: [{name: track, value: "item.id"}]\n`)).toThrow(/step name "track" is taken/);
  });
});

describe("docs fetched through a connection", () => {
  const DOCS = `plugins:
  p:
    connections: [api]
    on: [manual]
    attach:
      - doc: {name: shot.png, url: "/files/1?redirect=false"}
      - doc: {name: notes.md, url: "{{settings.base}}/files/2"}
      - doc: {name: elsewhere.md, url: "https://elsewhere.example/files/3"}
    settings:
      base: {label: Base, type: text, optional: true}
`;

  it("fetches a relative url, or one under the connection's url, with its credentials; another host's url is left out", async () => {
    const server = await serve([
      { method: "GET", path: "/files/1?redirect=false", text: "fake png" },
      { method: "GET", path: "/files/2", text: "# Notes\n" },
    ]);
    const { result } = await run(DOCS, [], {
      connections: { api: { kind: "http", url: server.url, auth: "bearer", secret: "tok" } },
      instance: { id: "i1", name: "d", settings: { base: server.url } },
    });
    expect(result.error).toBeUndefined();
    expect(result.attached).toEqual([
      { kind: "doc", key: "doc:shot.png", name: "shot.png", url: "/files/1?redirect=false", content: "fake png" },
      { kind: "doc", key: "doc:notes.md", name: "notes.md", url: `${server.url}/files/2`, content: "# Notes\n" },
    ]);
    expect(result.log).toEqual(["skipped doc elsewhere.md: https://elsewhere.example/files/3 isn't under a connection of the plugin"]);
    expect(server.received.map((r) => [r.path, r.headers.authorization])).toEqual([
      ["/files/1?redirect=false", "Bearer tok"], ["/files/2", "Bearer tok"]]);
  });

  it("keeps the bytes exactly when they aren't text", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x10]);
    const yaml = `plugins:\n  p:\n    connections: [api]\n    on: [manual]\n    attach:\n      - doc: {name: a.png, url: /a}\n`;
    const server = await serveBytes(bytes);
    const { result } = await run(yaml, [], { connections: { api: { kind: "http", url: server } } });
    const [doc] = result.attached as { content: string; encoding: string }[];
    expect([doc.encoding, Buffer.from(doc.content, "base64").equals(bytes)]).toEqual(["base64", true]);
  });

  it("refuses a redirect, and skips a doc past the size cap", async () => {
    const yaml = `plugins:\n  p:\n    connections: [api]\n    on: [manual]\n    attach:\n      - doc: {name: a.png, url: /a}\n`;
    const redirected = await run(yaml, [{ method: "GET", path: "/a", status: 303, text: "" }]);
    expect(redirected.result.error).toMatch(/answered 303, a redirect, which isn't followed/);
    const big = await run(yaml, [{ method: "GET", path: "/a", text: "x".repeat(1024 * 1024 + 1) }]);
    expect(big.result.error).toBeUndefined();
    expect(big.result.attached).toEqual([]);
    expect(big.result.log).toEqual(["skipped doc a.png: it's larger than 1 MB"]);
  });

  it("refuses a doc url that would leave its path", async () => {
    const yaml = `plugins:\n  p:\n    connections: [api]\n    on: [manual]\n    attach:\n      - doc: {name: a.md, url: "/files/{{item.title}}/../../admin"}\n`;
    const { result, server } = await run(yaml, []);
    expect(result.attached).toEqual([]);
    expect(result.log[0]).toMatch(/^skipped doc a.md: .* would change the path$/);
    expect(server.received).toEqual([]);
  });

  it("checks a doc's address with the guard", async () => {
    const yaml = `plugins:\n  p:\n    connections: [api]\n    on: [manual]\n    attach:\n      - doc: {name: a.md, url: /a}\n`;
    const server = await serve([{ method: "GET", path: "/a", text: "hi" }]);
    const result = await runInstance({
      plugin: loadPlugins(yaml).plugins!.p, name: "p", instance: { id: "i1", name: "d" }, item: ITEM,
      event: { type: "manual", instance: "i1" }, dryRun: false, connections: { api: { kind: "http", url: server.url, origin: "repo" } },
    }, { guard: { allow: ["127.0.0.1"], repoAllow: [] } });
    expect(result.error).toMatch(/isn't an address this host connects to/);
    expect(server.received).toEqual([]);
  });
});

async function serveBytes(bytes: Buffer): Promise<string> {
  const { createServer } = await import("node:http");
  const srv = createServer((_req, res) => res.writeHead(200, { "content-type": "image/png" }).end(bytes));
  await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
  servers.push({ url: "", received: [], close: () => new Promise((done) => { srv.closeAllConnections(); srv.close(() => done()); }) });
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

const REST = `plugins:
  rest:
    connections: ["{{settings.connection}}"]
    on: [manual]
    settings:
      connection: {label: Connection, type: text}
      method:  {label: Method, type: choice, options: [GET, POST, PUT, PATCH, DELETE], default: POST}
      path:    {label: Path, type: text, template: true}
      headers: {label: Headers, type: long-text, optional: true, template: true}
      body:    {label: JSON body, type: long-text, optional: true, template: true}
      text:    {label: Text body, type: long-text, optional: true, template: true}
    steps:
      - when: "!(settings.text)"
        http: {method: "{{settings.method}}", path: "{{settings.path}}", headers: "{{settings.headers}}", body: "{{settings.body}}"}
      - when: "settings.text"
        http: {method: "{{settings.method}}", path: "{{settings.path}}", headers: "{{settings.headers}}", text: "{{settings.text}}"}
`;

describe("request templates held in settings", () => {
  const inst = (settings: Record<string, unknown>): InstanceDef => ({ id: "i1", name: "d", settings: { connection: "hooks", ...settings } });

  it("fills a template setting where the step uses it: the path URL-encoded, headers as text, the body as JSON", async () => {
    const server = await serve([{ method: "POST", path: "/notify/fix-login?title=Fix%20%22login%22&x=1", body: { ok: true } }]);
    const { result } = await run(REST, [], {
      connections: { hooks: { kind: "http", url: server.url } },
      instance: inst({ path: "/notify/{{item.id}}?title={{item.title}}&x=1", headers: "X-Item: {{item.id}}\nX-Fixed: yes",
                       body: { text: "{{item.title}}", branches: "{{item.branches}}" } }),
    });
    expect(result.error).toBeUndefined();
    expect(server.received).toEqual([expect.objectContaining({
      method: "POST", path: "/notify/fix-login?title=Fix%20%22login%22&x=1", body: { text: 'Fix "login"', branches: ["feat/x"] },
      headers: expect.objectContaining({ "x-item": "fix-login", "x-fixed": "yes", "content-type": "application/json" }),
    })]);
  });

  it("sends a text body as it is, and records headers and text in dry-run", async () => {
    const server = await serve([{ method: "PUT", path: "/t", body: {} }]);
    const instance = inst({ method: "PUT", path: "/t", headers: { "Content-Type": "text/csv" }, text: "{{item.id}},{{item.status}}" });
    const live = await run(REST, [], { connections: { hooks: { kind: "http", url: server.url } }, instance });
    expect(live.result.error).toBeUndefined();
    expect(server.received.map((r) => [r.body, r.headers["content-type"]])).toEqual([["fix-login,in-progress", "text/csv"]]);
    const dry = await run(REST, [], { connections: { hooks: { kind: "http", url: server.url } }, instance, dryRun: true });
    expect(dry.result.wouldSend).toEqual([
      { connection: "hooks", method: "PUT", path: "/t", headers: { "content-type": "text/csv" }, text: "fix-login,in-progress" }]);
  });

  it("fails a path that doesn't start with /, a method that isn't one, and a header that breaks its line", async () => {
    const connections = { hooks: { kind: "http" as const, url: "http://127.0.0.1:9" } };
    const bad = async (settings: Record<string, unknown>, item: Partial<PluginItem> = {}) =>
      (await run(REST, [], { connections, instance: inst(settings), item: { ...ITEM, ...item } })).result.error;
    expect(await bad({ path: "@evil.example/x" })).toBe("setting path must start with /");
    expect(await bad({ path: "/x", method: "{{item.title}}" })).toBe('http method "FIX \\"LOGIN\\"" isn\'t one of GET, HEAD, POST, PUT, PATCH, DELETE');
    expect(await bad({ path: "/x", headers: "X-A: {{item.title}}" }, { title: "a\r\nHost: evil" })).toBe("header X-A would hold a line break");
    expect(await bad({ path: "/x", headers: "Host: evil" })).toBe("header Host can't be set by a plugin");
    expect(await bad({ path: "/x", headers: "not a header" })).toBe('headers: "not a header" isn\'t Name: value');
  });

  it("takes the connection an instance names, never one an item fills in", async () => {
    const def = loadPlugins(REST).plugins!.rest;
    const connections: Record<string, ResolvedConnection> = { hooks: { kind: "http", url: "http://127.0.0.1:9" } };
    expect(wouldSkip({ plugin: def, instance: inst({ path: "/x" }), connections })).toBeUndefined();
    expect(wouldSkip({ plugin: def, instance: inst({ connection: "other", path: "/x" }), connections })).toBe("`other` not authorized here");
    expect(wouldSkip({ plugin: def, instance: inst({ connection: "{{item.repo}}", path: "/x" }), connections }))
      .toBe("setting connection must name a connection, not a template");
    expect(wouldSkip({ plugin: def, instance: { id: "i1", name: "d", settings: { path: "/x" } }, connections })).toBe("setting connection is not set");
  });

  it("refuses a templated connection outside a settings reference, or in a code plugin", () => {
    expect(() => loadPlugins(`plugins:\n  p:\n    connections: ["{{item.repo}}"]\n`)).toThrow(/connections: "\{\{item.repo\}\}" must be a name or exactly \{\{settings.<key>\}\}/);
    expect(() => loadPlugins(`plugins:\n  p:\n    connections: ["{{settings.c}}"]\n    settings: {c: {label: C, type: text}}\n    code: p.js\n`))
      .toThrow(/a code plugin names its connections/);
  });
});

describe("code plugins' retries", () => {
  it("waits each listed duration in turn, then the last again", async () => {
    const slept: number[] = [];
    const code = `export async function run({ attach, wait }) {
      let n = 0;
      try { await wait.retry(() => { n++; throw new Error("no"); }, { attempts: 5, every: ["1s", "2s", "3s"] }); }
      catch (e) { attach.log("tried " + n); }
    }`;
    const result = await runInstance({ plugin: { code: "p.js" }, name: "p", code, instance: { id: "i", name: "d" }, item: ITEM,
                                       event: { type: "refresh" }, connections: {}, dryRun: false },
                                     { isolation: "inline", sleep: async (ms) => { slept.push(ms); } });
    expect(result.attached.map((a) => (a as { text: string }).text)).toEqual(["tried 5"]);
    expect(slept).toEqual([1000, 2000, 3000, 3000]);
  });
});
