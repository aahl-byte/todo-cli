// What a hostile or broken plugin can't do to the host: crash it, flood it,
// redirect its calls, reach outside its endpoint, or leak its secrets.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { openConnection } from "@/lib/plugins/connections";
import { runInstance, type HostDeps } from "@/lib/plugins/host";
import { CodeSlots, hostCodeSlots, REPO_CODE_DEADLINE_MS } from "@/lib/plugins/code-runner";
import { loadPlugins, PluginsFileError } from "@/lib/plugins/load";
import { fillUrl, lookup } from "@/lib/plugins/template";
import { search } from "@/lib/plugins/expr";
import {
  DEFAULT_DEADLINE_MS, MAX_ATTACHMENTS, MAX_ERROR, MAX_LOG_LINE, MAX_LOG_LINES, MAX_WOULD_SEND, MAX_WOULD_SEND_BYTES, MAX_WOULD_SEND_INPUT,
  type PluginDef, type PluginItem, type ResolvedConnection, type RunInput,
} from "@/lib/plugins/types";
import { fakeServer, type FakeServer, type Recorded } from "./plugin-fakes";

const ITEM: PluginItem = { id: "fix-login", uid: "U1", title: "Fix login", status: "todo", branches: ["feat/x"], links: [] };
const fast: HostDeps = { sleep: async () => {} };
const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
async function serve(responses: Recorded[]) {
  const s = await fakeServer(responses);
  servers.push(s);
  return s;
}

function run(over: Partial<RunInput>, deps: HostDeps = fast) {
  return runInstance({ plugin: { code: "p.js" }, name: "p", instance: { id: "i", name: "d" }, item: ITEM, event: { type: "refresh" },
                       connections: {}, dryRun: false, ...over }, deps);
}

/** A code plugin with one http connection, wt, at a server answering {"ok":1}. */
async function runWithWt(code: string, over: Partial<RunInput> = {}, deps: HostDeps = fast) {
  const server = await serve([{ method: "GET", path: "/x", body: { ok: 1 } }, { method: "GET", path: "/y", body: { ok: 2 } }]);
  return run({ plugin: { code: "p.js", connections: ["wt"] }, code, connections: { wt: { kind: "http", url: server.url } }, ...over }, deps);
}

const noHostDetail = (s: string | undefined) => {
  expect(s).toBeDefined();
  expect(s).not.toMatch(/node_modules|\/mnt\/|file:\/\/|\n\s+at /);
};

describe("a code plugin can't take the host down", () => {
  it("keeps host calls working when the plugin replaces JSON", async () => {
    const r = await runWithWt(`export async function run({ wt, attach }) {
      JSON.stringify = () => ({ toString() { wt.get("/y"); return "{}"; } });
      JSON.parse = () => ({ hijacked: true });
      const got = await wt.get("/x");
      attach.log("ok " + got.ok);
    }`);
    expect(r.error).toBeUndefined();
    expect(r.attached).toEqual([{ kind: "log", key: "log:ok 1", text: "ok 1" }]);
  });

  it("makes a host call after an await", async () => {
    const r = await runWithWt(`export async function run({ wt, attach }) {
      await null;
      const a = await wt.get("/x");
      await Promise.resolve();
      const b = await wt.get("/y");
      attach.log(a.ok + "," + b.ok);
    }`);
    expect(r.attached.map((a) => (a as { text: string }).text)).toEqual(["1,2"]);
  });

  it("reports a sandbox that dies as the run's error, without host paths or stacks", async () => {
    const r = await run({ code: "export function run() {}" },
                        { ...fast, workerUrl: new URL("./fixtures/plugins/crash-worker.mjs", import.meta.url) });
    expect(r.error).toMatch(/^the plugin sandbox stopped: /);
    noHostDetail(r.error);
  });

  it("caps a huge thrown value", async () => {
    const r = await run({ code: "export function run() { throw 'x'.repeat(20 * 1024 * 1024); }" });
    expect(r.error!.length).toBeLessThanOrEqual(MAX_ERROR);
  });
});

