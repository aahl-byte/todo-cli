import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeConfig } from "@/lib/plugins/describe";
import { runEvent, type EventInput } from "@/lib/plugins/host";
import { SHIPPED } from "@/lib/plugins/shipped";
import type { PluginItem } from "@/lib/plugins/types";
// @ts-expect-error a plain-JS build script
import { shippedSources, workerBuild } from "../scripts/build-plugin-host.mjs";
import { build } from "esbuild";
import { fakeServer, type FakeServer, type Recorded } from "./plugin-fakes";

const ITEM: PluginItem = { id: "fix-login", uid: "U1", title: "Fix login", status: "in-progress", repo: "acme/web", repo_owner: "acme",
  repo_name: "web", branches: ["feat/login"], links: [] };
const PULLS = "/repos/acme/web/pulls?head=acme%3Afeat%2Flogin&state=all";
const PR = { html_url: "https://github.com/acme/web/pull/7", number: 7, title: "Fix login" };

const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
async function serve(responses: Recorded[]) {
  const s = await fakeServer(responses);
  servers.push(s);
  return s;
}

async function github() {
  const gh = await serve([{ method: "GET", path: PULLS, body: [PR] }]);
  return { gh, hostConnections: { github: { http: { url: gh.url, auth: "bearer" as const } } }, secrets: { host: { github: "ghp_x" } } };
}

const summary = (out: Awaited<ReturnType<typeof runEvent>>) =>
  out.results.map((r) => [r.plugin, r.instance.id, r.result.error ?? r.result.skipped ?? r.result.attached.map((a) => (a as { text?: string; url?: string }).text ?? (a as { url: string }).url)]);

function run(over: Partial<EventInput>) {
  return runEvent({ item: ITEM, event: { type: "push", branch: "feat/login" }, ...over }, { sleep: async () => {} });
}

describe("shipped plugins", () => {
  it("keeps sources.ts in step with the files beside it", () => {
    expect(readFileSync(path.join(import.meta.dirname, "../lib/plugins/shipped/sources.ts"), "utf8")).toBe(shippedSources());
  });

  it("describes each shipped plugin in one line", () => {
    for (const [name, p] of Object.entries(SHIPPED)) expect(p.def.description, name).toMatch(/^[^\n]+\.$/);
  });

  it("keeps the worker bundle in step with code-worker.mjs", async () => {
    const out = await build({ ...workerBuild, write: false });
    expect(readFileSync(workerBuild.outfile, "utf8") === out.outputFiles![0].text, "run npm run build:plugin-host").toBe(true);
  });

  it("links each branch's PRs with pr-link, even for a repo with no plugin config", async () => {
    const { gh, ...conns } = await github();
    const out = await run(conns);
    expect(out).toEqual({ errors: [], track: [], results: [{ plugin: "pr-link", instance: { id: "default", name: "default" }, result: {
      attached: [{ kind: "link", key: `link:${PR.html_url}`, type: "pr", url: PR.html_url, label: "#7 · Fix login" }], wouldSend: [], log: [] } }] });
    expect(gh.received[0].headers.authorization).toBe("Bearer ghp_x");
    expect(SHIPPED["pr-link"].def.on).toEqual(["push", "pr"]);
  });

  it("skips pr-link where the host has no github connection, or the item no repo", async () => {
    expect(summary(await run({}))).toEqual([["pr-link", "default", "pr-link: `github` not authorized here"]]);
    const { gh, ...conns } = await github();
    expect(summary(await run({ ...conns, item: { ...ITEM, repo: null, repo_owner: null, repo_name: null } })))
      .toEqual([["pr-link", "default", "pr-link: when is false: item.repo_owner && item.repo_name"]]);
    expect(gh.received).toEqual([]);
  });

  it("never hands the host's secret to a repo connection of the same name", async () => {
    const evil = await serve([{ method: "GET", path: PULLS, body: [] }]);
    const { gh, ...conns } = await github();
    const config = { text: `connections:\n  github: {http: {url: "${evil.url}", auth: bearer}}\n` };
    expect(summary(await run({ ...conns, config }))).toEqual([["pr-link", "default", "pr-link: `github` not authorized here"]]);
    expect(evil.received).toEqual([]);
    const own = await run({ ...conns, config, secrets: { host: { github: "HOST" }, repo: { github: "REPO" } } });
    expect(summary(own)).toEqual([["pr-link", "default", []]]);
    expect(evil.received.map((r) => r.headers.authorization)).toEqual(["Bearer REPO"]);
    expect(gh.received).toEqual([]);
  });
});

