import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins, PluginsFileError } from "@/lib/plugins/load";
import { runInstance } from "@/lib/plugins/host";
import { openConnection } from "@/lib/plugins/connections";
import { parseDuration, pickInstances } from "@/lib/plugins/triggers";
import type { InstanceDef, PluginDef, PluginEvent, PluginItem, ResolvedConnection, RunInput } from "@/lib/plugins/types";
import { fakeMcp, fakeServer, type FakeServer, type Recorded } from "./plugin-fakes";
import { fillExpr, fillJson, fillString, fillUrl, lookup, templateErrors } from "@/lib/plugins/template";
import { search, test as holds, truthy } from "@/lib/plugins/expr";

const scope = {
  item: { id: "fix-login", priority: 3, branches: ["feat/x", "feat/y"], links: [{ type: "pr", url: "https://x/1" }] },
  branch: "feat/x' || true || '",
  settings: { to: "Won't Do", never: ["Done"], flag: false, path: "a\\b`c" },
};

describe("plugin templates", () => {
  it("resolves dotted paths, list indexes included, and misses as undefined", () => {
    expect(lookup(scope, "item.id")).toBe("fix-login");
    expect(lookup(scope, "item.branches.1")).toBe("feat/y");
    expect(lookup(scope, "item.links.0.url")).toBe("https://x/1");
    expect(lookup(scope, "item.nope.deeper")).toBeUndefined();
  });

  it("keeps a lone template's type in json mode and stringifies inside longer strings", () => {
    expect(fillJson({ a: "{{item.priority}}", b: "#{{item.priority}} {{item.id}}", c: ["{{item.branches}}"], d: "{{missing}}", e: 7 }, scope))
      .toEqual({ a: 3, b: "#3 fix-login", c: [["feat/x", "feat/y"]], d: null, e: 7 });
    expect(fillJson(" {{ item.id }} ", scope)).toBe(" fix-login ");
    expect(fillString("x{{missing}}y{{settings.never}}", scope)).toBe('xy["Done"]');
  });

  it("URL-encodes each filled value in url mode", () => {
    expect(fillUrl("/repos/{{item.id}}/compare/main...{{branch}}", { item: { id: "a b" }, branch: "feat/x?y" }))
      .toBe("/repos/a%20b/compare/main...feat%2Fx%3Fy");
    expect(fillUrl("/x/{{missing}}", {})).toBe("/x/");
  });

  it("fills expressions with quoted literals that stay strings", () => {
    expect(holds("branch == {{branch}}", scope)).toBe(true);
    expect(search("{{branch}}", scope)).toBe("feat/x' || true || '");
    expect(holds("{{branch}} == 'feat/x'", scope)).toBe(false);
    expect(search("{{settings.path}}", scope)).toBe("a\\b`c");
    expect(search("{{settings.to}}", scope)).toBe("Won't Do");
    expect(search("{{item.priority}}", scope)).toBe("3");
    expect(fillExpr("a == {{missing}}", scope)).toBe("a == `\"\"`");
  });

  it("refuses anything but a dotted path inside braces", () => {
    expect(templateErrors("{{item.id}} and {{ branch }}")).toEqual([]);
    expect(templateErrors({ a: ["{{item.id || 'x'}}"], b: "{{}}" })).toEqual([
      "{{item.id || 'x'}} is not a path", "{{}} is not a path"]);
    expect(templateErrors("{{a}} {{b")).toEqual(["unclosed {{ in \"{{a}} {{b\""]);
  });
});

describe("plugin expressions", () => {
  it("follows JMESPath truthiness", () => {
    for (const v of [[], {}, "", false, null, undefined]) expect(truthy(v)).toBe(false);
    for (const v of [[0], { a: 1 }, "x", true, 0]) expect(truthy(v)).toBe(true);
  });

  it("evaluates over the scope", () => {
    expect(holds("!contains(settings.never, settings.to)", scope)).toBe(true);
    expect(holds("settings.flag", scope)).toBe(false);
    expect(search("item.links[?type=='pr'].url | [0]", scope)).toBe("https://x/1");
  });
});

const ITEM: PluginItem = {
  id: "fix-login", uid: "U1", title: "Fix login", type: "bug", status: "in-progress", priority: "high",
  repo: "o/r", repo_owner: "o", repo_name: "r", branches: ["feat/x", "feat/y"], jira: ["SR-1"], app: null,
  section: null, developer: "alice", qa_assignee: null, dir: "/src/r", links: [],
};

