import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhook } from "@/app/api/jira/webhook/route";
import { GET as flushRoute } from "@/app/api/jira/flush/route";
import { flushJira } from "@/lib/jira/flush";
import { adfToText } from "@/lib/jira/adf";
import { item, set, world, type World } from "./helpers";

let w: World;
const ENV = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "bot@acme.test",
              JIRA_API_TOKEN: "tok", JIRA_WEBHOOK_SECRET: "s3cret", JIRA_ACCOUNT_ID: "acc-bot", CRON_SECRET: "cron" };

beforeEach(async () => {
  w = await world();
  Object.assign(process.env, ENV);
  await w.d.query("update users set jira_account_id = 'acc-bob' where handle = 'bob'");
  await w.d.query(
    `update projects set jira_project = 'WEB',
       jira_status_map = '{"requested":"To Do","in-progress":"In Progress","review":"In Progress","in-qa":"In QA","ready-to-deploy":"Ready","deployed":"Done"}'::jsonb
     where key = 'p'`);
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const hook = (body: unknown, secret = "s3cret") =>
  webhook(new Request(`http://x/api/jira/webhook?secret=${secret}`, { method: "POST", body: JSON.stringify(body) }));

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

const issue = (extra: Record<string, unknown> = {}) => ({
  key: "WEB-7",
  fields: { project: { key: "WEB" }, summary: "Safari login fails", issuetype: { name: "Bug" },
            description: adf("Steps: open Safari"), reporter: { accountId: "acc-pm", displayName: "Pat PM" },
            assignee: { accountId: "acc-bob", displayName: "Bob" }, status: { name: "To Do" }, ...extra },
});

async function linkedItem() {
  await hook({ webhookEvent: "jira:issue_created", issue: issue() });
  const [it] = await w.d.query("select * from items");
  return it;
}

describe("inbound", () => {
  it("rejects a bad secret", async () => {
    expect((await hook({}, "nope")).status).toBe(401);
  });

  it("creates a requested item with the ticket request", async () => {
    const it = await linkedItem();
    expect(it).toMatchObject({ id: "safari-login-fails", status: "requested", type: "bug",
                               creator: "jira:Pat PM", developer: "bob" });
    const [note] = await w.d.query("select * from notes where item_uid = $1", [it.uid]);
    expect(note).toMatchObject({ kind: "ticket-request", text: "Safari login fails\n\nSteps: open Safari", source: "jira" });
    const [link] = await w.d.query("select * from jira_links");
    expect(link.jira_key).toBe("WEB-7");
  });

  it("ignores a repeat of the create webhook", async () => {
    await linkedItem();
    const r = await (await hook({ webhookEvent: "jira:issue_created", issue: issue() })).json();
    expect(r).toMatchObject({ handled: false, reason: "already linked" });
    expect((await w.d.query("select count(*)::int as n from items"))[0].n).toBe(1);
  });

  it("applies assignee and reverse-mapped status changes", async () => {
    const it = await linkedItem();
    await hook({ webhookEvent: "jira:issue_updated", issue: issue({ assignee: null, status: { name: "In QA" } }),
                 user: { accountId: "acc-qa", displayName: "Quinn" },
                 changelog: { items: [{ field: "assignee" }, { field: "status", toString: "In QA" }] } });
    const [fresh] = await w.d.query("select developer, status from items where uid = $1", [it.uid]);
    expect(fresh).toEqual({ developer: null, status: "in-qa" });
  });

  it("maps a shared Jira status to the earliest todo status and skips our own echo", async () => {
    const it = await linkedItem();
    const v = it.versions;
    await w.one("alice", set("item", it.uid, it.uid, { status: "review" }, { status: v.status }));
    await hook({ webhookEvent: "jira:issue_updated", issue: issue({ status: { name: "In Progress" } }),
                 changelog: { items: [{ field: "status", toString: "In Progress" }] } });
    expect((await w.d.query("select status from items"))[0].status).toBe("review");
    await w.d.query("update items set status = 'todo'");
    const r = await hook({ webhookEvent: "jira:issue_updated", issue: issue({ status: { name: "In Progress" } }),
                 changelog: { items: [{ field: "status", toString: "In Progress" }] } });
    expect((await r.json()).handled).toBe(true);
    expect((await w.d.query("select status from items"))[0].status).toBe("in-progress");
  });

  it("imports comments once, and never our own", async () => {
    const it = await linkedItem();
    const c = { webhookEvent: "comment_created", issue: issue(),
                comment: { id: "100", body: adf("works for me"), author: { accountId: "acc-bob" } } };
    await hook(c);
    await hook(c);
    await w.d.query(`insert into jira_outbox (item_uid, action, payload, result, done_at)
                     values ($1, 'comment', '{}'::jsonb, '{"comment_id":"101"}'::jsonb, now())`, [it.uid]);
    await hook({ ...c, comment: { ...c.comment, id: "101" } });
    const notes = await w.d.query("select kind, text, author, source from notes where kind = 'comment'");
    expect(notes).toEqual([{ kind: "comment", text: "works for me", author: "bob", source: "jira" }]);
    expect((await w.d.query("select count(*)::int as n from jira_outbox where done_at is null"))[0].n).toBe(0);
  });
});

describe("outbound", () => {
  function fakeJira(transitions = [{ id: "31", name: "Start QA", to: { name: "In QA" } }], current = "In Progress") {
    const calls: { method: string; url: string; body?: any }[] = [];
    const impl = vi.fn(async (url: any, init: any) => {
      calls.push({ method: init.method, url: String(url), body: init.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith("?fields=status")) return new Response(JSON.stringify({ fields: { status: { name: current } } }));
      if (String(url).endsWith("/transitions") && init.method === "GET") return new Response(JSON.stringify({ transitions }));
      if (String(url).endsWith("/comment")) return new Response(JSON.stringify({ id: "555" }));
      return new Response(null, { status: 204 });
    });
    return { calls, impl: impl as unknown as typeof fetch };
  }

  it("sends status transitions, comments and links for linked items", async () => {
    const it = await linkedItem();
    await w.one("alice", set("item", it.uid, it.uid, { status: "in-qa" }, { status: it.versions.status }));
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: it.uid,
                           data: { kind: "qa-rejection", text: "still broken", ts: "t" } });
    await w.one("alice", { op: "create", entity: "note", uid: "N2", item_uid: it.uid,
                           data: { kind: "link", text: "PR 9", ts: "t", meta: { url: "https://gh/pr/9", label: "PR 9", type: "pr" } } });
    await w.one("alice", { op: "create", entity: "note", uid: "N3", item_uid: it.uid,
                           data: { kind: "context", text: "internal", ts: "t" } });
    const jira = fakeJira();
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 3, failed: 0 });
    const posts = jira.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.url)).toEqual([
      "https://acme.atlassian.net/rest/api/3/issue/WEB-7/transitions",
      "https://acme.atlassian.net/rest/api/3/issue/WEB-7/comment",
      "https://acme.atlassian.net/rest/api/3/issue/WEB-7/remotelink",
    ]);
    expect(posts[0].body).toEqual({ transition: { id: "31" } });
    expect(adfToText(posts[1].body.body)).toBe("QA rejected — alice (via todo):\nstill broken");
    expect(posts[2].body).toEqual({ globalId: "todo:N2", object: { url: "https://gh/pr/9", title: "PR 9" } });
    expect(jira.calls[0].url).toContain("?fields=status");
    const auth = (jira.impl as any).mock.calls[0][1].headers.authorization;
    expect(auth).toBe("Basic " + Buffer.from("bot@acme.test:tok").toString("base64"));
  });

  it("skips unmapped statuses and transitions already made", async () => {
    const it = await linkedItem();
    await w.one("alice", set("item", it.uid, it.uid, { status: "blocked" }, { status: it.versions.status }));
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
    const v = (await w.d.query("select versions from items"))[0].versions;
    await w.one("alice", set("item", it.uid, it.uid, { status: "in-qa" }, { status: v.status }));
    const jira = fakeJira([], "In QA");
    expect(await flushJira(w.d, jira.impl)).toEqual({ sent: 1, failed: 0 });
    expect(jira.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("does not echo Jira-sourced writes back", async () => {
    await linkedItem();
    await hook({ webhookEvent: "comment_created", issue: issue(),
                 comment: { id: "100", body: adf("from jira"), author: { accountId: "acc-bob" } } });
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
  });

  it("retries a failing delivery a bounded number of times", async () => {
    const it = await linkedItem();
    await w.one("alice", set("item", it.uid, it.uid, { status: "in-qa" }, { status: it.versions.status }));
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
    const [log] = await w.d.query("select text from logs where item_uid = $1", [it.uid]);
    expect(log.text).toMatch(/^Jira transition for WEB-7 gave up after 5 attempts/);
  });

  it("guards the cron route with CRON_SECRET", async () => {
    expect((await flushRoute(new Request("http://x/api/jira/flush"))).status).toBe(401);
    const ok = await flushRoute(new Request("http://x/api/jira/flush", { headers: { authorization: "Bearer cron" } }));
    expect(ok.status).toBe(200);
  });

  it("leaves unlinked items alone", async () => {
    const r = await w.one("alice", item("I9"));
    await w.one("alice", set("item", "I9", "I9", { status: "in-qa" }, { status: r.versions!.status }));
    expect((await w.d.query("select count(*)::int as n from jira_outbox"))[0].n).toBe(0);
  });
});

describe("hardening", () => {
  const changelogStatus = (name: string, id: string, user = { accountId: "acc-qa" }) => ({
    webhookEvent: "jira:issue_updated", issue: issue({ status: { name } }), user,
    changelog: { id, items: [{ field: "status", toString: name }] } });

  it("is idempotent for a retried update webhook", async () => {
    const it = await linkedItem();
    await hook(changelogStatus("In QA", "c1"));
    const v = (await w.d.query("select versions from items"))[0].versions;
    await w.one("alice", set("item", it.uid, it.uid, { status: "ready-to-deploy" }, { status: v.status }));
    await hook(changelogStatus("In QA", "c1"));
    expect((await w.d.query("select status from items"))[0].status).toBe("ready-to-deploy");
  });

  it("ignores status changes made by the integration account", async () => {
    await linkedItem();
    const r = await (await hook(changelogStatus("In QA", "c2", { accountId: "acc-bot" }))).json();
    expect(r).toMatchObject({ handled: false, reason: "own change" });
    expect((await w.d.query("select status from items"))[0].status).toBe("requested");
  });

  it("ignores comments by the integration account or carrying our mark", async () => {
    await linkedItem();
    await hook({ webhookEvent: "comment_created", issue: issue(),
                 comment: { id: "1", body: adf("x"), author: { accountId: "acc-bot" } } });
    await hook({ webhookEvent: "comment_created", issue: issue(),
                 comment: { id: "2", body: adf("alice (via todo):\nhi"), author: { accountId: "acc-bob" } } });
    expect((await w.d.query("select count(*)::int as n from notes where kind = 'comment'"))[0].n).toBe(0);
  });

  it("keeps the item and says so on both sides when Jira hits the deploy gate", async () => {
    const it = await linkedItem();
    await w.d.query("update items set status = 'ready-to-deploy'");
    await w.one("alice", { op: "create", entity: "check", uid: "C1", item_uid: it.uid, data: { kind: "db-script", title: "migrate" } });
    await w.d.query("delete from jira_outbox");
    await hook(changelogStatus("Done", "c3"));
    expect((await w.d.query("select status from items"))[0].status).toBe("ready-to-deploy");
    const [log] = await w.d.query("select text from logs");
    expect(log.text).toContain("pre-deploy checks are still pending");
    const [row] = await w.d.query("select action, payload from jira_outbox");
    expect(row).toMatchObject({ action: "comment" });
    expect(row.payload.text).toContain("Not moved to deployed");
  });

  it("supersedes an older pending transition", async () => {
    const it = await linkedItem();
    const v1 = await w.one("alice", set("item", it.uid, it.uid, { status: "in-progress" }, { status: it.versions.status }));
    await w.one("alice", set("item", it.uid, it.uid, { status: "in-qa" }, { status: v1.versions!.status }));
    const rows = await w.d.query("select payload->>'status' as s, done_at is not null as done from jira_outbox order by id");
    expect(rows).toEqual([{ s: "In Progress", done: true }, { s: "In QA", done: false }]);
  });

  it("never sends a row twice when flushes overlap", async () => {
    const it = await linkedItem();
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: it.uid, data: { kind: "comment", text: "x", ts: "t" } });
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let posts = 0;
    const slow = (async (url: any, init: any) => {
      if (init.method === "POST") {
        posts++;
        await gate;
      }
      return new Response(JSON.stringify({ id: "9" }));
    }) as unknown as typeof fetch;
    const first = flushJira(w.d, slow);
    await new Promise((r) => setTimeout(r, 50));
    await flushJira(w.d, slow);
    release();
    await first;
    expect(posts).toBe(1);
  });

  it("writes ADF Jira accepts: no empty text nodes", async () => {
    const { textToAdf } = await import("@/lib/jira/adf");
    const doc = textToAdf("line one\n\nline two\nthree\n");
    const texts = JSON.stringify(doc).match(/"text":"[^"]*"/g)!;
    expect(texts.every((t) => t !== '"text":""')).toBe(true);
    expect(adfToText(doc)).toBe("line one\n\nline two\nthree");
  });

  it("accepts wiki-markup string descriptions", async () => {
    await hook({ webhookEvent: "jira:issue_created", issue: issue({ description: "plain *wiki* text" }) });
    const [note] = await w.d.query("select text from notes");
    expect(note.text).toBe("Safari login fails\n\nplain *wiki* text");
  });

  it("answers 503 when the bridge isn't configured", async () => {
    delete process.env.JIRA_BASE_URL;
    expect((await hook({})).status).toBe(503);
  });

  it("heads plain comments with the author and our mark", async () => {
    const it = await linkedItem();
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: it.uid, data: { kind: "comment", text: "hi", ts: "t" } });
    const calls: any[] = [];
    const impl = (async (_u: any, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: "5" })); }) as unknown as typeof fetch;
    await flushJira(w.d, impl);
    expect(adfToText(calls[0].body)).toBe("alice (via todo):\nhi");
  });
});
