// When a failed run may run again, and what a run knows of itself: the
// instance, what set it off, its time, and a call's status and URL.
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugins } from "@/lib/plugins/load";
import { runInstance } from "@/lib/plugins/host";
import type { PluginItem, RunInput } from "@/lib/plugins/types";
import { fakeServer, type FakeServer, type Recorded } from "./plugin-fakes";

const ITEM: PluginItem = { id: "fix", uid: "U", title: "t", status: "in-qa", branches: [], jira: ["SR-1"], links: [] };
const servers: FakeServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function run(yaml: string, responses: Recorded[], over: Partial<RunInput> = {}) {
  const server = await fakeServer(responses);
  servers.push(server);
  const [name, plugin] = Object.entries(loadPlugins(yaml).plugins!)[0];
  return runInstance({ plugin, name, instance: { id: "i1", name: "Notify QA" }, item: ITEM, event: { type: "status", from: "review", to: "in-qa" },
                       connections: { api: { kind: "http", url: server.url } }, dryRun: false, ...over });
}

const TWO_WRITES = `plugins:\n  p:\n    connections: [api]\n    steps:\n      - http: {method: POST, path: /one}\n      - http: {method: POST, path: /two}\n`;

describe("a failed run", () => {
  it("may run again when its first write failed for now", async () => {
    for (const status of [500, 503, 429]) {
      const r = await run(TWO_WRITES, [{ method: "POST", path: "/one", status, text: "busy" }]);
      expect([r.error, r.transient]).toEqual([`api: POST /one answered ${status}: busy`, true]);
    }
  });

  it("never runs again once a write went through", async () => {
    const r = await run(TWO_WRITES, [{ method: "POST", path: "/one", body: {} }, { method: "POST", path: "/two", status: 503, text: "busy" }]);
    expect([r.error, r.transient]).toEqual(["api: POST /two answered 503: busy", undefined]);
  });

  it("stops at a fail step with its message, and may run again unless a write went through", async () => {
    const yaml = `plugins:\n  p:\n    connections: [api]\n    per: jira\n    steps:\n      - name: w\n        when: "settings.write"\n        http: {method: POST, path: /w}\n      - fail: "no transition from {{item.status}} to QA"\n    settings: {write: {label: W, type: toggle}}\n`;
    const first = await run(yaml, []);
    expect(first).toMatchObject({ error: "issue SR-1: no transition from in-qa to QA", transient: true,
                                  failure: { message: "no transition from in-qa to QA", pass: { issue: "SR-1" } } });
    const after = await run(yaml, [{ method: "POST", path: "/w", body: {} }], { instance: { id: "i1", name: "x", settings: { write: true } } });
    expect(after.transient).toBeUndefined();
  });
});

describe("a run's own scope", () => {
  it("names its instance, what set it off and its time, and a full call's method, URL and status", async () => {
    const yaml = `plugins:
  p:
    connections: [api]
    steps:
      - {name: sent, http: {method: POST, path: "/n/{{item.id}}", full: true}}
    attach:
      - {when: sent, key: "sent:{{run.at}}", log: "action {{instance.name}} ({{trigger}}): {{sent.method}} {{sent.url}} → {{sent.status}}"}
`;
    const r = await run(yaml, [{ method: "POST", path: "/n/fix", status: 202, body: { ok: 1 } }]);
    const [log] = r.attached as { key: string; text: string }[];
    expect(log.text).toMatch(/^action Notify QA \(review → in-qa\): POST http:\/\/127\.0\.0\.1:\d+\/n\/fix → 202$/);
    expect(log.key).toMatch(/^sent:\d{4}-\d\d-\d\dT/);
    const manual = await run(yaml.replace("{{trigger}}", "{{trigger}}|{{sent.body.ok}}"), [{ method: "POST", path: "/n/fix", body: { ok: 1 } }],
      { event: { type: "manual", instance: "i1" } });
    expect((manual.attached[0] as { text: string }).text).toMatch(/\(manual\|1\)/);
  });
});