const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function serve(responses: Recorded[]) {
  const s = await fakeServer(responses);
  servers.push(s);
  return s;
}

/** Run the one plugin in a plugins.yaml body against recorded HTTP responses. */
async function runYaml(yaml: string, responses: Recorded[], over: Partial<RunInput> = {}) {
  const file = loadPlugins(yaml);
  const [name, plugin] = Object.entries(file.plugins!)[0];
  const server = await serve(responses);
  const connections: Record<string, ResolvedConnection> = {};
  for (const c of plugin.connections ?? []) connections[c] = { kind: "http", url: server.url };
  const result = await runInstance({
    plugin, name, instance: { id: "i1", name: "default" }, item: ITEM,
    event: { type: "push", branch: "feat/x" } as PluginEvent, connections, dryRun: false, ...over,
  });
  return { result, server };
}

const PR_LINK = `
plugins:
  pr-link:
    connections: [github]
    on: [push, pr]
    per: branch
    steps:
      - name: prs
        http:
          method: GET
          path: "/repos/{{item.repo_owner}}/{{item.repo_name}}/pulls"
          query: {head: "{{item.repo_owner}}:{{branch}}", state: all}
    attach:
      - each: prs
        link: {type: pr, url: "{{each.html_url}}", label: "#{{each.number}} · {{each.title}}"}
`;