describe("a run's output is capped", () => {
  it("fails a run that attaches too many items", async () => {
    const r = await run({ code: "export function run({ attach }) { for (let i = 0; i < 1500; i++) attach.log('line ' + i); }" });
    expect(r).toMatchObject({ attached: [], error: `the run attached more than ${MAX_ATTACHMENTS} items` });
  });

  it("fails a run whose fields or total size are too big", async () => {
    const huge = await run({ code: "export function run({ attach }) { attach.doc({ name: 'd', content: 'x'.repeat(1100 * 1024) }); }" });
    expect(huge.error).toBe("a doc's content is longer than 1 MB");
    const label = await run({ code: "export function run({ attach }) { attach.link({ type: 'pr', url: 'https://x/1', label: 'x'.repeat(9000) }); }" });
    expect(label.error).toBe("a link's label is longer than 8 KB");
    const total = await run({ code: "export function run({ attach }) { const big = 'x'.repeat(1000 * 1024); for (let i = 0; i < 5; i++) attach.doc({ name: 'd' + i, content: big }); }" });
    expect(total).toMatchObject({ attached: [], error: "the run's attachments add up to more than 4 MB" });
  });

  it("keeps the first wouldSend entries and log lines, truncated", async () => {
    const r = await runWithWt(`export async function run({ wt }) {
      const body = "x".repeat(3000);
      for (let i = 0; i < 250; i++) await wt.post("/p/" + "y".repeat(5000), body);
    }`, { dryRun: true });
    expect(r.error).toBeUndefined();
    expect(r.wouldSend).toHaveLength(MAX_WOULD_SEND);
    expect(String(r.wouldSend[0].input).length).toBeLessThanOrEqual(MAX_WOULD_SEND_INPUT);
    expect(r.wouldSend.every((c) => c.path!.length <= MAX_WOULD_SEND_INPUT)).toBe(true);
    expect(JSON.stringify(r.wouldSend).length).toBeLessThanOrEqual(MAX_WOULD_SEND_BYTES);
    expect(r.log).toHaveLength(MAX_LOG_LINES);
    expect(r.log.every((l) => l.length <= MAX_LOG_LINE)).toBe(true);
  });
});

describe("plugin grants and sources", () => {
  const requester: PluginDef = { capabilities: ["post-request"], attach: [{ request: "new request" }, { log: "ran" }] };

  it("keeps a request only when the plugin declares post-request and the host grants it", async () => {
    const granted = await run({ plugin: requester, shipped: true, grants: ["post-request"] });
    expect(granted.attached.map((a) => a.kind)).toEqual(["request", "log"]);
    expect((await run({ plugin: requester, grants: ["post-request"] })).error).toBe("plugin p: only plugins shipped with todo may declare post-request");
    const ungranted = await run({ plugin: requester, shipped: true });
    expect(ungranted.attached.map((a) => a.kind)).toEqual(["log"]);
    expect(ungranted.log).toEqual(["dropped a request: p hasn't been granted post-request"]);
  });

  it("refuses a plugin whose use: wasn't resolved", async () => {
    expect((await run({ plugin: { use: "shipped" } as PluginDef })).error).toBe("plugin p: use: shipped must be resolved before it runs");
  });

  it("gives a run five minutes by default", () => {
    expect(DEFAULT_DEADLINE_MS).toBe(5 * 60_000);
  });

  it("refuses a repo connection that runs a command unless the host allows it", async () => {
    const plugin: PluginDef = { connections: ["db"], steps: [{ tool: "x" }] };
    const repo: ResolvedConnection = { kind: "mcp", command: "touch", args: ["/tmp/pwned"], origin: "repo" };
    expect((await run({ plugin, connections: { db: repo } })).skipped)
      .toBe("p: `db` runs a command, which this host doesn't allow for repo connections");
    expect((await run({ plugin, connections: { db: { ...repo, origin: undefined } } })).skipped).toMatch(/runs a command/);
  });

  it("skips a connection that declares auth but has no secret", async () => {
    const r = await run({ plugin: { connections: ["gh"], steps: [{ http: { method: "GET", path: "/" } }] },
                          connections: { gh: { kind: "http", url: "http://127.0.0.1:9", auth: "bearer" } } });
    expect(r.skipped).toBe("p: `gh` not authorized here");
  });
});

