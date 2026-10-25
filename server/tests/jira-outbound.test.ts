import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as flushRoute } from "@/app/api/jira/flush/route";
import { flushJira } from "@/lib/jira/flush";
import { describeMove, outboundRules, outboundTarget, validateRules } from "@/lib/jira/rules";
import { dryRuns, loadJiraSettings, saveJiraSettings } from "@/lib/jira/settings";
import { STATUSES } from "@/lib/model";
import { item, set, world, type World } from "./helpers";

let w: World;
const ENV = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "bot@acme.test", JIRA_API_TOKEN: "tok", CRON_SECRET: "cron" };
const RULES = {
  writes: true, never: ["Open"],
  triggers: [
    { from: "todo", to: "in-progress", jira: "In Progress" },
    { from: "in-progress", to: "in-qa", jira: "In QA" },
    { from: "in-progress", to: "requested", jira: "To Do" },
    { from: "in-qa", to: "in-progress", jira: "Open" },
  ],
};

beforeEach(async () => {
  w = await world();
  Object.assign(process.env, ENV);
  await w.d.query("update projects set jira_mode = 'links' where key = 'p'");
  await outbound();
  await w.apply("alice", item("A", { extra: { jira: ["WEB-7"] } }));
});
afterEach(() => {
  for (const k of [...Object.keys(ENV), "JIRA_READ_ONLY"]) delete process.env[k];
});

const outbound = (patch: Record<string, unknown> = {}) =>
  w.d.query("update projects set jira_outbound = $1::jsonb where key = 'p'", [JSON.stringify({ ...RULES, ...patch })]);
const move = async (uid: string, status: string) => {
  const [it] = await w.d.query("select versions from items where uid = $1", [uid]);
  return w.one("alice", set("item", uid, uid, { status }, { status: it.versions.status }));
};
const rows = () => w.d.query("select action, payload->>'status' as status, done_at is null as pending, result from jira_outbox order by id");

function fakeJira(transitions: any[] = [{ id: "1", to: { name: "In Progress" } }, { id: "2", to: { name: "In QA" } }], current = "To Do") {
  const calls: { method: string; url: string; body?: any }[] = [];
  const impl = vi.fn(async (url: any, init: any) => {
    calls.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
    if (String(url).endsWith("?fields=status")) return new Response(JSON.stringify({ fields: { status: { name: current } } }));
    if (String(url).endsWith("/transitions") && init.method === "GET") return new Response(JSON.stringify({ transitions }));
    return new Response(null, { status: 204 });
  });
  return { calls, posts: () => calls.filter((c) => c.method === "POST"), impl: impl as unknown as typeof fetch };
}

