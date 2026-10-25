// Plugin conformance: each case in fixtures/plugins/cases runs a plugin from
// fixtures/plugins/plugins.yaml against recorded connection answers, in-process
// and through the CLI's bundled host, and both must give the expected result.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runEvent, runInstance, type EventInput, type EventResult } from "@/lib/plugins/host";
import { loadPlugins } from "@/lib/plugins/load";
import type { ConnectionDef, InstanceDef, PluginEvent, ResolvedConnection, RunInput, RunResult } from "@/lib/plugins/types";
import { fakeServer, type FakeServer, type Recorded, type RecordedTool } from "./plugin-fakes";

const DIR = path.join(import.meta.dirname, "fixtures/plugins");
const BUNDLE = path.join(import.meta.dirname, "../../todo/plugin_host.mjs");
const FAKE_MCP = path.join(DIR, "fake-mcp.mjs");
const FILE = loadPlugins(readFileSync(path.join(DIR, "plugins.yaml"), "utf8"));
const ITEM = JSON.parse(readFileSync(path.join(DIR, "item.json"), "utf8"));
const scratch = mkdtempSync(path.join(tmpdir(), "plugin-conformance-"));

interface Case {
  about: string;
  plugin: string;
  instance: InstanceDef;
  event: PluginEvent;
  item?: Record<string, unknown>;
  dry_run?: boolean;
  connections: Record<string, Partial<ResolvedConnection>>;
  responses?: Record<string, Recorded[]>;
  tools?: Record<string, RecordedTool[]>;
  expect: Partial<RunResult>;
  received?: Record<string, Record<string, unknown>[]>;
}

const CASES = readdirSync(path.join(DIR, "cases")).filter((f) => f.endsWith(".yaml")).sort()
  .map((f) => [f.replace(/\.yaml$/, ""), parse(readFileSync(path.join(DIR, "cases", f), "utf8")) as Case] as const);

type Host = (input: RunInput) => Promise<RunResult>;

/** The bundled host, as the CLI runs it: the input as JSON on stdin, the result as JSON on stdout. */
function bundled(stdin: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

const HOSTS: [string, Host][] = [
  ["in-process", (input) => runInstance(input)],
  ["bundle", async (input) => {
    const { code, stdout, stderr } = await bundled(JSON.stringify(input));
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  }],
];

const servers: FakeServer[] = [];
afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });

/** The case's connections pointed at fresh fakes: an HTTP server per http one, the stdio fake for mcp. */
async function connectionsFor(name: string, c: Case) {
  const connections: Record<string, ResolvedConnection> = {};
  const fakes: Record<string, FakeServer> = {};
  for (const [conn, def] of Object.entries(c.connections)) {
    if (def.kind === "mcp") {
      const tools = path.join(scratch, `${name}-${conn}.json`);
      writeFileSync(tools, JSON.stringify(c.tools?.[conn] ?? []));
      connections[conn] = { ...def, kind: "mcp", command: process.execPath, args: [FAKE_MCP, tools], origin: "host" };
    } else {
      fakes[conn] = await fakeServer(c.responses?.[conn] ?? []);
      servers.push(fakes[conn]);
      connections[conn] = { ...def, kind: "http", url: fakes[conn].url } as ResolvedConnection;
    }
  }
  return { connections, fakes };
}

describe.each(HOSTS)("plugin conformance (%s)", (_, host) => {
  it.each(CASES)("%s", async (name, c) => {
    const plugin = FILE.plugins![c.plugin];
    const { connections, fakes } = await connectionsFor(name, c);
    const result = await host({
      plugin, name: c.plugin, code: plugin.code ? readFileSync(path.join(DIR, plugin.code), "utf8") : undefined,
      instance: c.instance, item: { ...ITEM, ...c.item }, event: c.event, connections, dryRun: !!c.dry_run,
    });
    const { log, ...rest } = c.expect;
    expect({ ...result, log: undefined }, c.about).toEqual({ ...rest, log: undefined });
    if (log) expect(result.log).toEqual(log);
    // Each expected request names the fields it checks: method, path, body, or a header.
    for (const [conn, want] of Object.entries(c.received ?? {})) {
      const got = fakes[conn].received.map((r, i) => Object.fromEntries(Object.keys({ method: 1, path: 1, ...want[i] }).map((k) =>
        [k, k === "method" ? r.method : k === "path" ? r.path : k === "body" ? r.body : r.headers[k]])));
      expect(got).toEqual(want);
    }
  });
});