describe("YAML plugins", () => {
  it("runs once per branch with {{branch}} set", async () => {
    const { result, server } = await runYaml(PR_LINK, [
      { method: "GET", path: "/repos/o/r/pulls?head=o%3Afeat%2Fx&state=all", body: [{ html_url: "https://gh/o/r/pull/1", number: 1, title: "X" }] },
      { method: "GET", path: "/repos/o/r/pulls?head=o%3Afeat%2Fy&state=all", body: [] },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.attached).toEqual([
      { kind: "link", key: "link:https://gh/o/r/pull/1", type: "pr", url: "https://gh/o/r/pull/1", label: "#1 · X" }]);
    expect(server.received.map((r) => r.path)).toEqual([
      "/repos/o/r/pulls?head=o%3Afeat%2Fx&state=all", "/repos/o/r/pulls?head=o%3Afeat%2Fy&state=all"]);
  });

  it("skips a run, a step or an attachment whose when is false", async () => {
    const { result, server } = await runYaml(`
plugins:
  gated:
    connections: [api]
    per: branch
    when: "branch != 'feat/y'"
    steps:
      - {name: never, when: "item.status == 'done'", http: {method: GET, path: /never}}
      - {name: one, http: {method: GET, path: "/one/{{branch}}"}}
    attach:
      - {when: never, log: "never ran"}
      - {when: "one.ok", log: "one ok on {{branch}}"}
      - {each: one.list, when: "each.keep", key: "k-{{each.n}}", log: {text: "kept {{each.n}}"}}
`, [{ method: "GET", path: "/one/feat%2Fx", body: { ok: true, list: [{ n: 1, keep: true }, { n: 2, keep: false }] } }]);
    expect(server.received.map((r) => r.path)).toEqual(["/one/feat%2Fx"]);
    expect(result.attached).toEqual([
      { kind: "log", key: "log:one ok on feat/x", text: "one ok on feat/x" },
      { kind: "log", key: "k-1", text: "kept 1" },
    ]);
  });

  it("reports a run skipped when its when is false on every pass", async () => {
    const { result } = await runYaml(`
plugins:
  off:
    when: "item.status == 'done'"
    attach: [{log: "x"}]
`, []);
    expect(result).toMatchObject({ attached: [], skipped: "off: when is false: item.status == 'done'" });
  });

  it("hands named results to later steps and attachments", async () => {
    const { result, server } = await runYaml(`
plugins:
  chain:
    connections: [api]
    steps:
      - name: list
        http: {method: GET, path: /list}
      - name: pick
        value: "list.items[?name=={{item.developer}}] | [0]"
      - name: detail
        when: pick
        http: {method: GET, path: "/detail/{{pick.id}}", query: {n: "{{pick.n}}"}}
      - name: empty
        http: {method: GET, path: /empty}
    attach:
      - doc: {name: "{{pick.name}}.json", content: "{{detail}}"}
      - {when: "!empty", log: "empty result kept going"}
`, [
      { method: "GET", path: "/list", body: { items: [{ name: "bob", id: "b" }, { name: "alice", id: "a/1", n: 2 }] } },
      { method: "GET", path: "/detail/a%2F1?n=2", body: { deep: true } },
      { method: "GET", path: "/empty", body: [] },
    ]);
    expect(result.error).toBeUndefined();
    expect(server.received.map((r) => r.path)).toEqual(["/list", "/detail/a%2F1?n=2", "/empty"]);
    expect(result.attached).toEqual([
      { kind: "doc", key: "doc:alice.json", name: "alice.json", content: '{\n  "deep": true\n}' },
      { kind: "log", key: "log:empty result kept going", text: "empty result kept going" },
    ]);
  });

  it("keeps a hostile branch name a string inside expressions", async () => {
    const { result } = await runYaml(`
plugins:
  inject:
    per: branch
    steps:
      - {name: same, value: "{{branch}}"}
    attach:
      - {when: "{{branch}} == 'main'", log: "injected"}
      - {when: "same == {{branch}}", log: "{{same}}"}
`, [], { item: { ...ITEM, branches: ["x' || true || '"] } });
    expect(result.attached).toEqual([{ kind: "log", key: "log:x' || true || '", text: "x' || true || '" }]);
  });

  it("records a POST in dry-run and still sends the GET", async () => {
    const { result, server } = await runYaml(`
plugins:
  poster:
    connections: [api]
    steps:
      - {name: got, http: {method: GET, path: /state}}
      - {name: posted, http: {method: POST, path: "/notes/{{item.id}}", body: {text: "{{got.text}}", n: "{{got.n}}"}}}
    attach:
      - {when: "!posted", log: "nothing posted"}
`, [{ method: "GET", path: "/state", body: { text: "hi", n: 4 } }], { dryRun: true });
    expect(server.received.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /state"]);
    expect(result.wouldSend).toEqual([{ connection: "api", method: "POST", path: "/notes/fix-login", input: { text: "hi", n: 4 } }]);
    expect(result.attached).toEqual([{ kind: "log", key: "log:nothing posted", text: "nothing posted" }]);
  });

  it("drops everything gathered when a call fails", async () => {
    const { result } = await runYaml(PR_LINK, [
      { method: "GET", path: "/repos/o/r/pulls?head=o%3Afeat%2Fx&state=all", body: [{ html_url: "https://gh/1", number: 1, title: "X" }] },
      { method: "GET", path: "/repos/o/r/pulls?head=o%3Afeat%2Fy&state=all", status: 502, text: "bad gateway" },
    ]);
    expect(result.attached).toEqual([]);
    expect(result.error).toBe("branch feat/y: github: GET /repos/o/r/pulls?head=o%3Afeat%2Fy&state=all answered 502: bad gateway");
  });

  it("needs a connection named on each call step when it has several", async () => {
    const { result } = await runYaml(`
plugins:
  two:
    connections: [a, b]
    steps:
      - {name: x, connection: b, http: {method: GET, path: /x}}
    attach:
      - {log: "{{x.v}}"}
`, [{ method: "GET", path: "/x", body: { v: "from b" } }]);
    expect(result.attached).toEqual([{ kind: "log", key: "log:from b", text: "from b" }]);
    expect(() => loadPlugins(`
plugins:
  two:
    connections: [a, b]
    steps: [{http: {method: GET, path: /x}}]
`)).toThrow("plugin two: steps[0]: name its connection, the plugin has several");
  });

  it("skips a plugin whose connection this host lacks", async () => {
    const file = loadPlugins(PR_LINK);
    const result = await runInstance({ plugin: file.plugins!["pr-link"], name: "pr-link", instance: { id: "i", name: "d" },
      item: ITEM, event: { type: "push", branch: "feat/x" }, connections: {}, dryRun: false });
    expect(result).toEqual({ attached: [], wouldSend: [], log: [], skipped: "pr-link: `github` not authorized here" });
  });

  it("reports bad plugins at load, with the plugin's name", () => {
    const errors = (yaml: string) => {
      try { loadPlugins(yaml); return []; } catch (e) { return (e as PluginsFileError).errors; }
    };
    expect(errors(`
plugins:
  bad:
    connections: [api]
    until: x
    steps:
      - {http: {method: GET, path: /x}, value: "a"}
      - {name: t, tool: "x", input: {a: "{{item.id | upper}}"}}
    attach:
      - {link: {type: pr}}
`)).toEqual([
      'plugin bad: unknown key "until"',
      "plugin bad: steps[0]: a step is exactly one of tool, http or value",
      "plugin bad: steps[1]: {{item.id | upper}} is not a path",
      "plugin bad: attach[0]: link needs url",
    ]);
    expect(errors(`plugins: {x: {code: a.js, steps: []}}`)).toEqual(["plugin x: a code plugin has no per, steps or attach"]);
    expect(errors(`plugins: {x: {attach: [{request: "r"}]}}`)).toEqual(["plugin x: attach[0]: request needs the post-request capability"]);
    expect(errors(`plugins: {x: {capabilities: [post-request], attach: [{request: "r"}]}}`))
      .toEqual(["plugin x: only plugins shipped with todo may declare post-request"]);
    expect(errors(`plugins: {x: {when: "a ==", attach: []}}`)[0]).toMatch(/^plugin x: bad expression "a =="/);
  });

  it("fills settings from defaults and instance values", async () => {
    const { result } = await runYaml(`
plugins:
  s:
    settings:
      prompt: {label: Prompt, type: long-text, default: "/todo {{item.id}}"}
      dir: {label: Folder, type: text, default: "{{item.dir}}"}
      model: {label: Model, type: choice, options: [opus, sonnet], optional: true}
    attach:
      - {log: "{{settings.prompt}} in {{settings.dir}} as {{settings.model}}"}
`, [], { instance: { id: "i", name: "d", settings: { model: "opus" } } });
    expect(result.attached).toEqual([{ kind: "log", key: "log:/todo fix-login in /src/r as opus", text: "/todo fix-login in /src/r as opus" }]);
    const missing = await runYaml(`
plugins:
  s:
    settings: {project: {label: Project, type: text}}
    attach: [{log: x}]
`, []);
    expect(missing.result.skipped).toBe("s: setting project is not set");
  });

  it("parses a whole plugins.yaml", () => {
    const file = loadPlugins(`
track: [staging, main]
connections:
  github: {http: {url: "https://api.github.com", auth: bearer}}
  db: {mcp: {command: node, args: [srv.js]}}
plugins:
  p: {connections: [github], on: [push, {status: {from: "*", to: review}}], every: 15m, attach: [{log: x}]}
instances:
  p: [{id: a, name: A}, {id: b, name: B, enabled: false, on: [manual]}]
`);
    expect(file.track).toEqual(["staging", "main"]);
    expect(file.instances!.p.map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("connections", () => {
  it("sends JSON over HTTP with the secret in the right header", async () => {
    const server = await serve([{ method: "POST", path: "/a?x=1", body: { ok: 1 } }, { method: "GET", path: "/b", text: "" }]);
    const auths: [ResolvedConnection, string, string][] = [
      [{ kind: "http", url: `${server.url}/`, auth: "bearer", secret: "t0k" }, "authorization", "Bearer t0k"],
      [{ kind: "http", url: server.url, auth: "basic", secret: "me:pw" }, "authorization", `Basic ${Buffer.from("me:pw").toString("base64")}`],
      [{ kind: "http", url: server.url, auth: "header:X-Api-Key", secret: "k" }, "x-api-key", "k"],
    ];
    for (const [conn, header, value] of auths) {
      const c = openConnection("api", conn);
      expect(await c.send({ connection: "api", method: "POST", path: "/a?x=1", input: { n: 1 } })).toEqual({ ok: 1 });
      const got = server.received.at(-1)!;
      expect(got.headers[header]).toBe(value);
      expect(got.headers["content-type"]).toBe("application/json");
      expect(got.body).toEqual({ n: 1 });
    }
    expect(await openConnection("api", { kind: "http", url: server.url }).send({ connection: "api", method: "GET", path: "/b" })).toBeNull();
    expect(server.received.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("fails a non-2xx answer with its status and the start of its body, and a slow one on the timeout", async () => {
    const server = await serve([
      { method: "GET", path: "/gone", status: 404, text: "x".repeat(400) },
      { method: "GET", path: "/slow", delayMs: 300, body: {} },
    ]);
    const c = openConnection("api", { kind: "http", url: server.url }, { timeoutMs: 50 });
    await expect(c.send({ connection: "api", method: "GET", path: "/gone" })).rejects.toThrow(`api: GET /gone answered 404: ${"x".repeat(300)}`);
    await expect(c.send({ connection: "api", method: "GET", path: "/slow" })).rejects.toThrow(/^api: GET \/slow failed: /);
    expect(await c.isReadOnly({ connection: "api", method: "HEAD", path: "/" })).toBe(true);
    expect(await c.isReadOnly({ connection: "api", method: "DELETE", path: "/" })).toBe(false);
  });

  it("calls MCP tools and reads their structured content, JSON text or plain text", async () => {
    const mcp = fakeMcp([
      { name: "structured", readOnly: true, results: [{ content: [{ type: "text", text: "ignored" }], structuredContent: { a: 1 } }] },
      { name: "json", readOnly: false, results: [{ content: [{ type: "text", text: '{"b":2}' }] }] },
      { name: "plain", results: [{ content: [{ type: "text", text: "hello" }] }] },
      { name: "broken", results: [{ content: [{ type: "text", text: "no such issue" }], isError: true }] },
    ]);
    const c = openConnection("jira", { kind: "mcp", command: "unused" }, { mcpTransport: () => mcp.transport() });
    try {
      expect(await c.send({ connection: "jira", tool: "structured", input: { q: 1 } })).toEqual({ a: 1 });
      expect(await c.send({ connection: "jira", tool: "json" })).toEqual({ b: 2 });
      expect(await c.send({ connection: "jira", tool: "plain" })).toBe("hello");
      await expect(c.send({ connection: "jira", tool: "broken" })).rejects.toThrow("jira: broken: no such issue");
      expect(mcp.calls[0]).toEqual({ tool: "structured", input: { q: 1 } });
      expect(await c.isReadOnly({ connection: "jira", tool: "structured" })).toBe(true);
      expect(await c.isReadOnly({ connection: "jira", tool: "json" })).toBe(false);
      expect(await c.isReadOnly({ connection: "jira", tool: "plain" })).toBe(false);
    } finally {
      await c.close();
    }
  });

  it("lets read-only MCP tools through in dry-run and records the rest", async () => {
    const mcp = fakeMcp([
      { name: "getTransitions", readOnly: true, results: [{ structuredContent: { transitions: [{ id: "31", to: { name: "Won't Do" } }] } }] },
      { name: "transition", results: [{ content: [{ type: "text", text: "{}" }] }] },
    ]);
    const file = loadPlugins(`
plugins:
  jira-transition:
    connections: [jira]
    per: jira
    when: "!contains(settings.never, settings.to)"
    settings:
      to: {label: Jira status, type: choice}
      never: {label: Never move to, type: list, scope: plugin}
    steps:
      - {name: transitions, tool: getTransitions, input: {issueIdOrKey: "{{issue}}"}}
      - {name: transition, value: "transitions.transitions[?to.name=={{settings.to}}] | [0]"}
      - {when: transition, tool: transition, input: {issueIdOrKey: "{{issue}}", transition: {id: "{{transition.id}}"}}}
`);
    const result = await runInstance({
      plugin: file.plugins!["jira-transition"], name: "jira-transition", item: { ...ITEM, jira: ["SR-1", "SR-2"] },
      instance: { id: "j", name: "Won't do", settings: { to: "Won't Do" } }, event: { type: "status", from: "todo", to: "cancelled" },
      connections: { jira: { kind: "mcp", url: "http://unused" } }, dryRun: true,
    }, { mcpTransport: () => mcp.transport() });
    expect(result.error).toBeUndefined();
    expect(mcp.calls.map((c) => c.tool)).toEqual(["getTransitions", "getTransitions"]);
    expect(result.wouldSend).toEqual([
      { connection: "jira", tool: "transition", input: { issueIdOrKey: "SR-1", transition: { id: "31" } } },
      { connection: "jira", tool: "transition", input: { issueIdOrKey: "SR-2", transition: { id: "31" } } },
    ]);
  });
});

const FIXTURES = path.join(import.meta.dirname, "fixtures/plugins");
const WATCHTOWER = loadPlugins(readFileSync(path.join(FIXTURES, "watchtower.yaml"), "utf8"));
const WATCHTOWER_JS = readFileSync(path.join(FIXTURES, "watchtower-session.js"), "utf8");
const NAME = "todo: fix-login";
const fast = { sleep: async () => {} };

async function watchtower(instanceId: string, responses: Recorded[]) {
  const server = await serve(responses);
  const instance = WATCHTOWER.instances!["watchtower-session"].find((i) => i.id === instanceId)!;
  const result = await runInstance({
    plugin: WATCHTOWER.plugins!["watchtower-session"], name: "watchtower-session", code: WATCHTOWER_JS, instance, item: ITEM,
    event: { type: "manual", instance: instanceId }, connections: { watchtower: { kind: "http", url: server.url } }, dryRun: false,
  }, fast);
  return { result, sent: server.received.filter((r) => r.method !== "GET").map((r) => [r.method, r.path, r.body]) };
}

/** Run a code plugin with no connections. */
function runJs(code: string, over: Partial<RunInput> = {}) {
  return runInstance({ plugin: { code: "p.js" }, name: "p", code, instance: { id: "i", name: "d" }, item: ITEM,
                       event: { type: "refresh" }, connections: {}, dryRun: false, ...over }, fast);
}

describe("code plugins", () => {
  it("sends to a live session, retrying while its input isn't visible", async () => {
    const { result, sent } = await watchtower("start", [
      { method: "GET", path: "/api/roster", body: { sessions: [
        { id: "old", name: NAME, state: "stopped" }, { id: "s1", name: NAME, state: "active", managed: true }] } },
      { method: "POST", path: "/api/sessions/s1/message", status: 409, text: '{"error":"input isn\'t visible yet"}' },
      { method: "POST", path: "/api/sessions/s1/message", body: { delivered: "typed" } },
    ]);
    expect(result).toEqual({ attached: [{ kind: "log", key: `log:sent to Watchtower session ${NAME}: s1`, text: `sent to Watchtower session ${NAME}: s1` }],
                             wouldSend: [], log: [] });
    expect(sent).toEqual([
      ["POST", "/api/sessions/s1/message", { text: "/todo fix-login", from: "todo" }],
      ["POST", "/api/sessions/s1/message", { text: "/todo fix-login", from: "todo" }],
    ]);
  });

  it("resumes the newest stopped session and waits for it to go idle", async () => {
    const { result, sent } = await watchtower("review", [
      { method: "GET", path: "/api/roster", body: { sessions: [
        { id: "s0", name: NAME, state: "stopped", lastActivity: 1 }, { id: "s2", name: NAME, state: "stopped", lastActivity: 5 }] } },
      { method: "POST", path: "/api/sessions/s2/resume", body: {} },
      { method: "GET", path: "/api/sessions/s2", body: { state: "stopped", status: "starting" } },
      { method: "GET", path: "/api/sessions/s2", body: { state: "active", status: "busy" } },
      { method: "GET", path: "/api/sessions/s2", body: { state: "active", status: "idle" } },
      { method: "POST", path: "/api/sessions/s2/message", body: {} },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.attached.map((a) => (a as { text: string }).text)).toEqual([`resumed Watchtower session ${NAME}: s2`]);
    expect(sent).toEqual([
      ["POST", "/api/sessions/s2/resume", undefined],
      ["POST", "/api/sessions/s2/message", { text: "/review fix-login again", from: "todo" }],
    ]);
  });

  it("starts a new session when none is live or resumable", async () => {
    const { result, sent } = await watchtower("start", [
      { method: "GET", path: "/api/roster", body: { sessions: [{ id: "x", name: "todo: other", state: "active", managed: true }] } },
      { method: "POST", path: "/api/sessions", body: { id: "s9" } },
      { method: "GET", path: "/api/sessions/s9", body: { state: "active", status: "idle" } },
      { method: "POST", path: "/api/sessions/s9/message", body: {} },
    ]);
    expect(result.attached.map((a) => (a as { text: string }).text)).toEqual([`started Watchtower session ${NAME}: s9`]);
    expect(sent).toEqual([
      ["POST", "/api/sessions", { dir: "/src/r", name: NAME }],
      ["POST", "/api/sessions/s9/message", { text: "/todo fix-login", from: "todo" }],
    ]);
  });

  it("errors when the session is waiting on a person, keeping nothing", async () => {
    const { result, sent } = await watchtower("review", [
      { method: "GET", path: "/api/roster", body: { sessions: [{ id: "s2", name: NAME, state: "stopped", lastActivity: 5 }] } },
      { method: "POST", path: "/api/sessions/s2/resume", body: {} },
      { method: "GET", path: "/api/sessions/s2", body: { state: "active", status: "waiting", waitingFor: "a permission prompt" } },
    ]);
    expect(result).toEqual({ attached: [], wouldSend: [], log: [], error: "session is waiting on a permission prompt" });
    expect(sent).toEqual([["POST", "/api/sessions/s2/resume", undefined]]);
  });

  it("stops a plugin that loops forever at the deadline", async () => {
    const t = Date.now();
    const spin = await runJs("export function run() { for (;;) {} }", { limits: { deadlineMs: 200 } });
    expect(spin.error).toBe("the run passed its deadline");
    const waits = await runInstance({ plugin: { code: "p.js" }, name: "p", instance: { id: "i", name: "d" }, item: ITEM, event: { type: "refresh" },
      connections: {}, dryRun: false, limits: { deadlineMs: 200 },
      code: "export async function run({ wait }) { for (;;) { try { await wait.until(() => false, { every: '20ms', timeout: '1h' }); } catch {} } }" });
    expect(waits.error).toBe("the run passed its deadline");
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  it("keeps the sandbox free of I/O and its inputs read-only", async () => {
    const r = await runJs(`export async function run({ item, attach }) {
      attach.log([typeof fetch, typeof setTimeout, typeof require, typeof process, typeof __host, typeof __main].join(" "));
      try { item.title = "changed"; } catch (e) { attach.log("item is " + (Object.isFrozen(item) ? "frozen" : "open")); }
    }`);
    expect(r.error).toBeUndefined();
    expect(r.attached.map((a) => (a as { text: string }).text)).toEqual(["undefined undefined undefined undefined undefined undefined", "item is frozen"]);
  });

  it("turns a thrown error into the run's error, with its message", async () => {
    const r = await runJs(`export async function run({ attach }) {
      attach.link({ type: "pr", url: "https://gh/1" });
      throw Object.assign(new Error("not today"), { waiting: true });
    }`);
    expect(r).toEqual({ attached: [], wouldSend: [], log: [], error: "not today" });
    expect((await runJs("export const x = 1;")).error).toBe("the plugin exports no run function");
    expect((await runJs("export function run( {")).error).toMatch(/SyntaxError|expecting|unexpected/i);
    expect((await runJs("export function run({ attach }) { attach.link({ type: 'pr' }); }")).error).toBe("link has no url");
  });

  it("attaches every kind with derived or given keys", async () => {
    const r = await runInstance({ plugin: { code: "p.js", capabilities: ["post-request"] }, name: "p", instance: { id: "i", name: "d" },
      item: ITEM, event: { type: "refresh" }, connections: {}, dryRun: false, shipped: true, grants: ["post-request"], code: `export function run({ attach, item }) {
        attach.link({ type: "preview", url: "https://p/" + item.id, label: "Preview" });
        attach.edge({ needs: "branch:feat/base", in: "staging", because: "shares commits" });
        attach.doc({ name: "notes.md", content: "# hi", key: "doc-1" });
        attach.log("ran");
        attach.request({ text: "new request" });
      }` });
    expect(r.attached).toEqual([
      { kind: "link", key: "link:https://p/fix-login", type: "preview", url: "https://p/fix-login", label: "Preview" },
      { kind: "edge", key: "edge:branch:feat/base in staging", needs: "branch:feat/base", in: "staging", because: "shares commits" },
      { kind: "doc", key: "doc-1", name: "notes.md", content: "# hi" },
      { kind: "log", key: "log:ran", text: "ran" },
      { kind: "request", key: "request:new request", text: "new request" },
    ]);
    const ungranted = await runJs("export function run({ attach }) { attach.request('x'); attach.log('after'); }");
    expect(ungranted.error).toBeUndefined();
    expect(ungranted.attached.map((a) => a.kind)).toEqual(["log"]);
    expect(ungranted.log).toEqual(["dropped a request: p hasn't been granted post-request"]);
  });

  it("holds back a code plugin's writes in dry-run", async () => {
    const server = await serve([{ method: "GET", path: "/api/roster?q=a%20b", body: { sessions: [] } }]);
    const r = await runInstance({ plugin: { code: "p.js", connections: ["wt"] }, name: "p", instance: { id: "i", name: "d" }, item: ITEM,
      event: { type: "refresh" }, connections: { wt: { kind: "http", url: server.url } }, dryRun: true, code: `export async function run({ wt, attach }) {
        const { sessions } = await wt.get("/api/roster", { q: "a b" });
        const made = await wt.post("/api/sessions", { n: sessions.length });
        attach.log("made " + JSON.stringify(made));
      }` }, fast);
    expect(r.error).toBeUndefined();
    expect(r.wouldSend).toEqual([{ connection: "wt", method: "POST", path: "/api/sessions", input: { n: 0 } }]);
    expect(r.attached.map((a) => (a as { text: string }).text)).toEqual(["made null"]);
    expect(server.received.map((x) => x.method)).toEqual(["GET"]);
  });

  it("refuses to grow past its memory limit", async () => {
    const r = await runJs("export function run() { const a = []; for (;;) a.push('x'.repeat(1 << 16) + a.length); }",
                          { limits: { memoryBytes: 8 * 1024 * 1024 } });
    expect(r.error).toMatch(/out of memory/i);
  });
});

describe("triggers", () => {
  const ids = (plugin: PluginDef, instances: InstanceDef[], event: PluginEvent) => pickInstances(plugin, instances, event).map((i) => i.id);
  const plugin: PluginDef = { on: ["push", { status: { to: "review" } }] };
  const instances: InstanceDef[] = [
    { id: "default", name: "Default" },
    { id: "off", name: "Off", enabled: false },
    { id: "start", name: "Start", on: ["manual", { status: { from: "*", to: "in-progress" } }] },
    { id: "qa", name: "QA", on: [{ status: { from: "review", to: "ready-for-qa" } }] },
    { id: "button", name: "Button", on: ["manual"] },
    { id: "deploys", name: "Deploys", on: ["deployment", "pr"] },
  ];

  it("matches status moves by from and to, with * as any", () => {
    expect(ids(plugin, instances, { type: "status", from: "todo", to: "review" })).toEqual(["default"]);
    expect(ids(plugin, instances, { type: "status", from: "todo", to: "in-progress" })).toEqual(["start"]);
    expect(ids(plugin, instances, { type: "status", from: "review", to: "ready-for-qa" })).toEqual(["qa"]);
    expect(ids(plugin, instances, { type: "status", from: "in-qa", to: "ready-for-qa" })).toEqual([]);
  });

  it("matches git events by type and manual runs by instance id", () => {
    expect(ids(plugin, instances, { type: "push", branch: "feat/x" })).toEqual(["default"]);
    expect(ids(plugin, instances, { type: "pr", branch: "feat/x" })).toEqual(["deploys"]);
    expect(ids(plugin, instances, { type: "deployment", branch: "feat/x" })).toEqual(["deploys"]);
    expect(ids(plugin, instances, { type: "manual", instance: "button" })).toEqual(["button"]);
    expect(ids(plugin, instances, { type: "manual", instance: "default" })).toEqual([]);
  });

  it("refreshes git-triggered instances and every: floors, never status moves or buttons", () => {
    expect(ids(plugin, instances, { type: "refresh" })).toEqual(["default", "deploys"]);
    expect(ids({ on: ["manual"], every: "5m" }, [{ id: "a", name: "A" }], { type: "refresh" })).toEqual(["a"]);
    expect(ids({ on: [{ status: { to: "review" } }] }, [{ id: "a", name: "A" }], { type: "refresh" })).toEqual([]);
  });

  it("fires only the first match when exclusive", () => {
    const jira: PluginDef = { exclusive: true };
    const rules: InstanceDef[] = [
      { id: "to-review", name: "a", on: [{ status: { to: "review" } }] },
      { id: "any", name: "b", on: [{ status: { from: "*", to: "*" } }] },
    ];
    expect(ids(jira, rules, { type: "status", from: "todo", to: "review" })).toEqual(["to-review"]);
    expect(ids(jira, rules, { type: "status", from: "todo", to: "done" })).toEqual(["any"]);
    expect(ids({ ...jira, exclusive: false }, rules, { type: "status", from: "todo", to: "review" })).toEqual(["to-review", "any"]);
  });

  it("parses durations", () => {
    expect([parseDuration("2s"), parseDuration("3m"), parseDuration("1h"), parseDuration("250ms"), parseDuration(5)]).toEqual([2_000, 180_000, 3_600_000, 250, 5]);
    expect(() => parseDuration("soon")).toThrow('not a duration: "soon"');
  });
});
