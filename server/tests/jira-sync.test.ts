import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jiraConfig } from "@/lib/jira/config";
import { syncJira } from "@/lib/jira/sync";
import { set, world, type World } from "./helpers";

let w: World;
const ENV = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "me@acme.test", JIRA_API_TOKEN: "tok", JIRA_READ_ONLY: "1" };

beforeEach(async () => {
  w = await world();
  Object.assign(process.env, ENV);
  await w.d.query("update users set jira_account_id = 'acc-bob' where handle = 'bob'");
  await w.d.query(
    `update projects set jira_project = 'WEB',
       jira_status_map = '{"requested":"To Do","todo":"Ready","in-progress":"In Progress","in-qa":"In QA","done":"Done"}'::jsonb
     where key = 'p'`);
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const pat = { accountId: "acc-pat", displayName: "Pat PM" };
const carol = { accountId: "acc-carol", displayName: "Carol Q" };
const bob = { accountId: "acc-bob", displayName: "Bob" };

/** A Jira whose issues, changelogs and sub-tasks the test edits between passes. */
function fakeJira() {
  const state = {
    issue: {
      key: "WEB-1",
      fields: {
        summary: "Totals wrong", description: adf("Steps: add two items"), issuetype: { name: "Bug" },
        status: { name: "In Progress" }, priority: { name: "CRITICAL" }, reporter: pat, assignee: bob,
        parent: { key: "WEB-9", fields: { summary: "Checkout revamp", issuetype: { name: "Epic" } } },
        created: "2026-09-01T10:00:00.000+0000", updated: "2026-10-01T10:00:00.000+0000",
        comment: { total: 1, comments: [{ id: "c1", author: carol, body: adf("seen on prod"), created: "2026-09-02T09:00:00.000+0000" }] },
      } as Record<string, any>,
    },
    changelog: [{ id: "100", author: pat, created: "2026-09-05T10:00:00.000+0000", items: [{ field: "status", toString: "In Progress" }] }] as any[],
    subtask: { key: "WEB-2", fields: { summary: "Write the migration", status: { name: "Done" }, parent: { key: "WEB-1" }, assignee: bob } },
    calls: [] as { method: string; url: string; body?: any }[],
  };
  const impl = (async (url: any, init: any) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ method: init.method, url: u, body });
    if (u.endsWith("/rest/api/3/search/jql")) {
      const sub = body.jql.includes("issuetype in subTaskIssueTypes()");
      return Response.json({ issues: sub ? [state.subtask] : [state.issue], isLast: true });
    }
    if (u.includes("/changelog")) return Response.json({ values: state.changelog, isLast: true });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { state, impl };
}

const sync = (impl: typeof fetch) => syncJira(w.d, "p", { createUsers: true, fetchImpl: impl });

describe("jira sync", () => {
  it("imports an issue as it stands, with people, epic, comments and sub-tasks", async () => {
    const jira = fakeJira();
    expect(await sync(jira.impl)).toEqual({ imported: 1, events: 0, comments: 1, tasks: 1, users: 2 });
    const [it] = await w.d.query("select * from items");
    expect(it).toMatchObject({ id: "web-1", title: "Totals wrong", status: "in-progress", type: "bug", priority: "urgent",
                               developer: "bob", creator: "pat-pm", extra: { epic: "Checkout revamp" } });
    const notes = await w.d.query("select kind, author, text, ts, meta from notes order by n");
    expect(notes[0]).toMatchObject({ kind: "ticket-request", text: "Totals wrong\n\nSteps: add two items",
                                     meta: { version: 1, frozen: true, frozen_via: "jira", triaged: true } });
    expect(notes[1]).toMatchObject({ kind: "comment", author: "carol-q", text: "seen on prod" });
    expect(new Date(notes[1].ts).toISOString()).toBe("2026-09-02T09:00:00.000Z");
    expect(await w.d.query("select title, status from tasks")).toEqual([{ title: "Write the migration", status: "done" }]);
    expect((await w.d.query("select handle from users where jira_account_id is not null order by handle")).map((u) => u.handle))
      .toEqual(["bob", "carol-q", "pat-pm"]);
    expect(jira.state.calls.filter((c) => c.method !== "GET" && !c.url.includes("/search/"))).toEqual([]);
  });

  it("replays new changelog entries and comments once, and keeps Jira's status on a description edit", async () => {
    const jira = fakeJira();
    await sync(jira.impl);
    const f = jira.state.issue.fields;
    f.status = { name: "In QA" };
    f.description = adf("Steps: add two items, then refresh");
    f.summary = "Totals wrong after refresh";
    f.priority = { name: "Low" };
    f.comment = { total: 2, comments: [...f.comment.comments, { id: "c2", author: bob, body: adf("fixed"), created: "2026-10-02T11:00:00.000+0000" }] };
    jira.state.changelog.push(
      { id: "101", author: carol, created: "2026-10-02T10:00:00.000+0000", items: [{ field: "status", toString: "In QA" }] },
      { id: "102", author: pat, created: "2026-10-02T10:05:00.000+0000",
        items: [{ field: "description" }, { field: "summary" }, { field: "priority", toString: "Low" }] });
    jira.state.subtask.fields.status = { name: "In Progress" };
    expect(await sync(jira.impl)).toEqual({ imported: 0, events: 2, comments: 1, tasks: 1, users: 0 });
    const [it] = await w.d.query("select * from items");
    expect(it).toMatchObject({ status: "in-qa", title: "Totals wrong after refresh", priority: "low" });
    const requests = await w.d.query("select meta from notes where kind = 'ticket-request' order by n");
    expect(requests.map((r) => [r.meta.version, r.meta.frozen_via, r.meta.triaged])).toEqual([[1, "jira", true], [2, "jira", true]]);
    expect(await w.d.query("select status from tasks")).toEqual([{ status: "in-progress" }]);

    const before = (await w.d.query("select seq from projects where key = 'p'"))[0].seq;
    expect(await sync(jira.impl)).toEqual({ imported: 0, events: 0, comments: 0, tasks: 0, users: 0 });
    expect((await w.d.query("select seq from projects where key = 'p'"))[0].seq).toBe(before);
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
  });

  it("refuses local status moves on mirrored items and queues nothing for Jira", async () => {
    const jira = fakeJira();
    await sync(jira.impl);
    const [it] = await w.d.query("select * from items");
    const r = await w.one("alice", set("item", it.uid, it.uid, { status: "done" }, { status: it.versions.status }));
    expect(r.rejected?.[0]).toMatchObject({ field: "status", reason: "jira-read-only" });
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: it.uid, data: { kind: "comment", text: "local", ts: "t" } });
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
  });

  it("only polls read-only, and needs no webhook secret", async () => {
    expect(jiraConfig()).toMatchObject({ baseUrl: "https://acme.atlassian.net", webhookSecret: undefined });
    delete process.env.JIRA_READ_ONLY;
    await expect(sync(fakeJira().impl)).rejects.toThrow(/JIRA_READ_ONLY/);
  });
});

