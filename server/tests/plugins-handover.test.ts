// The Jira bridge and the Jira plugins never both act on a project, a save
// made on a stale page is refused, and the bridge's jobs move into the plugins
// and back in one transaction each.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as handoverGET, POST as handoverPOST } from "@/app/api/projects/[key]/plugins/handover/route";
import { PUT as pluginsPUT } from "@/app/api/projects/[key]/plugins/route";
import { PUT as configPUT } from "@/app/api/projects/[key]/plugins/config/route";
import { saveJiraSettings } from "@/lib/jira/settings";
import { linkedProjects } from "@/lib/jira/sync";
import { heldPlugins } from "@/lib/plugins/exclusive";
import { putInstances, repoPlugins, setShipped, storedGrants, storedInstances } from "@/lib/plugins/store";
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
      move: "jira-triggers", direction: "here", blockers: [], base: { triggers: TRIGGERS, never: ["UAT"], writes: true },
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
    expect((await move("jira-triggers", "back", back.base)).status).toBe(200);
    expect((await outbound()).jira_outbound).toEqual({ writes: true, never: ["UAT"], triggers: TRIGGERS });
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