describe("jira delivery", () => {
  it("sends a triggered transition as the integration account", async () => {
    await move("A", "in-progress");
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 1, failed: 0 });
    expect(jira.calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue/WEB-7?fields=status");
    expect(jira.posts()).toEqual([{ method: "POST", url: "https://acme.atlassian.net/rest/api/3/issue/WEB-7/transitions",
                                    body: { transition: { id: "1" } } }]);
    const auth = (jira.impl as any).mock.calls[0][1].headers.authorization;
    expect(auth).toBe("Basic " + Buffer.from("bot@acme.test:tok").toString("base64"));
  });

  it("skips a transition Jira has already made", async () => {
    await move("A", "in-progress");
    const jira = fakeJira([], "In Progress");
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 1, failed: 0 });
    expect(jira.posts()).toEqual([]);
  });

  it("queues nothing for a bridge-sourced move", async () => {
    const [it] = await w.d.query("select versions from items where uid = 'A'");
    const r = await w.one({ handle: "jira-bridge", unconditional: true, bridge: true },
      set("item", "A", "A", { status: "in-progress" }, { status: it.versions.status }));
    expect(r.status).toBe("applied");
    expect(await rows()).toEqual([]);
  });

  it("queues nothing for a move no trigger names, or for an unlinked item", async () => {
    await move("A", "blocked");
    await w.apply("alice", item("I9"));
    await move("I9", "in-progress");
    expect(await rows()).toEqual([]);
  });

  it("retries a failing delivery a bounded number of times", async () => {
    await move("A", "in-progress");
    const broken = vi.fn(async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    await flushJira(w.d, broken);
    await flushJira(w.d, broken);
    expect((broken as any).mock.calls.length).toBe(1);          // backing off
    for (let i = 0; i < 6; i++) {
      await w.d.query("update jira_outbox set next_attempt_at = null");
      await flushJira(w.d, broken);
    }
    const [row] = await w.d.query("select attempts, error, done_at from jira_outbox");
    expect(row.attempts).toBe(5);
    expect(row.done_at).toBeNull();
    expect(row.error).toContain("500");
    expect((broken as any).mock.calls.length).toBe(5);
    const [log] = await w.d.query("select text from logs where item_uid = 'A'");
    expect(log.text).toMatch(/^Jira transition for WEB-7 gave up after 5 attempts/);
  });

  it("guards the cron route with CRON_SECRET", async () => {
    expect((await flushRoute(new Request("http://x/api/jira/flush"))).status).toBe(401);
    const ok = await flushRoute(new Request("http://x/api/jira/flush", { headers: { authorization: "Bearer cron" } }));
    expect(ok.status).toBe(200);
  });

  it("supersedes an older pending transition", async () => {
    await move("A", "in-progress");
    await move("A", "in-qa");
    const r = await w.d.query("select payload->>'status' as s, done_at is not null as done from jira_outbox order by id");
    expect(r).toEqual([{ s: "In Progress", done: true }, { s: "In QA", done: false }]);
  });

  it("never sends a row twice when flushes overlap", async () => {
    await move("A", "in-progress");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    const slow = (async (url: any, init: any) => {
      if (init.method === "POST") {
        posts++;
        await gate;
        return new Response(null, { status: 204 });
      }
      if (String(url).endsWith("?fields=status")) return new Response(JSON.stringify({ fields: { status: { name: "To Do" } } }));
      return new Response(JSON.stringify({ transitions: [{ id: "1", to: { name: "In Progress" } }] }));
    }) as unknown as typeof fetch;
    const first = flushJira(w.d, slow);
    await new Promise((r) => setTimeout(r, 50));
    await flushJira(w.d, slow);
    release();
    await first;
    expect(posts).toBe(1);
  });

  it("never lands an older transition after a newer one", async () => {
    await move("A", "in-progress");
    const [a] = await w.d.query("select id from jira_outbox");
    await w.d.query("update jira_outbox set claimed_at = now(), attempts = 1 where id = $1", [a.id]);
    await move("A", "in-qa");
    const sent: string[] = [];
    const impl = (async (url: any, init: any) => {
      if (String(url).endsWith("?fields=status")) return new Response(JSON.stringify({ fields: { status: { name: "To Do" } } }));
      if (init.method === "GET") return new Response(JSON.stringify({ transitions: [
        { id: "1", to: { name: "In Progress" } }, { id: "2", to: { name: "In QA" } }] }));
      sent.push(JSON.parse(init.body).transition.id);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await flushJira(w.d, impl);
    expect(sent).toEqual([]);                                   // waits for the in-flight older row
    await w.d.query("update jira_outbox set claimed_at = null, error = 'boom' where id = $1", [a.id]);
    await flushJira(w.d, impl);
    expect(sent).toEqual(["2"]);                                // the older one is superseded, never sent
    const r = await w.d.query("select result->>'superseded' as s from jira_outbox order by id");
    expect(r[0].s).toBe("true");
  });

  it("gives up a row whose last attempt died mid-flight", async () => {
    await move("A", "in-progress");
    await w.d.query("update jira_outbox set attempts = 5, claimed_at = now() - interval '10 minutes'");
    await flushJira(w.d, (async () => new Response("{}")) as unknown as typeof fetch);
    const [log] = await w.d.query("select text from logs");
    expect(log.text).toContain("gave up");
  });
});

describe("jira trigger rules", () => {
  it("picks the trigger for an exact move, never a never-target", () => {
    const r = outboundRules(RULES)!;
    expect(outboundTarget(r, "todo", "in-progress")).toBe("In Progress");
    expect(outboundTarget(r, "in-triage", "in-progress")).toBeNull();
    expect(outboundTarget(r, "in-qa", "in-progress")).toBeNull();
    expect(describeMove(r, "todo", "in-progress")).toBe("moves Jira to In Progress.");
    expect(describeMove(r, "requested", "in-triage")).toBe("no trigger.");
    expect(describeMove(r, "in-qa", "in-progress")).toBe("the trigger is ignored: Open is never moved to.");
  });

  it("validates triggers, warning on statuses Jira doesn't have", () => {
    const bad = validateRules(outboundRules({ never: ["Open"], triggers: [
      { from: "todo", to: "done", jira: "Open" }, { from: "todo", to: "done", jira: "B" },
      { from: "todo", to: "nope", jira: "A" }, { from: "todo", to: "review", jira: "" }] })!, STATUSES, ["A", "Open"]);
    expect(bad.filter((p) => p.level === "error").map((p) => p.message)).toEqual([
      "The trigger todo → done moves Jira to Open, which is never moved to.", "todo → done has two triggers.",
      "The trigger todo → nope names nope, which isn't a todo status.", "The trigger todo → review has no Jira status.",
    ]);
    expect(bad.filter((p) => p.level === "warning").map((p) => p.message)).toEqual(["Jira has no status B."]);
    expect(validateRules(outboundRules({ ...RULES, triggers: RULES.triggers.slice(0, 3) })!, STATUSES)).toEqual([]);
  });

  it("records matching moves as dry runs while writes are off, and sends nothing", async () => {
    await outbound({ writes: false });
    await move("A", "in-progress");
    await move("A", "blocked");
    await move("A", "in-progress");
    await move("A", "in-qa");
    await move("A", "in-progress");
    expect(await rows()).toEqual([
      { action: "transition", status: "In Progress", pending: false, result: { dry_run: true } },
      { action: "transition", status: "In QA", pending: false, result: { dry_run: true } },
    ]);
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 0, failed: 0 });
    expect(jira.posts()).toEqual([]);
  });

  it("is a dry run under JIRA_READ_ONLY whatever the project says", async () => {
    process.env.JIRA_READ_ONLY = "1";
    await move("A", "in-progress");
    expect(await rows()).toEqual([{ action: "transition", status: "In Progress", pending: false, result: { dry_run: true } }]);
  });

  it("refuses a queued never-target at delivery", async () => {
    await w.d.query("insert into jira_outbox (project, item_uid, action, payload) values ('p', 'A', 'transition', '{\"key\":\"WEB-7\",\"status\":\"open\"}')");
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 0, failed: 0 });
    expect(jira.posts()).toEqual([]);
    expect((await rows())[0]).toMatchObject({ pending: false, result: { refused: "never" } });
  });

  it("holds rows queued before writes were switched off", async () => {
    await move("A", "in-progress");
    await outbound({ writes: false });
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 0, failed: 0 });
    expect((await rows())[0]).toMatchObject({ pending: true });
  });

  it("never lets a dry run supersede a real queued move", async () => {
    await move("A", "in-progress");
    await outbound({ writes: false });
    await move("A", "in-qa");
    await outbound();
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 1, failed: 0 });
    expect(jira.posts()).toHaveLength(1);
  });

  it("saves valid settings with a stamp, stores nothing when invalid, and lists dry runs", async () => {
    await w.d.query("update projects set jira_outbound = null where key = 'p'");
    const statuses = vi.fn(async () => new Response(JSON.stringify([{ statuses: [{ name: "To Do" }, { name: "In Progress" }] }])));
    const bad = await saveJiraSettings(w.d, "p", "alice",
      outboundRules({ never: ["Open"], triggers: [{ from: "todo", to: "done", jira: "Open" }] })!);
    expect(bad.map((p) => p.level)).toEqual(["error"]);
    expect((await w.d.query("select jira_outbound from projects where key = 'p'"))[0].jira_outbound).toBeNull();
    const ok = await saveJiraSettings(w.d, "p", "alice", outboundRules({ triggers: RULES.triggers.slice(0, 2) })!,
      ["To Do", "In Progress"]);
    expect(ok.map((p) => p.message)).toEqual(["Jira has no status In QA."]);
    const s = await loadJiraSettings(w.d, "p", statuses as unknown as typeof fetch);
    expect(s).toMatchObject({ jiraProjects: ["WEB"], savedBy: "alice", jiraStatuses: ["In Progress", "To Do"],
                              outbound: { writes: false, triggers: RULES.triggers.slice(0, 2) } });
    await move("A", "in-progress");
    expect(await dryRuns(w.d, "p")).toMatchObject([{ action: "transition", key: "WEB-7", status: "In Progress", title: "Item A" }]);
  });
});