describe("jira status sets", () => {
  const INBOUND = { statuses: { "Ready": ["requested"], "In Development": ["in-progress", "in-triage", "todo", "review", "qa-rejected"],
                                "Blocked": ["blocked"], "QA": ["ready-for-qa", "in-qa"], "Ready to Deploy": ["ready-to-deploy"],
                                "Done": ["done", "deployed"] },
                    transitions: [{ from: "QA", to: "In Development", status: "qa-rejected" }] };
  beforeEach(async () => {
    await w.d.query("update projects set jira_inbound = $1::jsonb where key = 'p'", [JSON.stringify(INBOUND)]);
  });
  const step = (jira: ReturnType<typeof fakeJira>, id: string, at: string, from: string, to: string) => {
    jira.state.issue.fields.status = { name: to };
    jira.state.changelog.push({ id, author: pat, created: at, items: [{ field: "status", fromString: from, toString: to }] });
  };
  const status = async () => (await w.d.query("select status from items"))[0].status;

  it("imports into each set's default and scopes the search to mapped statuses", async () => {
    const jira = fakeJira();
    jira.state.issue.fields.status = { name: "In Development" };
    await sync(jira.impl);
    expect(await status()).toBe("in-progress");
    const jql = jira.state.calls.find((c) => c.url.endsWith("/search/jql"))!.body.jql;
    for (const s of Object.keys(INBOUND.statuses)) expect(jql).toContain(`"${s}"`);
    expect(jql).not.toContain("Open");
  });

  it("keeps todo's finer status inside a set, and reads QA → In Development as a rejection", async () => {
    const jira = fakeJira();
    jira.state.issue.fields.status = { name: "In Development" };
    await sync(jira.impl);
    const [it] = await w.d.query("select * from items");
    expect((await w.one("bob", set("item", it.uid, it.uid, { status: "review" }, { status: it.versions.status }))).status).toBe("applied");
    const v = (await w.d.query("select versions from items"))[0].versions;
    expect((await w.one("bob", set("item", it.uid, it.uid, { status: "in-qa" }, { status: v.status }))).rejected?.[0].reason).toBe("jira-read-only");
    // A stale QA → In Development doesn't touch an item that isn't in QA.
    step(jira, "200", "2026-10-02T09:00:00.000+0000", "QA", "In Development");
    await sync(jira.impl);
    expect(await status()).toBe("review");
    step(jira, "201", "2026-10-02T10:00:00.000+0000", "In Development", "QA");
    await sync(jira.impl);
    expect(await status()).toBe("ready-for-qa");
    step(jira, "202", "2026-10-02T11:00:00.000+0000", "QA", "In Development");
    await sync(jira.impl);
    expect(await status()).toBe("qa-rejected");
    step(jira, "203", "2026-10-02T12:00:00.000+0000", "In Development", "Ready to Deploy");
    step(jira, "204", "2026-10-02T13:00:00.000+0000", "Ready to Deploy", "Done");
    jira.state.issue.fields.status = { name: "Done", statusCategory: { key: "done" } } as any;
    await sync(jira.impl);
    expect(await status()).toBe("done");
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
  });
});