describe("bundled plugin host", () => {
  it("exits 2 on input it can't read", async () => {
    for (const stdin of ["", "not json", "[]", '{"plugin": {}}', '{"mode": "event"}', '{"mode": "event", "item": {}, "event": {}, "repo": "x"}', '{"mode": "nope"}']) {
      const { code, stderr } = await bundled(stdin);
      expect(code).toBe(2);
      expect(stderr).toMatch(/^plugin host: /);
    }
  });

  it("exits 0 with the error in the result when the run fails", async () => {
    const { code, stdout } = await bundled(JSON.stringify({
      plugin: { code: "p.js" }, code: "export function run() { throw new Error('boom'); }",
      instance: { id: "i", name: "d" }, item: ITEM, event: { type: "refresh" }, connections: {}, dryRun: false,
    }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ attached: [], wouldSend: [], log: [], error: "boom" });
  });
});

interface EventCase {
  about: string;
  /** A file in fixtures/plugins/repos, or the file's text inline. */
  repo?: string;
  repo_text?: string;
  /** The repo's code files: name in .todo-plugins/ → fixture file. */
  files?: Record<string, string>;
  hostConnections?: Record<string, ConnectionDef>;
  secrets?: { repo?: Record<string, string>; host?: Record<string, string> };
  storedInstances?: Record<string, InstanceDef[]>;
  grants?: Record<string, string[]>;
  event: PluginEvent;
  item?: Record<string, unknown>;
  dryRun?: boolean;
  allowRepoCommands?: boolean;
  /** Recorded answers per connection; http://fake-<name> in the repo file and host connections points at that fake. */
  responses?: Record<string, Recorded[]>;
  expect: { errors: string[]; track: string[]; results: { plugin: string; instance: string; result: RunResult }[] };
}

const EVENT_CASES = readdirSync(path.join(DIR, "event-cases")).filter((f) => f.endsWith(".yaml")).sort()
  .map((f) => [f.replace(/\.yaml$/, ""), parse(readFileSync(path.join(DIR, "event-cases", f), "utf8")) as EventCase] as const);

const EVENT_HOSTS: [string, (input: EventInput) => Promise<EventResult>][] = [
  ["in-process", (input) => runEvent(input)],
  ["bundle", async (input) => {
    const { code, stdout, stderr } = await bundled(JSON.stringify({ mode: "event", ...input }));
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout);
  }],
];

describe.each(EVENT_HOSTS)("runEvent conformance (%s)", (_, host) => {
  it.each(EVENT_CASES)("%s", async (_name, c) => {
    let text = c.repo ? readFileSync(path.join(DIR, "repos", c.repo), "utf8") : c.repo_text;
    let hostConnections = JSON.stringify(c.hostConnections ?? {});
    for (const [conn, responses] of Object.entries(c.responses ?? {})) {
      const fake = await fakeServer(responses);
      servers.push(fake);
      text = text?.replaceAll(`http://fake-${conn}`, fake.url);
      hostConnections = hostConnections.replaceAll(`http://fake-${conn}`, fake.url);
    }
    const files = Object.fromEntries(Object.entries(c.files ?? {}).map(([name, f]) => [name, readFileSync(path.join(DIR, f), "utf8")]));
    const out = await host({
      repo: text === undefined ? undefined : { text, files }, hostConnections: JSON.parse(hostConnections), secrets: c.secrets,
      storedInstances: c.storedInstances, grants: c.grants, item: { ...ITEM, ...c.item }, event: c.event, dryRun: c.dryRun,
      allowRepoCommands: c.allowRepoCommands,
    });
    expect({ errors: out.errors, track: out.track, results: out.results.map((r) => ({ plugin: r.plugin, instance: r.instance.id, result: r.result })) },
           c.about).toEqual(c.expect);
  });
});
