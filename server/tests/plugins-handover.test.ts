// The Jira bridge and the Jira plugins never both act on a project, a save
// made on a stale page is refused, and the bridge's jobs move into the plugins
// and back in one transaction each.
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (k: string) => (jar.has(k) ? { value: jar.get(k) } : undefined) }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
import { GET as handoverGET, POST as handoverPOST } from "@/app/api/projects/[key]/plugins/handover/route";
import { PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { PUT as configPUT } from "@/app/api/projects/[key]/plugins/config/route";
import { saveJiraSettings } from "@/lib/jira/settings";
import { saveActionsAction } from "@/app/settings-actions";
import { linkedProjects } from "@/lib/jira/sync";
import { heldPlugins } from "@/lib/plugins/exclusive";
import { projectConnections, putInstances, repoPlugins, setShipped, storedGrants, storedInstances } from "@/lib/plugins/store";
import { itemButtons } from "@/lib/plugin-views";
import { makeMove, planMove } from "@/lib/plugins/handover";
import { publicDns } from "./plugin-github";
import crypto from "node:crypto";
import { item, world, type World } from "./helpers";
import { params, req } from "./plugin-github";

let w: World;

const TRIGGERS = [
  { from: "review", to: "ready-for-qa", jira: "In QA" },
  { from: "qa-approved", to: "ready-to-deploy", jira: "Ready to deploy" },
  { from: "ready-to-deploy", to: "deployed", jira: "Done" },
];

beforeEach(async () => {
  w = await world();
  vi.unstubAllEnvs();
  vi.stubEnv("GITHUB_TOKEN", "gh-token");
  vi.stubEnv("TODO_PLUGIN_OWNERS", "acme");
  vi.stubEnv("TODO_PLUGIN_CONNECTIONS", JSON.stringify({ jira: { http: { url: "https://acme.atlassian.net", auth: "basic" } } }));
  vi.stubEnv("TODO_PLUGIN_SECRET_JIRA", "me@acme.test:tok");
  vi.stubEnv("JIRA_READ_ONLY", "");
  for (const repo of ["acme/web", "acme/api"]) await w.d.query("insert into project_plugin_repos (project, repo, added_by) values ('p', $1, 'alice')", [repo]);
  await w.one("alice", item("I1", { extra: { repo: "acme/web", jira: ["SR-1"] } }));
  await w.one("alice", item("I2", { extra: { repo: "acme/api" } }));
  await w.one("alice", item("I3", {}));
});

const bridge = (o: Record<string, unknown>, polled = false) =>
  w.d.query(`update projects set jira_outbound = $1::jsonb, jira_synced_at = ${polled ? "now()" : "null"} where key = 'p'`,
            [JSON.stringify({ writes: true, never: ["UAT"], triggers: TRIGGERS, ...o })]);
const outbound = async () => (await w.d.query("select jira_outbound, jira_poll from projects where key = 'p'"))[0];
const shipped = async (repo: string) => (await w.d.query("select shipped from plugin_configs where project = 'p' and repo = $1", [repo]))[0]?.shipped ?? [];
const qa = (extra: Record<string, unknown> = {}) => ({ id: "qa", name: "QA", on: [{ status: { from: "review", to: "ready-for-qa" } }], settings: { to: "In QA" }, ...extra });
const put = (body: Record<string, unknown>) => pluginsPUT(req("/api/projects/p/plugins", "PUT", w.tokens.alice, { repo: "acme/web", ...body }), params("p"));
const plan = async (move: string, direction: string, repo = "acme/web") =>
  (await handoverGET(req(`/api/projects/p/plugins/handover?repo=${encodeURIComponent(repo)}&move=${move}&direction=${direction}`, "GET", w.tokens.alice), params("p"))).json();
const move = (move: string, direction: string, base: unknown, repo = "acme/web") =>
  handoverPOST(req("/api/projects/p/plugins/handover", "POST", w.tokens.alice, { repo, move, direction, base }), params("p"));

describe("a save made on a stale page", () => {
  it("is refused with a 409 once the instances it was made on have changed, and goes through while they haven't", async () => {
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    expect((await put({ plugin: "jira-transition", instances: [qa({ dry_run: true })], base: [] })).status).toBe(200);
    const seen = (await repoPlugins(w.d, "p", "acme/web")).plugins.find((p) => p.name === "jira-transition")!.instances;
    expect((await put({ plugin: "jira-transition", instances: [qa({ dry_run: true, settings: { to: "QA" } })], base: seen })).status).toBe(200);
    const stale = await put({ plugin: "jira-transition", instances: [], base: seen });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe("jira-transition's settings were changed by alice since this page loaded; reload to see them");
    expect((await storedInstances(w.d, "p", "acme/web"))["jira-transition"]).toEqual([qa({ dry_run: true, settings: { to: "QA" } })]);
  });

  it("compares with the default a plugin that needs no settings shows when none is stored", async () => {
    await setShipped(w.d, "p", "acme/web", "jira-issue", true, "alice");
    const seen = (await repoPlugins(w.d, "p", "acme/web")).plugins.find((p) => p.name === "jira-issue")!.instances;
    expect(seen.map((i) => i.id)).toEqual(["default"]);
    expect((await put({ plugin: "jira-issue", instances: [{ id: "default", name: "default", dry_run: true }], base: seen })).status).toBe(200);
  });
});

describe("the Jira bridge and jira-transition", () => {
  it("never both send: a live instance is refused while the bridge sends, and test mode isn't", async () => {
    await bridge({});
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    const live = await put({ plugin: "jira-transition", instances: [qa()] });
    expect(live.status).toBe(400);
    expect((await live.json()).error).toMatch(/^the Jira bridge moves this project's tickets, so jira-transition can't send too \(in acme\/web\)/);
    expect((await put({ plugin: "jira-transition", instances: [qa({ dry_run: true })] })).status).toBe(200);
    expect(await heldPlugins(w.d, "p")).toHaveProperty("jira-transition");
    // The server answers for a held plugin, so no CLI runs it live beside the bridge.
    vi.stubEnv("TODO_PLUGIN_SECRET_JIRA", "");
    const listed = (await repoPlugins(w.d, "p", "acme/web")).plugins.find((p) => p.name === "jira-transition")!.instances;
    expect(listed.map((i) => i.server_runs)).toEqual([true]);
  });

  it("leaves other plugins' saves alone in a project where both already send", async () => {
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    await putInstances(w.d, "p", "acme/web", "jira-transition", [qa()], "alice");
    await bridge({});
    await setShipped(w.d, "p", "acme/web", "rest", true, "alice");
    expect((await put({ plugin: "rest", instances: [{ id: "x", name: "X", settings: { connection: "github" } }] })).status).toBe(200);
    expect(await heldPlugins(w.d, "p")).toHaveProperty("jira-transition");
  });

  it("refuses the bridge's sending while jira-transition sends, and switching jira-transition on over a live instance", async () => {
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    await putInstances(w.d, "p", "acme/web", "jira-transition", [qa()], "alice");
    const refused = await saveJiraSettings(w.d, "p", "alice", { writes: true, never: [], triggers: TRIGGERS });
    expect(refused.map((p) => p.message)).toEqual([
      "jira-transition moves this project's tickets in acme/web, so the bridge can't send too. Move its triggers back here from Settings → Automation, or keep sending off."]);
    expect(await saveJiraSettings(w.d, "p", "alice", { writes: false, never: [], triggers: TRIGGERS })).toEqual([]);

    await setShipped(w.d, "p", "acme/web", "jira-transition", false, "alice");
    await bridge({});
    const on = await configPUT(req("/api/projects/p/plugins/config", "PUT", w.tokens.alice, { repo: "acme/web", enable: "jira-transition" }), params("p"));
    expect(on.status).toBe(400);
    expect(await shipped("acme/web")).toEqual([]);
  });
});

describe("moving the bridge's triggers here", () => {
  it("says what it will do: how many, where, sending, and the items no plugin reaches", async () => {
    await bridge({});
    expect(await plan("jira-triggers", "here")).toEqual({
      move: "jira-triggers", direction: "here", blockers: [], base: expect.stringMatching(/^[0-9a-f]{64}$/),
      lines: [
        "3 triggers move here, in order, for acme/api and acme/web; the Jira bridge stops moving tickets.",
        "Never move Jira to UAT comes too.",
        "Send to Jira stays on: from now on jira-transition moves the tickets.",
        "1 item(s) name no GitHub repo: their tickets stop moving.",
      ],
    });
  });

  it("copies the triggers in order with never, keeps sending as it was, switches the plugin on and the bridge's sending off", async () => {
    await bridge({});
    await w.d.query("insert into jira_outbox (project, item_uid, action, payload) values ('p', 'I1', 'transition', '{\"key\":\"SR-1\",\"status\":\"In QA\"}')");
    const res = await move("jira-triggers", "here", (await plan("jira-triggers", "here")).base);
    expect(res.status).toBe(200);
    expect((await outbound()).jira_outbound).toEqual({ writes: false, never: [], triggers: [] });
    for (const repo of ["acme/web", "acme/api"]) {
      expect(await shipped(repo)).toEqual(["jira-transition"]);
      const list = (await storedInstances(w.d, "p", repo))["jira-transition"];
      expect(list.map((i) => [i.on, i.settings, i.dry_run])).toEqual(TRIGGERS.map((t) =>
        [[{ status: { from: t.from, to: t.to } }], { to: t.jira, never: ["UAT"] }, undefined]));
    }
    expect((await w.d.query("select result from jira_outbox"))[0].result).toEqual({ superseded: true });
    expect(await heldPlugins(w.d, "p")).toEqual({});
  });

  it("leaves a status move queued before the move to the bridge, which already sent it", async () => {
    await bridge({});
    await w.d.query(`insert into plugin_events (project, item_uid, repo, event, by)
                     values ('p', 'I1', 'acme/web', '{"type":"status","from":"review","to":"ready-for-qa"}', 'alice')`);
    await move("jira-triggers", "here", (await plan("jira-triggers", "here")).base);
    const [e] = await w.d.query("select finished from plugin_events");
    expect(e.finished).toEqual(expect.arrayContaining(["jira-transition/jira-review-ready-for-qa", "jira-transition/jira-ready-to-deploy-deployed"]));
  });

  it("is refused once jira-transition's own triggers changed since the plan", async () => {
    await bridge({});
    const { base } = await plan("jira-triggers", "here");
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    await putInstances(w.d, "p", "acme/web", "jira-transition", [qa({ dry_run: true })], "bob");
    expect((await move("jira-triggers", "here", base)).status).toBe(409);
  });

  it("keeps the plugin in test mode when the bridge only recorded", async () => {
    await bridge({ writes: false });
    await move("jira-triggers", "here", (await plan("jira-triggers", "here")).base);
    expect((await storedInstances(w.d, "p", "acme/web"))["jira-transition"].every((i) => i.dry_run)).toBe(true);
  });

  it("is refused once the bridge's triggers changed since the plan, and before Jira is connected", async () => {
    await bridge({});
    const { base } = await plan("jira-triggers", "here");
    await bridge({ triggers: TRIGGERS.slice(1) });
    expect((await move("jira-triggers", "here", base)).status).toBe(409);
    vi.stubEnv("TODO_PLUGIN_SECRET_JIRA", "");
    const unready = await plan("jira-triggers", "here");
    expect(unready.blockers).toEqual(["Connect todo to Jira first, in the step above, so nothing goes unsent in between."]);
    expect((await move("jira-triggers", "here", unready.base)).status).toBe(400);
    expect((await outbound()).jira_outbound.triggers).toHaveLength(2);
  });

  it("changes nothing when any part of it fails", async () => {
    await bridge({});
    await w.d.exec(`create or replace function refuse_api() returns trigger language plpgsql as $$
      begin if new.repo = 'acme/api' then raise exception 'refused'; end if; return new; end $$;
      create trigger refuse_api before insert on plugin_instances for each row execute function refuse_api();`);
    try {
      await expect(move("jira-triggers", "here", (await plan("jira-triggers", "here")).base)).rejects.toThrow("refused");
      expect((await outbound()).jira_outbound.triggers).toHaveLength(3);
      expect(await shipped("acme/web")).toEqual([]);
      expect(await storedInstances(w.d, "p", "acme/web")).toEqual({});
    } finally {
      await w.d.exec("drop trigger refuse_api on plugin_instances; drop function refuse_api();");
    }
  });
});

describe("moving the triggers back to the bridge", () => {
  it("gives the bridge this repo's triggers and sending, and switches jira-transition off everywhere", async () => {
    await bridge({});
    await move("jira-triggers", "here", (await plan("jira-triggers", "here")).base);
    const back = await plan("jira-triggers", "back");
    expect(back.lines).toEqual([
      "3 triggers from acme/web go back to the Jira bridge, which moves tickets for every item in the project.",
      "Send to Jira stays on there.",
      "jira-transition is switched off in acme/api and acme/web; its triggers stay, for a later move.",
    ]);
    await w.d.query("insert into jira_outbox (project, item_uid, action, payload) values ('p', 'I1', 'transition', '{\"key\":\"SR-1\",\"status\":\"Old\"}')");
    expect((await move("jira-triggers", "back", back.base)).status).toBe(200);
    expect((await outbound()).jira_outbound).toEqual({ writes: true, never: ["UAT"], triggers: TRIGGERS });
    expect((await w.d.query("select result from jira_outbox"))[0].result).toEqual({ superseded: true });
    expect([await shipped("acme/web"), await shipped("acme/api")]).toEqual([[], []]);
    expect((await storedInstances(w.d, "p", "acme/web"))["jira-transition"]).toHaveLength(3);
  });

  it("refuses a trigger the bridge can't hold", async () => {
    await setShipped(w.d, "p", "acme/web", "jira-transition", true, "alice");
    await putInstances(w.d, "p", "acme/web", "jira-transition", [{ id: "any", name: "any", on: [{ status: { to: "done" } }], settings: { to: "Done" } }], "alice");
    const back = await plan("jira-triggers", "back");
    expect(back.blockers).toEqual(["The trigger * → done can't go back: the Jira bridge needs both statuses."]);
    expect((await move("jira-triggers", "back", back.base)).status).toBe(400);
    expect(await shipped("acme/web")).toEqual(["jira-transition"]);
  });
});

describe("the bridge's polling and jira-issue", () => {
  it("never both mirror: switching jira-issue on is refused while the bridge polls, and stops a poll that never ran", async () => {
    await bridge({ writes: false }, true);
    const on = () => configPUT(req("/api/projects/p/plugins/config", "PUT", w.tokens.alice, { repo: "acme/web", enable: "jira-issue" }), params("p"));
    expect((await on()).status).toBe(400);
    expect(await heldPlugins(w.d, "p")).toHaveProperty("jira-issue");
    await w.d.query("update projects set jira_synced_at = null");
    expect((await on()).status).toBe(200);
    expect((await outbound()).jira_poll).toBe(false);
    expect(await linkedProjects(w.d)).toEqual([]);
  });

  it("moves here with the request grant, out of test mode, and back", async () => {
    await bridge({ writes: false }, true);
    await w.d.query("insert into plugin_configs (project, repo, shipped, updated_by) values ('p', 'acme/web', '{}', 'alice')");
    await w.d.query(`insert into plugin_instances (project, repo, plugin, id, def, updated_by)
                     values ('p', 'acme/web', 'jira-issue', 'default', '{"id":"default","name":"Jira issues","dry_run":true}', 'alice')`);
    const here = await plan("jira-polling", "here");
    expect(here.lines[0]).toBe("jira-issue shows the status, comments and images of the 1 linked ticket in acme/api and acme/web; the Jira bridge stops polling this project.");
    expect((await move("jira-polling", "here", here.base)).status).toBe(200);
    expect((await outbound()).jira_poll).toBe(false);
    expect((await storedInstances(w.d, "p", "acme/web"))["jira-issue"]).toEqual([{ id: "default", name: "Jira issues", settings: {} }]);
    expect(await storedGrants(w.d, "p", "acme/web")).toEqual({ "jira-issue": ["post-request"] });
    expect(await shipped("acme/api")).toEqual(["jira-issue"]);
    expect(await heldPlugins(w.d, "p")).toEqual({});

    expect((await move("jira-polling", "back", (await plan("jira-polling", "back")).base)).status).toBe(200);
    expect((await outbound()).jira_poll).toBe(true);
    expect([await shipped("acme/web"), await shipped("acme/api")]).toEqual([[], []]);
  });
});

const ACTIONS = [
  { id: "rosm", name: "ROSM", kind: "watchtower", runner: "server", auto: [], base: "https://wt.example", dir: "/src/rosm", prompt: "/todo {{item.id}}" },
  { id: "rosm-wip", name: "ROSM - in Progress", kind: "watchtower", runner: "server", auto: [{ from: "*", to: "in-progress" }], base: "https://wt.example",
    dir: "{{item.dir}}", prompt: "/todo {{item.id}} go", resume: true, resumePrompt: "/todo {{item.id}}" },
  { id: "notify", name: "Notify", kind: "rest", runner: "server", auto: [], method: "POST", url: "https://hooks.example/n/{{item.id}}",
    headers: { Authorization: "Bearer s3cret" }, body: '{"id": {{item.id|json}}}' },
];

describe("moving the General tab's Actions here", () => {
  beforeEach(async () => {
    vi.stubEnv("TODO_SECRET_KEY", crypto.randomBytes(32).toString("base64"));
    await w.d.query("update projects set actions = $1::jsonb where key = 'p'", [JSON.stringify(ACTIONS)]);
  });
  const actions = async () => (await w.d.query("select actions, actions_moved from projects where key = 'p'"))[0];
  const planned = (move: "watchtower" | "rest", direction: "here" | "back") => planMove(w.d, "p", move, direction, "acme/web", { lookup: publicDns });
  const made = async (move: "watchtower" | "rest", direction: "here" | "back") =>
    makeMove(w.d, "p", move, direction, "acme/web", (await planned(move, direction)).base, "alice", { lookup: publicDns });

  it("says what moves, where, and the connection it adds", async () => {
    const plan = await planned("watchtower", "here");
    expect(plan.blockers).toEqual([]);
    expect(plan.lines).toEqual([
      '2 Actions move here as watchtower-session buttons for acme/api and acme/web: "ROSM" and "ROSM - in Progress".',
      "They leave the General tab, so items never show both buttons or fire both.",
      "1 of them fires on its status moves here too.",
      "Adds this project's watchtower connection at https://wt.example.",
      "1 item(s) name no GitHub repo: they get no button.",
    ]);
  });

  it("turns the Watchtower Actions into live buttons in every repo, in one move, so items never get both", async () => {
    await made("watchtower", "here");
    const { actions: left, actions_moved: moved } = await actions();
    expect(left.map((a: { id: string }) => a.id)).toEqual(["notify"]);
    expect(moved.map((m: { action: { id: string }; plugin: string; repos: string[] }) => [m.action.id, m.plugin, m.repos]))
      .toEqual([["rosm", "watchtower-session", ["acme/api", "acme/web"]], ["rosm-wip", "watchtower-session", ["acme/api", "acme/web"]]]);
    for (const repo of ["acme/web", "acme/api"]) {
      expect(await shipped(repo)).toEqual(["watchtower-session"]);
      expect((await storedInstances(w.d, "p", repo))["watchtower-session"].map((i) => [i.id, i.on, i.dry_run])).toEqual([
        ["action-rosm", ["manual"], undefined], ["action-rosm-wip", ["manual", { status: { from: "*", to: "in-progress" } }], undefined]]);
    }
    expect((await projectConnections(w.d, "p")).map((c) => [c.name, c.def])).toEqual([["watchtower", { http: { url: "https://wt.example" } }]]);
    const [i1] = await w.d.query("select * from items where uid = 'I1'");
    expect((await itemButtons(w.d, "p", i1)).map((b) => b.label)).toEqual(["ROSM", "ROSM - in Progress"]);
    await w.d.exec("delete from plugin_events; delete from action_runs");
    await w.one({ handle: "alice", unconditional: true }, { op: "set", entity: "item", uid: "I1", item_uid: "I1", data: { status: "in-progress" } });
    expect(await w.d.query("select 1 from action_runs")).toEqual([]);
    expect((await w.d.query("select event from plugin_events")).map((e) => e.event)).toContainEqual({ type: "status", from: "todo", to: "in-progress" });
  });

  it("moves a REST Action's credential into the connection it adds, out of the button's headers", async () => {
    await made("rest", "here");
    const [inst] = (await storedInstances(w.d, "p", "acme/web"))["rest"];
    expect(inst).toMatchObject({ id: "action-notify", name: "Notify", settings: { connection: "rest-hooks-example", method: "POST", path: "/n/{{item.id}}" } });
    expect(inst.settings).not.toHaveProperty("headers");
    const [conn] = await projectConnections(w.d, "p");
    expect([conn.name, conn.def, conn.held]).toEqual(["rest-hooks-example", { http: { url: "https://hooks.example", auth: "bearer" } }, true]);
    expect((await actions()).actions.map((a: { id: string }) => a.id)).toEqual(["rosm", "rosm-wip"]);
  });

  it("keeps a General tab loaded before the move from bringing a moved Action back", async () => {
    await made("watchtower", "here");
    jar.set("todo_token", w.tokens.alice);
    const stale = await saveActionsAction("p", ACTIONS as never);
    expect(stale.ok).toBe(false);
    expect(stale.problems.map((p) => p.message)).toEqual([
      "ROSM moved to Settings → Automation; move it back from there, or give this one another id.",
      "ROSM - in Progress moved to Settings → Automation; move it back from there, or give this one another id."]);
    expect((await actions()).actions.map((a: { id: string }) => a.id)).toEqual(["notify"]);
  });

  it("is refused once the Actions changed since the plan", async () => {
    const { base } = await planned("watchtower", "here");
    await w.d.query("update projects set actions = $1::jsonb where key = 'p'", [JSON.stringify(ACTIONS.slice(1))]);
    await expect(makeMove(w.d, "p", "watchtower", "here", "acme/web", base, "alice", { lookup: publicDns })).rejects.toThrow(/changed since this page loaded/);
  });

  it("keeps the default button a repo already had, and leaves the plugin on there when the Actions move back", async () => {
    await setShipped(w.d, "p", "acme/api", "watchtower-session", true, "alice");
    await made("watchtower", "here");
    expect((await storedInstances(w.d, "p", "acme/api"))["watchtower-session"].map((i) => i.id)).toEqual(["default", "action-rosm", "action-rosm-wip"]);
    await made("watchtower", "back");
    expect((await storedInstances(w.d, "p", "acme/api"))["watchtower-session"].map((i) => i.id)).toEqual(["default"]);
    expect([await shipped("acme/api"), await shipped("acme/web")]).toEqual([["watchtower-session"], []]);
  });

  it("marks a status move queued before the move as done for the new buttons, since the Action already fired for it", async () => {
    await w.d.query(`insert into plugin_events (project, item_uid, repo, event, by)
                     values ('p', 'I1', 'acme/web', '{"type":"status","from":"todo","to":"in-progress"}', 'alice')`);
    await made("watchtower", "here");
    const [e] = await w.d.query("select finished from plugin_events");
    expect(e.finished).toEqual(["watchtower-session/action-rosm", "watchtower-session/action-rosm-wip"]);
  });

  it("never sends a REST Action's credential to the page in the plan", async () => {
    const plan = await planned("rest", "here");
    expect(JSON.stringify(plan)).not.toContain("s3cret");
  });

  it("moves back: the Actions return as they were, their buttons go, and the plugin is switched off where none is left", async () => {
    await setShipped(w.d, "p", "acme/web", "watchtower-session", true, "alice");
    await putInstances(w.d, "p", "acme/web", "watchtower-session", [{ id: "mine", name: "Mine", settings: {} }], "alice");
    await made("watchtower", "here");
    const back = await planned("watchtower", "back");
    expect(back.lines).toEqual([
      '2 Actions go back to the General tab as they were before the move: "ROSM" and "ROSM - in Progress".',
      "Their watchtower-session buttons are removed from acme/api and acme/web, with any change made to them here; watchtower-session is switched off where no other button is left.",
    ]);
    await made("watchtower", "back");
    const { actions: all, actions_moved: moved } = await actions();
    expect(all.map((a: { id: string }) => a.id)).toEqual(["notify", "rosm", "rosm-wip"]);
    expect(moved).toEqual([]);
    expect((await storedInstances(w.d, "p", "acme/web"))["watchtower-session"].map((i) => i.id)).toEqual(["mine"]);
    expect([await shipped("acme/web"), await shipped("acme/api")]).toEqual([["watchtower-session"], []]);
  });
});