describe("templates can't reshape a call", () => {
  it("rejects a template inside a quoted string in an expression", () => {
    for (const expr of ["contains(item.labels, '{{item.title}}')", 'item.status == "x{{item.title}}"', "a == `{{item.title}}`"]) {
      expect(() => loadPlugins(`plugins: {x: {when: ${JSON.stringify(expr)}, attach: [{log: x}]}}`))
        .toThrow("plugin x: when: {{item.title}} sits inside a quoted string");
    }
    expect(() => loadPlugins(`plugins: {x: {when: "contains(item.labels, {{item.title}}) && a == 'b'", attach: [{log: x}]}}`)).not.toThrow();
    const load = (when: string) => () => loadPlugins(`plugins:\n  x:\n    when: ${JSON.stringify(when)}\n    attach: [{log: x}]\n`);
    expect(load("contains(item.labels, '\\{{item.title}}')")).toThrow("sits inside a quoted string");
    expect(load('item.x == "\\{{item.title}}"')).toThrow("sits inside a quoted string");
    expect(load("item.x == `\\{{item.title}}`")).toThrow("sits inside a quoted string");
    expect(load("item.x == '\\'' || '{{item.title}}'")).toThrow("sits inside a quoted string");
    expect(load("item.x == '\\\\' && {{item.title}} == 'a'")).not.toThrow();
    expect(load("`\"a\"` == {{item.title}}")).not.toThrow();
  });

  it("round-trips hostile values through expression literals", () => {
    for (const v of ["a`b", "\\`", "a\\", "`) || `true", "  ", "x' || true || '", '"', "\\u0060", "é😀", "\\\\`", "`\\"]) {
      expect(search("{{v}}", { v })).toBe(v);
    }
  });

  it("refuses a path value with a . or .. part, and encodes any other slash", () => {
    for (const v of [".", "..", "%2e%2e", "%252e%252e", "../x", "a/../b", "a/.", "..\\x"]) {
      expect(() => fillUrl("/repos/{{v}}/pulls", { v }), v).toThrow(/would change the path/);
    }
    expect(() => fillUrl("/x/{{a}}{{b}}", { a: ".", b: "." })).toThrow(/would change the path/);
    expect(fillUrl("/compare/main...{{b}}", { b: "feat/x" })).toBe("/compare/main...feat%2Fx");
    expect(fillUrl("/i/{{v}}/t", { v: "a\\b" })).toBe("/i/a%5Cb/t");
    expect(fillUrl("/x/{{a}}.json?q={{b}}", { a: "v1", b: "c/d" })).toBe("/x/v1.json?q=c%2Fd");
  });

  it("reads only the scope's own properties", () => {
    expect(lookup({ item: {} }, "item.constructor")).toBeUndefined();
    expect(lookup({ item: { a: 1 } }, "item.__proto__")).toBeUndefined();
    const errors = (yaml: string) => { try { loadPlugins(yaml); return []; } catch (e) { return (e as PluginsFileError).errors; } };
    expect(errors(`plugins: {x: {steps: [{name: __proto__, value: "a"}, {name: constructor, value: "a"}, {name: prototype, value: "a"}]}}`))
      .toEqual(['plugin x: steps[0]: step name "__proto__" is taken by the scope', 'plugin x: steps[1]: step name "constructor" is taken by the scope',
                'plugin x: steps[2]: step name "prototype" is taken by the scope']);
    expect(errors(`
connections: {item: {http: {url: "http://x"}}}
plugins: {x: {connections: [wait], attach: [{log: x}]}}`)).toEqual([
      'connection item: the name "item" is taken by the plugin\'s run() argument',
      'plugin x: connection name "wait" is taken by the plugin\'s run() argument']);
  });
});

