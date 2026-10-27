// Porting Actions and Jira triggers to plugin instances, and replaying recent
// moves through the old code and the instances in dry-run to show parity.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "@/lib/gitfacts";
import { describeParity, parity } from "@/lib/plugins/parity";
import { describePlan, planPort, writePlan } from "@/lib/plugins/port";
import { loadConfig, storedGrants, storedInstances } from "@/lib/plugins/store";
import { item, world, type World } from "./helpers";
import { publicDns } from "./plugin-github";

let w: World;

const WT = "https://leaf-rain.shrew-goblin.ts.net/watchtower/latest";
const WT_API = "http://127.0.0.1:10010/latest";
const LONG_PROMPT = "/todo {{item.id}}\n\ncontext: this is an invocation from the todo app\n\n- commit and push all work\n- conclude each round with a brief recap";

const ACTIONS = [
  { id: "notify", name: "Notify QA", kind: "rest", runner: "server", auto: [{ from: "review", to: "in-qa" }], method: "POST",
    url: "https://hooks.example/notify/{{item.id|url}}?from={{item.from|url}}", headers: { "X-Token": "abc", "Content-Type": "application/json" },
    body: '{"text": {{item.title|json}}, "status": "{{item.status}}", "dev": {{item.developer|json}}}' },
  { id: "ping", name: "Ping", kind: "rest", runner: "server", auto: [], method: "GET", url: "https://api.example/ping",
    headers: { Authorization: "Bearer s3cr3t-bearer" }, body: "" },
  { id: "send-to-watchtower", name: "ROSM", kind: "watchtower", runner: "server", auto: [], base: WT, dir: "{{project.dir}}",
    prompt: LONG_PROMPT, model: "opus", resume: true, resumePrompt: "/todo {{item.id}}" },
];
const OUTBOUND = {
  writes: true, never: ["Done", "UAT"],
  triggers: [
    { from: "review", to: "in-qa", jira: "QA" },
    { from: "in-qa", to: "qa-rejected", jira: "In Development" },
    { from: "in-qa", to: "requested", jira: "In Development" },
    { from: "ready-to-deploy", to: "deployed", jira: "Done" },
  ],
};

beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", "");
  vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "");
  vi.stubEnv("TODO_SECRET_KEY", "");
  vi.stubEnv("JIRA_BASE_URL", "https://acme.atlassian.net");
  vi.stubEnv("JIRA_EMAIL", "me@acme.test");
  vi.stubEnv("JIRA_API_TOKEN", "tok");
  vi.stubEnv("WATCHTOWER_URL", "");
  await w.d.query("update projects set actions = $1::jsonb, jira_outbound = $2::jsonb where key = 'p'", [JSON.stringify(ACTIONS), JSON.stringify(OUTBOUND)]);
  await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', 'acme/web', 'alice')");
  await w.d.query("insert into checkouts (handle, project, repo, dir) values ('alice', 'p', 'acme/web', '/work/web')");
  await w.one("alice", item("I1", { status: "review", developer: "alice", extra: { repo: "acme/web", jira: ["SR-1"] } }));
  await w.one("alice", item("I2", { status: "in-qa", extra: { repo: "acme/web", jira: ["SR-2", "SR-3"] } }));
  await w.one("alice", item("I3", { status: "in-progress" }));
});

/** Watchtower and Jira as recorded answers, for reads only; the parity check holds every write back. */
function services() {
  const seen: string[] = [];
  const f = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(`${init.method ?? "GET"} ${url}`);
    if (url === `${WT_API}/api/roster`) return Response.json({ sessions: [{ id: "s7", name: "todo: i1", state: "stopped", lastActivity: 3 }] });
    const issue = url.match(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/(SR-\d+)\?fields=status$/);
    if (issue) return Response.json({ fields: { status: { name: "Open" } } });
    const transitions = url.match(/^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/(SR-\d+)\/transitions$/);
    if (transitions) return Response.json({ transitions: [{ id: "161", to: { name: "QA" } }, { id: "21", to: { name: "In Development" } }] });
    return new Response("not recorded", { status: 404 });
  }) as Fetch;
  return { f, seen };
}

const move = (uid: string, status: string, handle = "alice") =>
  w.one({ handle, unconditional: true }, { op: "set", entity: "item", uid, item_uid: uid, data: { status } });

