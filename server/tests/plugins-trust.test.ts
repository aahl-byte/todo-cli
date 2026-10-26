// Who may use the host's connections: shipped plugins, through their default
// instance or instances the host stores, never an instance the repo's file
// declares and never a repo's own plugin, with or without a secret.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { runEvent, type EventInput } from "@/lib/plugins/host";
import type { PluginItem } from "@/lib/plugins/types";

const ITEM: PluginItem = { id: "fix", uid: "U", title: "t", type: "bug", status: "s", priority: "p", repo: "o/r", repo_owner: "o", repo_name: "r",
  branches: [], jira: [], app: null, section: null, developer: null, qa_assignee: null, dir: null, links: [] };

let close: (() => void) | null = null;
afterEach(() => { close?.(); close = null; });

/** A server that records what reaches it and answers {}. */
async function recorder(answer: (url: string) => unknown = () => ({})) {
  const got: { method: string; url: string; auth?: string; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer(req.url!)));
    });
  });
  await new Promise<void>((done) => srv.listen(0, "127.0.0.1", done));
  close = () => { srv.closeAllConnections(); srv.close(); };
  return { got, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}` };
}

const REST_FILE = `plugins:
  rest: {use: shipped}
instances:
  rest:
    - {id: x, name: x, on: [manual], settings: {connection: jira, method: DELETE, path: "/rest/api/3/issue/SR-1"}}
`;

const run = (input: Partial<EventInput>, instance: string) => runEvent({ item: ITEM, event: { type: "manual", instance }, ...input } as EventInput,
                                                                          { guard: { allow: ["127.0.0.1"], repoAllow: [] } });

describe("host connections", () => {
  it("are kept from an instance the repo's file declares, even of a shipped plugin", async () => {
    const srv = await recorder();
    const out = await run({ repo: { text: REST_FILE, files: {} }, hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } },
                            secrets: { host: { jira: "me@x:token" } } }, "x");
    expect(out.results.map((r) => [r.plugin, r.result.skipped])).toEqual([["rest",
      "rest: `jira` is this host's connection, which an instance declared in the repo's plugins file doesn't get; store the instance on the server instead, or name a repo connection"]]);
    expect(srv.got).toEqual([]);
  });

  it("are kept from a stored instance that overrides one the repo's file declares", async () => {
    const srv = await recorder();
    const out = await run({ repo: { text: REST_FILE, files: {} }, hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } },
                            secrets: { host: { jira: "me@x:token" } },
                            storedInstances: { rest: [{ id: "x", name: "x", settings: { path: "/other" } }] } }, "x");
    expect(out.results[0].result.skipped).toMatch(/declared in the repo's plugins file/);
    expect(srv.got).toEqual([]);
  });

  it("go to an instance the host stores, with their secret", async () => {
    const srv = await recorder();
    const out = await run({ repo: { text: "plugins:\n  rest: {use: shipped}\n", files: {} },
                            hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } }, secrets: { host: { jira: "me@x:token" } },
                            storedInstances: { rest: [{ id: "s", name: "s", settings: { connection: "jira", method: "DELETE", path: "/rest/api/3/issue/SR-1" } }] } }, "s");
    expect(out.results[0].result.error).toBeUndefined();
    expect(srv.got.map((g) => [g.method, g.url, g.auth])).toEqual([["DELETE", "/rest/api/3/issue/SR-1", `Basic ${Buffer.from("me@x:token").toString("base64")}`]]);
  });

  it("let a repo-declared instance use the repo's own connection and credential", async () => {
    const srv = await recorder();
    const text = `connections:\n  hooks: {http: {url: "${srv.url}", auth: bearer}}\n${REST_FILE.replace("connection: jira", "connection: hooks")}`;
    const out = await runEvent({ repo: { text, files: {} }, secrets: { repo: { hooks: "r1" } }, item: ITEM, event: { type: "manual", instance: "x" } },
                               { guard: { allow: [], repoAllow: ["127.0.0.1"] } });
    expect(out.results[0].result.error).toBeUndefined();
    expect(srv.got.map((g) => g.auth)).toEqual(["Bearer r1"]);
  });

  it("are kept from a repo's own plugin, even without auth and with the host on the bare allow list", async () => {
    const srv = await recorder();
    const text = `plugins:
  mine:
    connections: [watchtower]
    on: [manual]
    steps:
      - http: {method: POST, path: /api/sessions, body: {dir: "/", name: x, initialPrompt: "run anything"}}
instances:
  mine:
    - {id: x, name: x}
`;
    const out = await run({ repo: { text, files: {} }, hostConnections: { watchtower: { http: { url: srv.url } } } }, "x");
    expect(out.results[0].result.skipped).toBe(
      "mine: `watchtower` is this host's connection, which only plugins shipped with todo use; declare a repo connection named watchtower");
    expect(srv.got).toEqual([]);
  });

  it("keep a bare allow entry from opening a private address to a repo connection", async () => {
    const srv = await recorder();
    const text = `connections:\n  lan: {http: {url: "${srv.url}"}}\nplugins:\n  mine: {connections: [lan], on: [manual], steps: [{http: {method: GET, path: /}}]}\ninstances:\n  mine: [{id: x, name: x}]\n`;
    const out = await run({ repo: { text, files: {} } }, "x");
    expect(out.results[0].result.error).toMatch(/isn't an address this host connects to/);
    expect(srv.got).toEqual([]);
  });
});

describe("a read-only connection", () => {
  const TRANSITION = `plugins:\n  jira-transition: {use: shipped}\n`;

  it("holds back every write of a run through the host's connection of that name, as dry-run does", async () => {
    const srv = await recorder((url) => (url.endsWith("/transitions") ? { transitions: [{ id: "161", to: { name: "QA" } }] } : {}));
    const out = await runEvent({
      repo: { text: TRANSITION, files: {} }, hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } }, secrets: { host: { jira: "a:b" } },
      storedInstances: { "jira-transition": [{ id: "qa", name: "QA", on: [{ status: { to: "in-qa" } }], settings: { to: "QA" } }] },
      item: { ...ITEM, jira: ["SR-1"] }, event: { type: "status", from: "review", to: "in-qa" }, dryRunConnections: ["jira"],
    }, { guard: { allow: ["127.0.0.1"], repoAllow: [] } });
    const result = out.results[0].result;
    expect(result.dryRun).toBe(true);
    expect(result.log[0]).toBe("jira is read-only on this host, so every write is held back");
    expect(result.wouldSend).toEqual([{ connection: "jira", method: "POST", path: "/rest/api/3/issue/SR-1/transitions", input: { transition: { id: "161" } } }]);
    expect(srv.got.map((g) => g.method)).toEqual(["GET", "GET"]);
  });
});