describe("connections stay on their endpoint", () => {
  it("never follows a redirect", async () => {
    const evil = await serve([{ method: "POST", path: "/stolen", body: {} }]);
    const good = createServer((req, res) => { res.writeHead(307, { location: `${evil.url}/stolen` }).end(); });
    await new Promise<void>((done) => good.listen(0, "127.0.0.1", done));
    try {
      const c = openConnection("c", { kind: "http", url: `http://127.0.0.1:${(good.address() as AddressInfo).port}`, auth: "bearer", secret: "S3CRET" });
      await expect(c.send({ connection: "c", method: "POST", path: "/redirect", input: { a: 1 } }))
        .rejects.toMatchObject({ message: "c: POST /redirect answered 307, a redirect, which isn't followed", status: 307 });
      expect(evil.received).toEqual([]);
    } finally {
      good.closeAllConnections();
      good.close();
    }
  });

  it("keeps a secret an answer echoes back out of the error", async () => {
    const server = await serve([{ method: "GET", path: "/echo", status: 400, text: "you sent Bearer S3CRET" }]);
    await expect(openConnection("c", { kind: "http", url: server.url, auth: "bearer", secret: "S3CRET" }).send({ connection: "c", method: "GET", path: "/echo" }))
      .rejects.toThrow("c: GET /echo answered 400: you sent Bearer ***");
  });

  it("refuses tool calls on an http connection", async () => {
    await expect(openConnection("c", { kind: "http", url: "http://127.0.0.1:9" }).send({ connection: "c", tool: "x" }))
      .rejects.toThrow("c: an http connection takes method calls, not the tool x");
  });

  it("bounds the dry-run read-only check by the deadline and pages of tools", async () => {
    let pages = 0;
    const endless = () => {
      const s = new Server({ name: "endless", version: "1" }, { capabilities: { tools: {} } });
      s.setRequestHandler(ListToolsRequestSchema, async () => { pages++; return { tools: [], nextCursor: String(pages) }; });
      return s;
    };
    const t = Date.now();
    const r = await run({ plugin: { connections: ["m"], steps: [{ tool: "x" }] }, connections: { m: { kind: "mcp", url: "http://unused" } },
                          dryRun: true, limits: { deadlineMs: 2000 } },
                        { mcpTransport: () => { const [c, s] = InMemoryTransport.createLinkedPair(); void endless().connect(s); return c; } });
    expect(Date.now() - t).toBeLessThan(3000);
    expect(pages).toBeLessThanOrEqual(20);
    expect(r.wouldSend).toEqual([{ connection: "m", tool: "x", input: {} }]);
  });

  it("redacts secrets from errors, log lines and wouldSend", async () => {
    const server = await serve([{ method: "GET", path: "/echo", status: 400, text: "bad token S3CRET-TOKEN" }]);
    const conn: ResolvedConnection = { kind: "http", url: server.url, auth: "bearer", secret: "S3CRET-TOKEN" };
    const plugin: PluginDef = { connections: ["api"], settings: { key: { label: "Key", type: "secret" } },
      steps: [{ name: "a", http: { method: "POST", path: "/hook/{{settings.key}}", body: { key: "{{settings.key}}" } } },
              { http: { method: "GET", path: "/echo" } }] };
    const r = await run({ plugin, connections: { api: conn }, dryRun: true, instance: { id: "i", name: "d", settings: { key: "hunter2" } } });
    expect(r.wouldSend).toEqual([{ connection: "api", method: "POST", path: "/hook/***", input: { key: "***" } }]);
    expect(r.log).toEqual(["would send api POST /hook/***"]);
    expect(r.error).toBe("api: GET /echo answered 400: bad token ***");
  });
});