describe("plugins-port", () => {
  it("turns each Action and Jira trigger into an instance, in trigger order, and says what the server still needs", async () => {
    const plan = await planPort(w.d, "p", { lookup: publicDns });
    expect(plan.repos).toEqual(["acme/web"]);
    expect(plan.instances.rest[0]).toEqual({
      id: "action-notify", name: "Notify QA", on: ["manual", { status: { from: "review", to: "in-qa" } }],
      settings: { connection: "rest-hooks-example", method: "POST", path: "/notify/{{item.id}}?from={{event.from}}",
                  headers: "Content-Type: application/json",
                  body: { text: "{{item.title}}", status: "{{item.status}}", dev: "{{item.developer}}" } },
      dry_run: true,
    });
    expect(plan.instances["watchtower-session"]).toEqual([{
      id: "action-send-to-watchtower", name: "ROSM", on: ["manual"],
      settings: { dir: "/work/web", prompt: LONG_PROMPT, link: WT, model: "opus", resumePrompt: "/todo {{item.id}}" },
      dry_run: true,
    }]);
    expect(plan.instances["jira-transition"].map((i) => [i.id, i.on, i.settings])).toEqual([
      ["jira-review-in-qa", [{ status: { from: "review", to: "in-qa" } }], { to: "QA", never: ["Done", "UAT"] }],
      ["jira-in-qa-qa-rejected", [{ status: { from: "in-qa", to: "qa-rejected" } }], { to: "In Development", never: ["Done", "UAT"] }],
      ["jira-in-qa-requested", [{ status: { from: "in-qa", to: "requested" } }], { to: "In Development", never: ["Done", "UAT"] }],
      ["jira-ready-to-deploy-deployed", [{ status: { from: "ready-to-deploy", to: "deployed" } }], { to: "Done", never: ["Done", "UAT"] }],
    ]);
    expect(plan.instances["jira-issue"]).toEqual([{ id: "default", name: "Jira issues", dry_run: true }]);
    expect(plan.grants).toEqual({ "jira-issue": ["post-request"] });
    expect(Object.values(plan.instances).flat().every((i) => i.dry_run === true)).toBe(true);
    expect(plan.instances.rest[1].settings).toEqual({ connection: "rest-api-example", method: "GET", path: "/ping" });
    expect(plan.connections).toEqual({
      "rest-hooks-example": { http: { url: "https://hooks.example", auth: "header:X-Token" } },
      "rest-api-example": { http: { url: "https://api.example", auth: "bearer" } },
      watchtower: { http: { url: WT_API } },
      jira: { http: { url: "https://acme.atlassian.net", auth: "basic" } },
    });
    expect(plan.secrets).toEqual({ "rest-hooks-example": "the X-Token header of action notify",
                                   "rest-api-example": "the bearer token in the Authorization header of action ping",
                                   jira: "JIRA_EMAIL:JIRA_API_TOKEN" });
    expect(plan.allowHosts).toEqual(["127.0.0.1:10010"]);
    expect(plan.notes).toContain("1 item(s) name no GitHub repo, so no plugin runs for them");
    expect(plan.notes).toContain('action send-to-watchtower dir: {{project.dir}} is fixed as "/work/web", its value now; it no longer follows the CLI\'s reports');
    const text = describePlan(plan);
    expect(text).toContain("--write switches on, in each repo: rest, watchtower-session, jira-transition, jira-issue");
    expect(text).toContain("TODO_PLUGIN_SECRET_JIRA=<JIRA_EMAIL:JIRA_API_TOKEN>");
    expect(text).toContain("TODO_PLUGIN_ALLOW_HOSTS needs 127.0.0.1:10010");
    expect(text).toContain("every instance is stored in dry-run");
    expect(text).toContain("TODO_PLUGIN_SECRET_REST_HOOKS_EXAMPLE=<the X-Token header of action notify>");
    expect(text).not.toMatch(/abc|s3cr3t/);
  });

  it("writes only with --write: switches the plugins on in the repo's config, beside instances already stored", async () => {
    const plan = await planPort(w.d, "p", { lookup: publicDns });
    expect(await storedInstances(w.d, "p", "acme/web")).toEqual({});
    expect((await loadConfig(w.d, "p", "acme/web")).shipped).toEqual([]);
    await w.d.query(`insert into plugin_instances (project, repo, plugin, id, def, position, updated_by, secret_keys)
                     values ('p', 'acme/web', 'rest', 'mine', '{"id": "mine", "name": "Mine", "settings": {"connection": "x", "path": "/"}}', 0, 'bob', '{}')`);
    expect(await writePlan(w.d, plan, "alice")).toEqual([]);
    expect((await loadConfig(w.d, "p", "acme/web")).shipped).toEqual(["rest", "watchtower-session", "jira-transition", "jira-issue"]);
    const stored = await storedInstances(w.d, "p", "acme/web");
    expect(stored.rest.map((i) => i.id)).toEqual(["mine", "action-notify", "action-ping"]);
    expect(stored["jira-transition"].map((i) => i.id)).toEqual(["jira-review-in-qa", "jira-in-qa-qa-rejected", "jira-in-qa-requested",
                                                               "jira-ready-to-deploy-deployed"]);
    expect(await storedGrants(w.d, "p", "acme/web")).toEqual({ "jira-issue": ["post-request"] });
  });
});