describe("runEvent", () => {
  it("runs stored and implicit instances, and lets the config's connections override the host's", async () => {
    const api = await serve([{ method: "GET", path: "/hello", body: { from: "repo" } }]);
    const { gh, ...conns } = await github();
    const out = await run({
      ...conns,
      hostConnections: { ...conns.hostConnections, api: { http: { url: "http://127.0.0.1:9" } } },
      config: { text: `
track: [staging, main]
connections:
  api: {http: {url: "${api.url}"}}
plugins:
  ping:
    connections: [api]
    on: [push]
    settings: {tag: {label: Tag, type: text}, other: {label: Other, type: text, optional: true}}
    steps: [{name: hello, http: {method: GET, path: /hello}}]
    attach: [{log: "{{settings.tag}} {{settings.other}} from {{hello.from}}"}]
  quiet:
    on: [push]
    settings: {note: {label: Note, type: text, default: "quiet ran"}}
    attach: [{log: "{{settings.note}}"}]
  needs-setting:
    on: [push]
    settings: {project: {label: Project, type: text}}
    attach: [{log: never}]
` },
      storedInstances: {
        ping: [{ id: "one", name: "One", settings: { tag: "s1", other: "keep" } }, { id: "two", name: "Two", enabled: false }, { id: "three", name: "Three", settings: { tag: "s3" } }],
        "pr-link": [{ id: "default", name: "default", enabled: false }],
      },
    });
    expect(out.errors).toEqual([]);
    expect(out.track).toEqual(["staging", "main"]);
    expect(summary(out)).toEqual([["ping", "one", ["s1 keep from repo"]], ["ping", "three", ["s3  from repo"]], ["quiet", "default", ["quiet ran"]]]);
    expect(gh.received).toEqual([]);
  });

  it("drops only the broken parts of a config, and says instances are stored apart", async () => {
    const { gh, ...conns } = await github();
    const out = await run({ ...conns, config: { text: `
track: [staging]
connections:
  broken: {ftp: {url: x}}
plugins:
  bad: {until: x, attach: [{log: x}]}
  good: {on: [push], attach: [{log: good ran}]}
  pr-link: {use: shipped}
instances:
  good: [{id: g, name: G}]
` }, storedInstances: { good: [{ id: "h", name: "H" }] } });
    expect(out.errors).toEqual([
      "connection broken: is http or mcp",
      'plugin bad: unknown key "until"',
      "instances: a repo's plugin config holds none; instances are stored apart",
    ]);
    expect(out.track).toEqual(["staging"]);
    expect(summary(out)).toEqual([["pr-link", "default", [PR.html_url]], ["good", "h", ["good ran"]]]);
    const notYaml = await run({ ...conns, config: { text: "plugins: [unclosed" } });
    expect(notYaml.errors[0]).toMatch(/^the plugin config isn't YAML: /);
    expect(summary(notYaml)).toEqual([["pr-link", "default", [PR.html_url]]]);
  });

  it("resolves use: shipped, and refuses unknown shipped names, redefined shipped plugins and missing code", async () => {
    const { gh, ...conns } = await github();
    const out = await run({ ...conns, config: { text: `
plugins:
  pr-link: {use: shipped}
  nope: {use: shipped}
  coded: {on: [push], code: coded.js}
` }, storedInstances: { "pr-link": [{ id: "mine", name: "Mine" }] } });
    expect(out.errors).toEqual(["plugin nope: no plugin named nope ships with todo", "plugin coded: no code is stored for coded.js"]);
    expect(summary(out)).toEqual([["pr-link", "mine", [PR.html_url]]]);
    const shadow = await run({ ...conns, config: { text: "plugins: {pr-link: {on: [push], attach: [{log: mine}]}}" } });
    expect(shadow.errors).toEqual(["plugin pr-link: ships with todo, so it is switched on, never redefined"]);
    expect(summary(shadow)).toEqual([["pr-link", "default", [PR.html_url]]]);
  });

  it("runs a custom code plugin from its stored code, and passes the repo-command switch through", async () => {
    const config = { text: `
connections:
  local: {mcp: {command: node, args: [x.js]}}
plugins:
  coded: {on: [push], code: coded.js}
  local: {on: [push], connections: [local], steps: [{tool: t}]}
`, code: { coded: "export function run({ attach, event }) { attach.log('pushed ' + event.branch); }" } };
    const out = await run({ config, storedInstances: { "pr-link": [{ id: "default", name: "default", enabled: false }] } });
    expect(summary(out)).toEqual([["coded", "default", ["pushed feat/login"]],
      ["local", "default", "local: `local` runs a command, which this host doesn't allow for repo connections"]]);
  });

  it("gives no implicit default to a plugin with settings to fill, nor to one whose stored instances are all off", async () => {
    const out = await run({ config: { text: `
plugins:
  quiet: {on: [push], attach: [{log: quiet ran}]}
  setting: {on: [push], settings: {x: {label: X, type: text}}, attach: [{log: never}]}
` }, storedInstances: { "pr-link": [{ id: "default", name: "default", enabled: false }], quiet: [{ id: "q", name: "Q", enabled: false }] } });
    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([]);
  });

  it("fires only what the event triggers", async () => {
    const out = await run({ event: { type: "manual", instance: "go" }, config: { text: `
plugins:
  button: {on: [manual], attach: [{log: pressed}]}
` }, storedInstances: { button: [{ id: "go", name: "Go" }, { id: "other", name: "Other" }] } });
    expect(summary(out)).toEqual([["button", "go", ["pressed"]]]);
  });
});

describe("describeConfig", () => {
  it("lists shipped and custom plugins with the config's connections and load errors", () => {
    const out = describeConfig({ text: `
track: [main]
connections:
  vercel: {http: {url: "https://api.vercel.com", auth: bearer}}
plugins:
  preview: {connections: [vercel], on: [push], every: 1h, settings: {project: {label: Project, type: text}}, attach: [{log: x}]}
  not-shipped: {use: shipped}
` });
    expect(out.plugins).toEqual([
      { name: "pr-link", shipped: true, connections: ["github"], on: ["push", "pr"], per: "branch", settings: {} },
      { name: "preview", shipped: false, connections: ["vercel"], on: ["push"], every: "1h",
        settings: { project: { label: "Project", type: "text" } } },
    ]);
    expect(out.connections).toEqual({ vercel: { http: { url: "https://api.vercel.com", auth: "bearer" } } });
    expect(out.errors).toEqual(["plugin not-shipped: no plugin named not-shipped ships with todo"]);
    expect(out.track).toEqual(["main"]);
  });

  it("gives the always-on shipped plugins for a repo with no config", () => {
    expect(describeConfig().plugins.map((p) => p.name)).toEqual(["pr-link"]);
  });
});