describe("a plugin's thrown values are read safely", () => {
  it("reads a thrown object's hostile getters inside the sandbox", async () => {
    const r = await runWithWt(`export async function run({ wt }) {
      Object.defineProperty(Error.prototype, "toJSON", { value() { wt.get("/x"); return {}; } });
      throw { get name() { wt.get("/y"); return "Odd"; }, get message() { wt.get("/x"); return "from a getter"; } };
    }`);
    expect(r.error).toBe("Odd: from a getter");
    const unreadable = await runWithWt("export function run() { throw { get message() { throw new Error('no'); } }; }");
    expect(unreadable.error).toBe("the plugin threw something that can't be read");
  });

  it("allows no import but the plugin itself", async () => {
    const r = await run({ code: "import * as os from 'os'; export function run() {}" });
    expect(r.error).toMatch(/os can't be imported in a plugin/);
  });
});

describe("secrets stay out of everything a run returns", () => {
  it("masks secret settings in attachments", async () => {
    const r = await run({ plugin: { settings: { tok: { label: "Token", type: "secret" } }, attach: [{ log: "token is {{settings.tok}}" }] },
                          instance: { id: "i", name: "d", settings: { tok: "SUPERSECRET" } } });
    expect(r.attached).toEqual([{ kind: "log", key: "log:token is ***", text: "token is ***" }]);
  });
});

describe("the sandbox's limits", () => {
  it("reports a stack overflow as QuickJS's own error, in a worker and inline", async () => {
    const code = "export function run() { const f = () => f() + 1; f(); }";
    for (const isolation of ["worker", "inline"] as const) {
      expect((await run({ code }, { ...fast, isolation })).error, isolation).toBe("InternalError: stack overflow");
    }
  });

  it("runs at most the host's limit of code plugins at once, queued runs keeping their deadline", async () => {
    let inFlight = 0, peak = 0;
    const slow = createServer(async (_req, res) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((done) => setTimeout(done, 150));
      inFlight--;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((done) => slow.listen(0, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
      const pool = new CodeSlots(2, 2);
      const one = (deadlineMs = 30_000) => run({ plugin: { code: "p.js", connections: ["wt"] }, connections: { wt: { kind: "http", url } },
        code: "export async function run({ wt, attach }) { await wt.get('/'); attach.log('done'); }", limits: { deadlineMs } }, { ...fast, codeSlots: pool });
      const rs = await Promise.all(Array.from({ length: 6 }, () => one()));
      expect(rs.map((r) => r.error ?? "ok")).toEqual(Array(6).fill("ok"));
      expect(peak).toBe(2);
      const [, , late] = await Promise.all([one(), one(), one(100)]);
      expect(late.error).toBe("the run passed its deadline waiting for a free sandbox");
    } finally {
      slow.closeAllConnections();
      slow.close();
    }
  });
});

describe("code-run slots are shared fairly", () => {
  it("keeps one repo's looping plugins from blocking another repo", async () => {
    const pool = new CodeSlots(4, 2);
    const loop = (repoKey: string) => run({ code: "export function run() { for (;;) {} }", repoKey, limits: { deadlineMs: 1500 } }, { ...fast, codeSlots: pool });
    const started = Date.now();
    const a = Array.from({ length: 4 }, () => loop("acme/a"));
    const b = await run({ code: "export function run({ attach }) { attach.log('b ran'); }", repoKey: "acme/b" }, { ...fast, codeSlots: pool });
    expect(b.attached.map((x) => (x as { text: string }).text)).toEqual(["b ran"]);
    expect(Date.now() - started).toBeLessThan(1000);
    for (const r of await Promise.all(a)) expect(r.error).toMatch(/^the run passed its deadline/);
  });

  it("gives repo code plugins a minute and shipped ones five", async () => {
    const asked: number[] = [];
    const sleep = async (ms: number) => { asked.push(ms); };
    const code = "export async function run({ wait }) { await wait.until(() => false, { every: '10m', timeout: '1h' }).catch(() => {}); }";
    await run({ code }, { sleep });
    await run({ code, shipped: true }, { sleep });
    expect(REPO_CODE_DEADLINE_MS).toBe(60_000);
    expect(asked[0]).toBeGreaterThan(55_000);
    expect(asked[0]).toBeLessThanOrEqual(60_000);
    expect(asked[1]).toBeGreaterThan(295_000);
  });

  it("has one host-wide pool", () => {
    expect(hostCodeSlots()).toBe(hostCodeSlots());
    expect([hostCodeSlots().total, hostCodeSlots().perRepo]).toEqual([4, 2]);
  });
});
