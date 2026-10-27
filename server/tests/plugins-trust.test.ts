// Who may use the host's connections and secrets: plugins shipped with todo,
// through any instance. A custom plugin gets the repo config's connections and
// github without the host's token, never another host connection or secret.
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

const run = (input: Partial<EventInput>, instance: string) => runEvent({ item: ITEM, event: { type: "manual", instance }, ...input } as EventInput,
                                                                          { guard: { allow: ["127.0.0.1"], repoAllow: [] } });

describe("host connections", () => {
  it("go to any instance of a shipped plugin, with their secret", async () => {
    const srv = await recorder();
    const out = await run({ config: { text: "plugins:\n  rest: {use: shipped}\n" },
                            hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } }, secrets: { host: { jira: "me@x:token" } },
                            storedInstances: { rest: [{ id: "s", name: "s", settings: { connection: "jira", method: "DELETE", path: "/rest/api/3/issue/SR-1" } }] } }, "s");
    expect(out.results[0].result.error).toBeUndefined();
    expect(srv.got.map((g) => [g.method, g.url, g.auth])).toEqual([["DELETE", "/rest/api/3/issue/SR-1", `Basic ${Buffer.from("me@x:token").toString("base64")}`]]);
  });

  it("are kept from a custom plugin, with or without a secret, even with the host on the bare allow list", async () => {
    const srv = await recorder();
    const text = `plugins:
  mine:
    connections: [watchtower]
    on: [manual]
    steps:
      - http: {method: POST, path: /api/sessions, body: {dir: "/", name: x, initialPrompt: "run anything"}}
`;
    for (const auth of [undefined, "bearer" as const]) {
      const out = await run({ config: { text }, hostConnections: { watchtower: { http: { url: srv.url, ...(auth ? { auth } : {}) } } },
                              secrets: { host: { watchtower: "HOST" } }, storedInstances: { mine: [{ id: "x", name: "x" }] } }, "x");
      expect(out.results[0].result.skipped).toBe(
        "mine: `watchtower` is this host's connection, which only plugins shipped with todo use; declare a connection named watchtower in the repo's plugin config");
    }
    expect(srv.got).toEqual([]);
  });

  it("give a custom plugin github without the host's token", async () => {
    const srv = await recorder(() => [{ number: 1 }]);
    const text = `plugins:\n  prs: {connections: [github], on: [manual], steps: [{name: prs, http: {method: GET, path: /repos/o/r/pulls}}], attach: [{log: "PR {{prs.0.number}}"}]}\n`;
    const out = await runEvent({ config: { text }, hostConnections: { github: { http: { url: srv.url, auth: "bearer" } } }, secrets: { host: { github: "ghp_HOST" } },
                                 storedInstances: { prs: [{ id: "x", name: "x" }] }, item: ITEM, event: { type: "manual", instance: "x" } },
                               { guard: { allow: [], repoAllow: ["127.0.0.1"] } });
    expect(out.results[0].result, JSON.stringify(out.results[0].result)).toMatchObject({ attached: [{ kind: "log", text: "PR 1" }] });
    expect(srv.got.map((g) => [g.url, g.auth])).toEqual([["/repos/o/r/pulls", undefined]]);
  });

  it("keep the bare allow list from opening a private github address to a custom plugin", async () => {
    const srv = await recorder(() => []);
    const text = `plugins:\n  prs: {connections: [github], on: [manual], steps: [{http: {method: GET, path: /x}}]}\n`;
    const out = await run({ config: { text }, hostConnections: { github: { http: { url: srv.url, auth: "bearer" } } }, secrets: { host: { github: "ghp_HOST" } },
                            storedInstances: { prs: [{ id: "x", name: "x" }] } }, "x");
    expect(out.results[0].result.error).toMatch(/isn't an address this host connects to/);
    expect(srv.got).toEqual([]);
  });

  it("let a custom plugin use a connection of the config's own, with the repo's credential", async () => {
    const srv = await recorder();
    const text = `connections:\n  hooks: {http: {url: "${srv.url}", auth: bearer}}\nplugins:\n  mine: {connections: [hooks], on: [manual], steps: [{http: {method: GET, path: /}}]}\n`;
    const out = await runEvent({ config: { text }, secrets: { repo: { hooks: "r1" }, host: { hooks: "HOST" } }, storedInstances: { mine: [{ id: "x", name: "x" }] },
                                 item: ITEM, event: { type: "manual", instance: "x" } }, { guard: { allow: [], repoAllow: ["127.0.0.1"] } });
    expect(out.results[0].result.error).toBeUndefined();
    expect(srv.got.map((g) => g.auth)).toEqual(["Bearer r1"]);
  });

  it("keep a bare allow entry from opening a private address to a repo connection", async () => {
    const srv = await recorder();
    const text = `connections:\n  lan: {http: {url: "${srv.url}"}}\nplugins:\n  mine: {connections: [lan], on: [manual], steps: [{http: {method: GET, path: /}}]}\n`;
    const out = await run({ config: { text }, storedInstances: { mine: [{ id: "x", name: "x" }] } }, "x");
    expect(out.results[0].result.error).toMatch(/isn't an address this host connects to/);
    expect(srv.got).toEqual([]);
  });
});

describe("a read-only connection", () => {
  const TRANSITION = `plugins:\n  jira-transition: {use: shipped}\n`;

  it("holds back every write of a run through the host's connection of that name, as dry-run does", async () => {
    const srv = await recorder((url) => (url.endsWith("/transitions") ? { transitions: [{ id: "161", to: { name: "QA" } }] } : {}));
    const out = await runEvent({
      config: { text: TRANSITION }, hostConnections: { jira: { http: { url: srv.url, auth: "basic" } } }, secrets: { host: { jira: "a:b" } },
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

describe("comments", () => {
  it("are attached only by plugins shipped with todo, since each speaks as its author", async () => {
    const text = `plugins:\n  mine: {on: [manual], attach: [{comment: {text: hi, author: acc-boss}}]}\n`;
    const out = await runEvent({ config: { text }, storedInstances: { mine: [{ id: "x", name: "x" }] }, item: ITEM, event: { type: "manual", instance: "x" } });
    expect([out.results[0].result.attached, out.results[0].result.log]).toEqual([[], ["dropped a comment: only plugins shipped with todo attach one"]]);
  });
});