describe("plugins-parity", () => {
  beforeEach(() => {
    vi.stubEnv("TODO_PLUGIN_SECRET_REST_HOOKS_EXAMPLE", "abc");
    vi.stubEnv("TODO_PLUGIN_ALLOW_HOSTS", "127.0.0.1:10010");
    vi.stubEnv("TODO_PLUGIN_SECRET_JIRA", "me@acme.test:tok");
  });

  it("replays status moves and manual runs through the old code and the instances, and they send the same", async () => {
    await move("I1", "in-qa");
    await move("I2", "qa-rejected");
    await move("I3", "review");
    await w.d.query(`insert into action_runs (project, item_uid, action_id, name, trigger, by, request)
                     values ('p', 'I1', 'send-to-watchtower', 'ROSM', 'manual', 'alice', '{}'::jsonb)`);
    const net = services();
    const result = await parity(w.d, "p", { since: new Date(Date.now() - 3_600_000), fetch: net.f, lookup: publicDns });
    expect(describeParity(result).split("\n").map((l) => l.replace(/^\d\S+ /, ""))).toEqual([
      "i1 review → in-qa by alice: same (2 sends)",
      "i2 in-qa → qa-rejected by alice: same (2 sends)",
      "i3 in-progress → review by alice: same (0 sends)",
      "i1 manual send-to-watchtower by alice: same (1 send)",
      "4 replayed, 0 different",
    ]);
    const [first, , , manual] = result.cases;
    expect(first.old.sort()).toEqual([
      'action notify: POST https://hooks.example/notify/i1?from=review headers {"content-type":"application/json","x-token":"***"} {"dev":"alice","status":"in-qa","text":"Item I1"}',
      "jira SR-1 → QA",
    ]);
    expect(manual.plugins).toEqual([`action send-to-watchtower: POST ${WT_API}/api/sessions/s7/resume`]);
    // Reads only: the roster, and each Jira issue and its transitions; no write reached the network.
    expect(net.seen.every((s) => s.startsWith("GET "))).toBe(true);
  });

  it("follows apply.ts for a bridge: its own move runs no plugin, its bounce back to requested does; Actions still fire on its move", async () => {
    await move("I1", "in-qa", "jira-bridge");
    await w.one("alice", { op: "create", entity: "note", uid: "R1", item_uid: "I2", data: { kind: "ticket-request", text: "v1" } });
    await w.one({ handle: "jira-bridge", bridge: true, unconditional: true },
                { op: "create", entity: "note", uid: "R2", item_uid: "I2", data: { kind: "ticket-request", text: "v2" } });
    const result = await parity(w.d, "p", { since: new Date(Date.now() - 3_600_000), fetch: services().f, lookup: publicDns });
    const [bridged, bounced] = result.cases;
    expect(bridged).toMatchObject({ item: "i1", same: false, plugins: [], old: [expect.stringMatching(/^action notify: POST/)] });
    expect(bounced).toMatchObject({ item: "i2", trigger: "in-qa → requested by jira-bridge", same: true,
                                    old: ["jira SR-2 → In Development", "jira SR-3 → In Development"] });
    expect(result.diffs).toBe(1);
  });
});
