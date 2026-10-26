import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { blockedAddress, pinnedFetch } from "@/lib/plugins/connections";
import { runEvent, runInstance, type HostDeps } from "@/lib/plugins/host";
import type { PluginItem, RunInput } from "@/lib/plugins/types";

const ITEM: PluginItem = { id: "fix-login", uid: "U1", title: "Fix login", status: "in-progress", repo: "acme/web", repo_owner: "acme",
  repo_name: "web", branches: ["feat/login"], links: [] };

/** A fetch that answers everything and records who asked, with what authorization. */
function recorder() {
  const sent: { url: string; auth?: string }[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: String(input), auth: headers.authorization });
    return Response.json(String(input).includes("/pulls") ? [{ html_url: "https://github.com/acme/web/pull/7", number: 7, title: "t" }] : {});
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

describe("host secrets", () => {
  it("go only to shipped plugins; a repo plugin naming a host connection is skipped with how to fix it", async () => {
    const { sent, fetch } = recorder();
    const repo = { text: [
      "plugins:", "  mine:", "    connections: [github]", "    on: [push]",
      "    steps: [{name: x, http: {method: GET, path: /repos/acme/private/contents/.env}}]", "    attach: [{log: 'got {{x.path}}'}]",
    ].join("\n"), files: {} };
    const out = await runEvent({
      repo, item: ITEM, event: { type: "push", branch: "feat/login" },
      hostConnections: { github: { http: { url: "https://api.github.com", auth: "bearer" } } }, secrets: { host: { github: "ghp_host" } },
    }, { fetch });
    const mine = out.results.find((r) => r.plugin === "mine")!;
    expect(mine.result.skipped).toMatch(/`github` is this host.s connection, which only plugins shipped with todo use; declare a repo connection named github/);
    expect(sent.map((s) => [s.url, s.auth])).toEqual([
      ["https://api.github.com/repos/acme/web/pulls?head=acme%3Afeat%2Flogin&state=all", "Bearer ghp_host"]]);
  });

  it("are kept from a repo plugin run on its own as well", async () => {
    const { sent, fetch } = recorder();
    const input: RunInput = {
      plugin: { connections: ["github"], on: ["push"], steps: [{ http: { method: "GET", path: "/user" } }], attach: [] }, name: "mine",
      instance: { id: "default", name: "default" }, item: ITEM, event: { type: "push", branch: "x" }, dryRun: false,
      connections: { github: { kind: "http", url: "https://api.github.com", auth: "bearer", secret: "ghp_host", origin: "host" } },
    };
    expect((await runInstance(input, { fetch })).skipped).toMatch(/this host's connection/);
    expect(sent).toEqual([]);
  });
});

describe("the address guard", () => {
  const plugin = (url: string): RunInput => ({
    plugin: { connections: ["c"], on: ["push"], steps: [{ http: { method: "GET", path: "/x" } }], attach: [] }, name: "p",
    instance: { id: "default", name: "default" }, item: ITEM, event: { type: "push", branch: "x" }, dryRun: false,
    connections: { c: { kind: "http", url } },
  });
  const guarded = (fetch: typeof globalThis.fetch, extra: Partial<NonNullable<HostDeps["guard"]>> = {}): HostDeps =>
    ({ fetch, guard: { allow: [], lookup: async (host) => (host === "lan.example" ? [{ address: "192.168.1.9", family: 4 }]
                                                           : [{ address: "93.184.216.34", family: 4 }]), ...extra } });

  it("refuses loopback, private, link-local, CGNAT and unique-local addresses, v4 and v6, without connecting", async () => {
    for (const url of ["http://127.0.0.1:5432", "http://10.0.0.5", "http://172.16.3.4", "http://192.168.0.1", "http://169.254.169.254",
                       "http://100.64.1.1", "http://0.0.0.0", "http://[::1]", "http://[fe80::1]", "http://[fd00::1]",
                       "http://[::ffff:127.0.0.1]", "http://lan.example"]) {
      const { sent, fetch } = recorder();
      const r = await runInstance(plugin(url), guarded(fetch));
      expect(r.error, url).toMatch(/isn't an address this host connects to/);
      expect(r.error).not.toMatch(/refused|ECONN|port/i);
      expect(sent, url).toEqual([]);
    }
  });

  it("lets public addresses through, and private ones the allow list for the connection's origin names", async () => {
    const { sent, fetch } = recorder();
    expect((await runInstance(plugin("https://hooks.example"), guarded(fetch))).error).toBeUndefined();
    expect((await runInstance(plugin("http://127.0.0.1:8710"), guarded(fetch, { repoAllow: ["127.0.0.1:8710"] }))).error).toBeUndefined();
    expect((await runInstance(plugin("http://lan.example"), guarded(fetch, { repoAllow: ["lan.example"] }))).error).toBeUndefined();
    expect((await runInstance(plugin("http://127.0.0.1:9999"), guarded(fetch, { repoAllow: ["127.0.0.1:8710"] }))).error).toMatch(/isn't an address/);
    expect(sent.map((s) => s.url)).toEqual(["https://hooks.example/x", "http://127.0.0.1:8710/x", "http://lan.example/x"]);
  });

  it("keeps a host-wide allowance from a repo's connections, and a repo's from the host's", async () => {
    const { sent, fetch } = recorder();
    const repoConn = plugin("http://127.0.0.1:8710");
    const hostConn: RunInput = { ...repoConn, shipped: true, connections: { c: { kind: "http", url: "http://127.0.0.1:8710", origin: "host" } } };
    expect((await runInstance(repoConn, guarded(fetch, { allow: ["127.0.0.1:8710"] }))).error).toMatch(/isn't an address/);
    expect((await runInstance(hostConn, guarded(fetch, { repoAllow: ["127.0.0.1:8710"] }))).error).toMatch(/isn't an address/);
    expect((await runInstance(hostConn, guarded(fetch, { allow: ["127.0.0.1:8710"] }))).error).toBeUndefined();
    expect(sent.length).toBe(1);
  });

  it("is off unless the host turns it on, as on the CLI", async () => {
    const { fetch } = recorder();
    expect((await runInstance(plugin("http://127.0.0.1:5432"), { fetch })).error).toBeUndefined();
  });

  it("refuses the IPv6 forms that carry a private IPv4 address, and other reserved ranges", () => {
    for (const a of ["::7f00:1", "::127.0.0.1", "::ffff:0:7f00:1", "64:ff9b::7f00:1", "64:ff9b:1::1", "2002:7f00:1::", "2002:a00:1::1",
                     "fec0::1", "fe80::1%eth0", "192.0.2.1", "198.51.100.7", "203.0.113.9"]) expect(blockedAddress(a), a).toBe(true);
    expect(blockedAddress("2002:5db8:d822::1")).toBe(false);
  });

  it("classifies addresses", () => {
    expect(["127.0.0.1", "10.1.2.3", "100.127.255.255", "::1", "fc00::1", "fe80::2", "::ffff:10.0.0.1", "::", "::ffff:7f00:1", "::ffff:a00:1"].map(blockedAddress))
      .toEqual(Array(10).fill(true));
    expect(["93.184.216.34", "100.128.0.1", "2606:4700::1111", "8.8.8.8"].map(blockedAddress)).toEqual(Array(4).fill(false));
    expect(blockedAddress("::ffff:808:808")).toBe(true);
  });

  it("refuses a redirect when asked to, as an MCP connection does", async () => {
    const server = createServer((_req, res) => res.writeHead(302, { location: "http://169.254.169.254/" }).end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(pinnedFetch({ address: "127.0.0.1", family: 4 }, { refuseRedirects: true })(`http://x.invalid:${port}/`)).rejects.toThrow(/redirect/);
      expect((await pinnedFetch({ address: "127.0.0.1", family: 4 })(`http://x.invalid:${port}/`)).status).toBe(302);
    } finally {
      server.close();
    }
  });

  it("connects to the address it checked, whatever the name resolves to later", async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await pinnedFetch({ address: "127.0.0.1", family: 4 })(`http://nowhere.invalid:${port}/ping`, { method: "GET" });
      expect(await res.json()).toEqual({ ok: true });
      expect(seen).toEqual([`nowhere.invalid:${port} /ping`]);
    } finally {
      server.close();
    }
  });
});

describe("retrying", () => {
  const plugin = (steps: NonNullable<RunInput["plugin"]["steps"]>): RunInput => ({
    plugin: { connections: ["c"], on: ["push"], steps, attach: [] }, name: "p", instance: { id: "default", name: "default" }, item: ITEM,
    event: { type: "push", branch: "x" }, dryRun: false, connections: { c: { kind: "http", url: "https://hooks.example" } },
  });
  const answering = (status: number) => (async () => new Response("", { status })) as typeof globalThis.fetch;

  it("marks a run transient only when the failure was a network error, 5xx or 429 and every call only read", async () => {
    const get = [{ http: { method: "GET", path: "/a" } }];
    const post = [{ http: { method: "POST", path: "/a" } }];
    expect((await runInstance(plugin(get), { fetch: answering(503) })).transient).toBe(true);
    expect((await runInstance(plugin(get), { fetch: answering(429) })).transient).toBe(true);
    expect((await runInstance(plugin(get), { fetch: (async () => { throw new Error("ECONNRESET"); }) as typeof globalThis.fetch })).transient).toBe(true);
    expect((await runInstance(plugin(get), { fetch: answering(404) })).transient).toBeUndefined();
    expect((await runInstance(plugin(post), { fetch: answering(503) })).transient).toBeUndefined();
  });
});

describe("event hooks", () => {
  it("skip an instance when before says so, and hear each result as it comes", async () => {
    const { fetch } = recorder();
    const repo = { text: "plugins:\n  a: {on: [push], steps: [{name: v, value: '`1`'}], attach: [{log: a}]}\n  b: {on: [push], steps: [{name: v, value: '`1`'}], attach: [{log: b}]}\n", files: {} };
    const heard: string[] = [];
    const out = await runEvent({ repo, item: ITEM, event: { type: "push", branch: "feat/login" } }, { fetch },
      { before: async (plugin) => plugin !== "a", after: async (r) => { heard.push(r.plugin); } });
    expect(out.results.map((r) => r.plugin)).toEqual(["pr-link", "b"]);
    expect(heard).toEqual(["pr-link", "b"]);
  });
});
