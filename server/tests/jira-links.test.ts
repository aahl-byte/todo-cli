import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOps, type Op } from "@/lib/apply";
import { ulid } from "@/lib/ulid";
import { migrate, pglite } from "@/lib/db";
import { addProject } from "@/lib/auth";
import { backfillLinked, linkedProjects, syncJira } from "@/lib/jira/sync";
import { flushJira } from "@/lib/jira/flush";
import { loadJiraSettings, saveJiraSettings } from "@/lib/jira/settings";
import { outboundRules } from "@/lib/jira/rules";
import { cards, item as itemView, searchMatches } from "@/lib/views";
import { jiraConfig } from "@/lib/jira/config";
import { child, item, set, world, type World } from "./helpers";

let w: World;
const ENV = { JIRA_BASE_URL: "https://acme.atlassian.net", JIRA_EMAIL: "me@acme.test", JIRA_API_TOKEN: "tok", JIRA_READ_ONLY: "1" };

beforeEach(async () => {
  w = await world();
  Object.assign(process.env, ENV);
  await w.d.query("update projects set jira_mode = 'links' where key = 'p'");
  await addProject(w.d, "q");
  await w.d.query("update projects set jira_mode = 'links' where key = 'q'");
});
afterEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});

const adf = (text: string) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const pat = { accountId: "acc-pat", displayName: "Pat PM" };

function issue(key: string, summary: string, description: string, status = "In Progress") {
  return { key, fields: { summary, description: adf(description), status: { name: status }, reporter: pat, issuetype: { name: "Story" },
                          updated: "2026-10-01T10:00:00.000+0000", comment: { total: 0, comments: [] as any[] }, attachment: [] as any[] } };
}

const MEDIA: Record<string, string> = { "10": "11111111-2222-3333-4444-555555555555", "11": "66666666-7777-8888-9999-000000000000" };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

/** A Jira holding a few issues; a search naming a key it doesn't know fails, as Jira's does. */
function fakeJira() {
  const issues: Record<string, ReturnType<typeof issue>> = {
    "CNS-1": issue("CNS-1", "Export totals", "Totals should export as CSV"),
    "OPS-7": issue("OPS-7", "Rotate keys", "Rotate the signing keys"),
  };
  const calls: { method: string; url: string; body?: any }[] = [];
  const impl = (async (url: any, init: any) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, url: u, body });
    if (u.endsWith("/rest/api/3/search/jql")) {
      const keys = body.jql.match(/^key in \((.*)\)$/)?.[1].split(",") ?? [];
      const unknown = keys.find((k: string) => !issues[k]);
      if (unknown) return new Response(`An issue with key '${unknown}' does not exist`, { status: 400 });
      return Response.json({ issues: keys.map((k: string) => issues[k]), isLast: true });
    }
    const att = u.match(/\/attachment\/content\/(\w+)$/);
    if (att) return new Response(null, { status: 303, headers: { location: `https://media.test/file/${MEDIA[att[1]]}/binary?token=t` } });
    if (u.startsWith("https://media.test/file/")) return new Response(PNG, { headers: { "content-type": "image/png" } });
    const one = u.match(/\/rest\/api\/3\/issue\/([A-Z]+-\d+)\?/);
    if (one) return issues[one[1]] ? Response.json(issues[one[1]]) : new Response("gone", { status: 404 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { issues, calls, impl };
}

const sync = (impl: typeof fetch, project = "p") => syncJira(w.d, project, { fetchImpl: impl });
/** Set the item's jira list as alice, from its current version. */
async function link(uid: string, keys: string[] | null) {
  const [it] = await w.d.query("select versions from items where project = 'p' and uid = $1", [uid]);
  return w.one("alice", set("item", uid, uid, { "extra.jira": keys }, { "extra.jira": it.versions["extra.jira"] }));
}
const inQ = (op: Partial<Op>) => applyOps(w.d, "q", [{ op_id: ulid(), ...op } as Op], { handle: "alice" });
const links = async () => (await w.d.query("select project, item_uid, jira_key, source from jira_links order by project, item_uid, jira_key"))
  .map((l) => `${l.project}/${l.item_uid}/${l.jira_key}/${l.source}`);
const requests = async (uid: string, project = "p") => w.d.query(
  "select uid, text, meta from notes where project = $1 and item_uid = $2 and kind = 'ticket-request' order by n", [project, uid]);
const status = async (uid: string, project = "p") =>
  (await w.d.query("select status from items where project = $1 and uid = $2", [project, uid]))[0].status;

describe("jira links schema", () => {
  it("upgrades a one-link-per-item database in place, idempotently", async () => {
    const d = await pglite();
    await migrate(d);
    await d.exec(`
      drop table jira_links; drop table jira_files;
      create table jira_links (project text not null, item_uid text not null, jira_key text not null unique,
                               last_event_at bigint, last_assignee_at bigint, primary key (project, item_uid),
                               foreign key (project, item_uid) references items (project, uid) on delete cascade);
      create table jira_files (project text not null, attachment_id text primary key, issue_key text not null, media_id text,
                               filename text not null, mime text, file_key text);
      alter table projects drop column jira_mode;
      insert into projects (key) values ('a'), ('b');
      insert into items (project, uid, id, title, created) values ('a', 'I1', 'i1', 'one', 'x'), ('b', 'I2', 'i2', 'two', 'x');
      insert into jira_links (project, item_uid, jira_key) values ('a', 'I1', 'WEB-1');
      insert into jira_files (project, attachment_id, issue_key, filename) values ('a', '10', 'WEB-1', 'f.png');`);
    await migrate(d);
    await migrate(d);
    await d.query("insert into jira_links (project, item_uid, jira_key, source) values ('a', 'I1', 'CNS-1', 'field'), ('b', 'I2', 'WEB-1', 'field')");
    await d.query("insert into jira_files (project, attachment_id, issue_key, filename) values ('b', '10', 'WEB-1', 'f.png')");
    expect((await d.query("select project, jira_key, source from jira_links order by project, jira_key")))
      .toEqual([{ project: "a", jira_key: "CNS-1", source: "field" }, { project: "a", jira_key: "WEB-1", source: "import" },
                { project: "b", jira_key: "WEB-1", source: "field" }]);
    expect((await d.query("select jira_mode from projects order by key")).map((r) => r.jira_mode)).toEqual(["links", "links"]);
    await d.close?.();
  });

  it("defaults a new link's source to field, keeping existing rows' sources", async () => {
    const d = await pglite();
    await migrate(d);
    await d.exec(`alter table jira_links alter column source set default 'import';
                  insert into projects (key) values ('a');
                  insert into items (project, uid, id, title, created) values ('a', 'I1', 'i1', 'one', 'x');
                  insert into jira_links (project, item_uid, jira_key) values ('a', 'I1', 'WEB-1');`);
    await migrate(d);
    await migrate(d);
    await d.query("insert into jira_links (project, item_uid, jira_key) values ('a', 'I1', 'CNS-1')");
    expect(await d.query("select jira_key, source from jira_links order by jira_key"))
      .toEqual([{ jira_key: "CNS-1", source: "field" }, { jira_key: "WEB-1", source: "import" }]);
    await d.close?.();
  });

  it("puts every project in links mode, idempotently", async () => {
    const d = await pglite();
    await migrate(d);
    await d.exec(`alter table projects alter column jira_mode set default 'import';
                  insert into projects (key, jira_mode) values ('a', 'import'), ('b', 'links');`);
    await migrate(d);
    await migrate(d);
    await d.query("insert into projects (key) values ('c')");
    expect((await d.query("select key, jira_mode from projects order by key")).map((r) => `${r.key}:${r.jira_mode}`))
      .toEqual(["a:links", "b:links", "c:links"]);
    await d.close?.();
  });
});

describe("jira field links", () => {
  it("keeps jira_links in step with each item's jira list, across items and projects", async () => {
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "OPS-7"] } }), item("B"));
    expect(await links()).toEqual(["p/A/CNS-1/field", "p/A/OPS-7/field"]);
    expect((await link("B", ["CNS-1"])).status).toBe("applied");
    await inQ(item("C", { extra: { jira: ["CNS-1"] } }));
    expect(await links()).toEqual(["p/A/CNS-1/field", "p/A/OPS-7/field", "p/B/CNS-1/field", "q/C/CNS-1/field"]);
    await link("A", ["OPS-7"]);
    await link("B", null);
    expect(await links()).toEqual(["p/A/OPS-7/field", "q/C/CNS-1/field"]);
  });

  it("refuses malformed keys", async () => {
    expect((await w.one("alice", item("A", { extra: { jira: ["cns 1"] } }))).reason).toBe("invalid-jira");
    await w.apply("alice", item("B"));
    expect((await link("B", ["CNS-1", "CNS-1"])).rejected?.[0]).toMatchObject({ field: "extra.jira", reason: "invalid" });
    expect(await links()).toEqual([]);
  });

  it("turns an imported link into a field link, and lets linked items move freely", async () => {
    await w.apply("alice", item("A"), item("B", { extra: { jira: ["CNS-1"] } }));
    await w.d.query("insert into jira_links (project, item_uid, jira_key, source) values ('p', 'A', 'WEB-1', 'import'), ('p', 'A', 'WEB-2', 'import')");
    await link("A", ["WEB-1", "CNS-2"]);
    expect(await links()).toEqual(["p/A/CNS-2/field", "p/A/WEB-1/field", "p/A/WEB-2/import", "p/B/CNS-1/field"]);
    await link("A", null);
    expect(await links()).toEqual(["p/A/WEB-2/import", "p/B/CNS-1/field"]);
    const [b] = await w.d.query("select versions from items where uid = 'B'");
    expect((await w.one("alice", set("item", "B", "B", { status: "in-progress" }, { status: b.versions.status }))).rejected).toBeUndefined();
    expect(await status("B")).toBe("in-progress");
  });

  it("leaves imported link rows off cards and out of search", async () => {
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    await w.d.query("insert into jira_links (project, item_uid, jira_key, source) values ('p', 'A', 'WEB-1', 'import')");
    const [card] = await cards(w.d, "p");
    expect(card.jira).toEqual([{ key: "CNS-1", status: null }]);
    expect(searchMatches(card, "web-1")).toBe(false);
    expect(searchMatches(card, "cns-1")).toBe(true);
  });

  it("lists every linked key on the card and every linked issue's files on the item", async () => {
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "OPS-7"] } }));
    await w.d.query(`insert into jira_files (project, attachment_id, issue_key, filename) values
                       ('p', '1', 'CNS-1', 'a.png'), ('p', '2', 'OPS-7', 'b.pdf'), ('q', '1', 'CNS-1', 'a.png')`);
    const view = (await itemView(w.d, "p", "a"))!;
    expect(view.item.jira).toEqual([{ key: "CNS-1", status: null }, { key: "OPS-7", status: null }]);
    expect(view.files.map((f: any) => f.filename)).toEqual(["a.png", "b.pdf"]);
  });
});

describe("jira links mode", () => {
  it("polls only the linked keys, with no jira_project, and never moves the item", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "todo", extra: { jira: ["CNS-1"] } }));
    await sync(jira.impl);
    const searches = jira.calls.filter((c) => c.url.endsWith("/search/jql")).map((c) => c.body.jql);
    expect(searches).toEqual(["key in (CNS-1)"]);
    jira.issues["CNS-1"].fields.status = { name: "Done" };
    jira.issues["CNS-1"].fields.updated = "2026-10-06T10:00:00.000+0000";
    await sync(jira.impl);
    expect(await status("A")).toBe("todo");
    expect(await w.d.query("select * from tasks")).toEqual([]);
    expect(jira.calls.filter((c) => c.url.includes("/changelog") || (c.method !== "GET" && !c.url.includes("/search/")))).toEqual([]);
    expect((await w.d.query("select extra from items where uid = 'A'"))[0].extra.jira_status).toEqual({ "CNS-1": "Done" });
    expect((await itemView(w.d, "p", "a"))!.item.jira).toEqual([{ key: "CNS-1", status: "Done" }]);
  });

  it("starts a request from a linked issue when the item has none", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "requested", extra: { jira: ["CNS-1"] } }));
    expect((await sync(jira.impl)).backfilled).toBe(1);
    const [req] = await requests("A");
    expect(req.text).toBe("---\n\n## [CNS-1](https://acme.atlassian.net/browse/CNS-1) · Export totals\n\nTotals should export as CSV\n\n---");
    expect(req.meta.version).toBe(1);
  });

  it("appends to an open request in place, each issue once, between separators", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "requested" }),
      child("note", "R", "A", { kind: "ticket-request", text: "Customers want exports.", ts: "t" }));
    await link("A", ["CNS-1"]);
    await sync(jira.impl);
    await link("A", ["CNS-1", "OPS-7"]);
    expect((await sync(jira.impl)).backfilled).toBe(1);
    expect((await sync(jira.impl)).backfilled).toBe(0);
    const reqs = await requests("A");
    expect(reqs).toHaveLength(1);
    expect(reqs[0].text).toBe([
      "Customers want exports.", "---", "## [CNS-1](https://acme.atlassian.net/browse/CNS-1) · Export totals",
      "Totals should export as CSV", "---", "## [OPS-7](https://acme.atlassian.net/browse/OPS-7) · Rotate keys",
      "Rotate the signing keys", "---"].join("\n\n"));
    expect(await status("A")).toBe("requested");

    // Unlinked and linked again, the issue isn't appended a second time.
    await link("A", ["OPS-7"]);
    await link("A", ["OPS-7", "CNS-1"]);
    expect((await sync(jira.impl)).backfilled).toBe(0);
    expect((await requests("A"))[0].text).toBe(reqs[0].text);
  });

  it("posts a new version over a frozen request, which sends the item back to requested", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "requested" }),
      child("note", "R", "A", { kind: "ticket-request", text: "Customers want exports.", ts: "t" }));
    const [a] = await w.d.query("select versions from items where uid = 'A'");
    await w.one("alice", set("item", "A", "A", { status: "in-triage" }, { status: a.versions.status }));
    const [b] = await w.d.query("select versions from items where uid = 'A'");
    await w.one("alice", set("item", "A", "A", { status: "in-progress" }, { status: b.versions.status }));
    await link("A", ["CNS-1"]);
    expect((await sync(jira.impl)).backfilled).toBe(1);
    const reqs = await requests("A");
    expect(reqs.map((r) => [r.meta.version, !!r.meta.frozen])).toEqual([[1, true], [2, false]]);
    expect(reqs[0].text).toBe("Customers want exports.");
    expect(reqs[1].text).toContain("Customers want exports.\n\n---\n\n## [CNS-1]");
    expect(await status("A")).toBe("requested");
    const [h] = await w.d.query("select from_status, to_status, note from status_history where item_uid = 'A' order by n desc limit 1");
    expect(h).toEqual({ from_status: "in-progress", to_status: "requested", note: "request v2" });
    expect((await sync(jira.impl)).backfilled).toBe(0);
    expect(await requests("A")).toHaveLength(2);
  });

  it("backfills one item's new link on request, in place, so triage after it starts no new version", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "requested" }),
      child("note", "R", "A", { kind: "ticket-request", text: "Customers want exports.", ts: "t" }));
    await w.apply("alice", item("B", { status: "requested", extra: { jira: ["OPS-7"] } }));
    await link("A", ["CNS-1"]);
    expect(await backfillLinked(w.d, "p", "A", { fetchImpl: jira.impl })).toEqual({ backfilled: ["CNS-1"] });
    expect(await backfillLinked(w.d, "p", "A", { fetchImpl: jira.impl })).toEqual({ backfilled: [] });
    const reqs = await requests("A");
    expect(reqs.map((r) => r.meta.version ?? 1)).toEqual([1]);
    expect(reqs[0].text).toContain("Customers want exports.\n\n---\n\n## [CNS-1]");
    expect(await requests("B")).toEqual([]);
    const [a] = await w.d.query("select versions from items where uid = 'A'");
    await w.one("alice", set("item", "A", "A", { status: "in-triage" }, { status: a.versions.status }));
    expect((await sync(jira.impl)).backfilled).toBe(1);
    expect(await requests("A")).toHaveLength(1);
    expect(await status("A")).toBe("in-triage");
  });

  it("leaves backfill to jira-issue where it mirrors the project's tickets", async () => {
    await w.d.query("update projects set jira_poll = false where key = 'p'");
    await w.apply("alice", item("A", { status: "requested", extra: { jira: ["CNS-1"] } }));
    expect(await backfillLinked(w.d, "p", "A", { fetchImpl: fakeJira().impl })).toEqual({ skipped: "jira-issue mirrors this project's tickets" });
  });

  it("mirrors one issue's comments onto every item linking it, new ones included", async () => {
    const jira = fakeJira();
    const f = jira.issues["CNS-1"].fields;
    f.comment = { total: 1, comments: [{ id: "c1", author: pat, body: adf("first"), created: "2026-10-01T09:00:00.000+0000" }] };
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }), item("B", { extra: { jira: ["CNS-1"] } }));
    await inQ(item("C", { extra: { jira: ["CNS-1"] } }));
    expect((await sync(jira.impl)).comments).toBe(2);
    expect((await sync(jira.impl, "q")).comments).toBe(1);
    f.comment = { total: 2, comments: [...f.comment.comments, { id: "c2", author: pat, body: adf("second"), created: "2026-10-06T09:00:00.000+0000" }] };
    f.updated = "2099-01-01T00:00:00.000+0000";
    expect((await sync(jira.impl)).comments).toBe(2);
    expect((await sync(jira.impl, "q")).comments).toBe(1);
    expect((await sync(jira.impl)).comments).toBe(0);
    const comments = await w.d.query("select project, item_uid, text from notes where kind = 'comment' order by project, item_uid, ts");
    expect(comments.map((c) => `${c.project}/${c.item_uid}/${c.text}`))
      .toEqual(["p/A/first", "p/A/second", "p/B/first", "p/B/second", "q/C/first", "q/C/second"]);
  });

  it("keeps each project's copy of a shared attachment", async () => {
    process.env.TODO_FILES_DIR = (await import("node:os")).tmpdir() + "/todo-files-" + Date.now();
    const jira = fakeJira();
    jira.issues["CNS-1"].fields.attachment = [{ id: "10", filename: "spec.pdf", mimeType: "application/pdf", size: 900 }];
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    await inQ(item("C", { extra: { jira: ["CNS-1"] } }));
    await sync(jira.impl);
    await sync(jira.impl, "q");
    expect(await w.d.query("select project, attachment_id from jira_files order by project"))
      .toEqual([{ project: "p", attachment_id: "10" }, { project: "q", attachment_id: "10" }]);
    delete process.env.TODO_FILES_DIR;
  });

  it("skips comments carrying the (via todo) mark", async () => {
    const jira = fakeJira();
    jira.issues["CNS-1"].fields.comment = { total: 2, comments: [
      { id: "c1", author: pat, body: adf("alice (via todo):\nhi"), created: "2026-10-01T09:00:00.000+0000" },
      { id: "c2", author: pat, body: adf("from Jira"), created: "2026-10-01T09:05:00.000+0000" }] as any[] };
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    expect((await sync(jira.impl)).comments).toBe(1);
    expect((await w.d.query("select text from notes where kind = 'comment'")).map((n) => n.text)).toEqual(["from Jira"]);
  });

  it("accepts a wiki-markup string description", async () => {
    const jira = fakeJira();
    (jira.issues["CNS-1"].fields as any).description = "plain *wiki* text";
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    await sync(jira.impl);
    expect((await requests("A"))[0].text).toContain("· Export totals\n\nplain *wiki* text\n\n---");
  });

  it("skips a key Jira doesn't know and still mirrors the rest", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "GONE-1"] } }));
    expect((await sync(jira.impl)).backfilled).toBe(1);
    expect((await requests("A"))[0].text).toContain("## [CNS-1]");
  });

  it("lists the links-mode projects for a poll of all of them", async () => {
    await addProject(w.d, "r");
    await w.d.query("update projects set jira_mode = 'import' where key = 'r'");
    expect(await linkedProjects(w.d)).toEqual(["p", "q", "r"]);
  });
});

describe("jira links-mode triggers", () => {
  const RULES = { writes: true, comments: true, never: [], triggers: [{ from: "todo", to: "in-progress", jira: "In Progress" }] };
  const outbound = () => w.d.query("update projects set jira_outbound = $1::jsonb where key = 'p'", [JSON.stringify(RULES)]);
  const move = async (uid: string, status: string) => {
    const [it] = await w.d.query("select versions from items where uid = $1", [uid]);
    return w.one("alice", set("item", uid, uid, { status }, { status: it.versions.status }));
  };
  const outbox = () => w.d.query(
    "select action, payload->>'key' as key, payload->>'status' as status, done_at is null as pending from jira_outbox order by id");

  it("queues a triggered move for every issue the item links, and no comments", async () => {
    await outbound();
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "OPS-7"] } }));
    await move("A", "in-progress");
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: "A", data: { kind: "comment", text: "hi", ts: "t" } });
    expect(await outbox()).toEqual([
      { action: "transition", key: "CNS-1", status: "In Progress", pending: false },
      { action: "transition", key: "OPS-7", status: "In Progress", pending: false },
    ]);
  });

  it("sends each linked issue its own move while writes are on", async () => {
    delete process.env.JIRA_READ_ONLY;
    await outbound();
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "OPS-7"] } }));
    await move("A", "in-progress");
    const posts: string[] = [];
    const impl = vi.fn(async (url: any, init: any) => {
      if (init.method === "POST") posts.push(String(url));
      if (String(url).endsWith("?fields=status")) return new Response(JSON.stringify({ fields: { status: { name: "To Do" } } }));
      if (String(url).endsWith("/transitions") && init.method === "GET") return new Response(JSON.stringify({ transitions: [{ id: "1", to: { name: "In Progress" } }] }));
      return new Response("{}");
    }) as unknown as typeof fetch;
    expect(await flushJira(w.d, impl)).toEqual({ sent: 2, failed: 0 });
    expect(posts.map((u) => u.split("/").slice(-2, -1)[0])).toEqual(["CNS-1", "OPS-7"]);
  });

  it("offers the todo-to-Jira rules with the statuses of the Jira projects its items link", async () => {
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "OPS-7"] } }));
    const asked: string[] = [];
    const impl = vi.fn(async (url: any) => {
      asked.push(String(url).split("/project/")[1]);
      return new Response(JSON.stringify([{ statuses: [{ name: String(url).includes("CNS") ? "Open" : "Done" }, { name: "In Progress" }] }]));
    }) as unknown as typeof fetch;
    const s = await loadJiraSettings(w.d, "p", impl);
    expect(s).toMatchObject({ jiraProjects: ["CNS", "OPS"], jiraStatuses: ["Done", "In Progress", "Open"] });
    expect(asked).toEqual(["CNS/statuses", "OPS/statuses"]);
    expect(await saveJiraSettings(w.d, "p", "alice", outboundRules(RULES)!)).toEqual([]);
    expect((await w.d.query("select jira_outbound from projects where key = 'p'"))[0].jira_outbound.triggers).toEqual(RULES.triggers);
  });
});

describe("jira links-mode polling", () => {
  it("only polls read-only", async () => {
    expect(jiraConfig()).toMatchObject({ baseUrl: "https://acme.atlassian.net" });
    delete process.env.JIRA_READ_ONLY;
    await expect(sync(fakeJira().impl)).rejects.toThrow(/JIRA_READ_ONLY/);
  });

  it("copies image attachments once and links other files to Jira", async () => {
    process.env.TODO_FILES_DIR = (await import("node:os")).tmpdir() + "/todo-files-" + Date.now();
    const jira = fakeJira();
    const f = jira.issues["CNS-1"].fields as any;
    f.attachment = [{ id: "10", filename: "shot.png", mimeType: "image/png", size: 70 },
                    { id: "11", filename: "spec.pdf", mimeType: "application/pdf", size: 900 }];
    f.description = { type: "doc", content: [
      { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: MEDIA["10"], alt: "shot.png" } }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: MEDIA["11"], alt: "spec.pdf" } }] }] };
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    expect((await sync(jira.impl)).files).toBe(1);
    const [req] = await requests("A");
    const key = req.text.match(/\(\/api\/files\/([^)]+)\)/)[1];
    expect(key).toMatch(/^p\/J[0-9A-F]{25}\/J[0-9A-F]{25}\.png$/);
    expect(req.text).toContain("[📎 spec.pdf](https://acme.atlassian.net/secure/attachment/11/spec.pdf)");
    const { readLocal } = await import("@/lib/files");
    expect((await readLocal(key))?.length).toBe(PNG.length);
    f.updated = "2099-01-01T00:00:00.000+0000";
    expect((await sync(jira.impl)).files).toBe(0);
    delete process.env.TODO_FILES_DIR;
  });

  it("lists every attachment with the item and drops ones removed in Jira", async () => {
    process.env.TODO_FILES_DIR = (await import("node:os")).tmpdir() + "/todo-files-" + Date.now();
    const jira = fakeJira();
    const f = jira.issues["CNS-1"].fields as any;
    f.attachment = [{ id: "10", filename: "shot.png", mimeType: "image/png", size: 70 },
                    { id: "11", filename: "spec.pdf", mimeType: "application/pdf", size: 900 }];
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    await sync(jira.impl);
    const files = async () => (await itemView(w.d, "p", "a"))!.files.map((x: any) => [x.filename, !!x.file_key, Number(x.size)]);
    expect(await files()).toEqual([["shot.png", true, 70], ["spec.pdf", false, 900]]);
    f.attachment = [f.attachment[0]];
    f.updated = "2099-01-01T00:00:00.000+0000";
    await sync(jira.impl);
    expect(await files()).toEqual([["shot.png", true, 70]]);
    delete process.env.TODO_FILES_DIR;
  });

  it("updates an edited comment once and marks it edited", async () => {
    const jira = fakeJira();
    const f = jira.issues["CNS-1"].fields;
    const c1: any = { id: "c1", author: pat, body: adf("seen on prod"), created: "2026-09-02T09:00:00.000+0000", updated: "2026-09-02T09:00:00.000+0000" };
    f.comment = { total: 1, comments: [c1] };
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    await sync(jira.impl);
    const note = async () => (await w.d.query("select text, meta from notes where kind = 'comment'"))[0];
    expect((await note()).meta.edited_at).toBeUndefined();
    c1.body = adf("seen on prod, and on staging");
    c1.updated = "2026-10-03T08:00:00.000+0000";
    f.updated = "2099-01-01T00:00:00.000+0000";
    await sync(jira.impl);
    expect(await note()).toMatchObject({ text: "seen on prod, and on staging",
      meta: { jira_updated: "2026-10-03T08:00:00.000Z", edited_at: "2026-10-03T08:00:00.000Z" } });
    const seq = (await w.d.query("select seq from projects where key = 'p'"))[0].seq;
    await sync(jira.impl);
    expect((await w.d.query("select seq from projects where key = 'p'"))[0].seq).toBe(seq);
  });

  it("makes a user for each Jira person it meets, when asked", async () => {
    const jira = fakeJira();
    jira.issues["CNS-1"].fields.comment = { total: 1, comments: [{ id: "c1", author: { accountId: "acc-carol", displayName: "Carol Q" },
                                                                    body: adf("hi"), created: "2026-09-02T09:00:00.000+0000" }] as any[] };
    await w.d.query("update users set jira_account_id = 'acc-bob' where handle = 'bob'");
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1"] } }));
    expect((await syncJira(w.d, "p", { createUsers: true, fetchImpl: jira.impl })).users).toBe(2);
    expect((await w.d.query("select handle from users where jira_account_id is not null order by handle")).map((u) => u.handle))
      .toEqual(["bob", "carol-q", "pat-pm"]);
    expect((await w.d.query("select author from notes where kind = 'comment'"))[0].author).toBe("carol-q");
  });

  it("tells the trigger which status a request append bounced the item from", async () => {
    await w.d.query("update projects set jira_outbound = $1::jsonb where key = 'p'",
      [JSON.stringify({ writes: true, never: [], triggers: [{ from: "in-progress", to: "requested", jira: "To Do" }] })]);
    const jira = fakeJira();
    await w.apply("alice", item("A", { status: "requested" }),
      child("note", "R", "A", { kind: "ticket-request", text: "Customers want exports.", ts: "t" }));
    for (const to of ["in-triage", "in-progress"]) {
      const [v] = await w.d.query("select versions from items where uid = 'A'");
      await w.one("alice", set("item", "A", "A", { status: to }, { status: v.versions.status }));
    }
    await link("A", ["CNS-1"]);
    await sync(jira.impl);
    expect(await status("A")).toBe("requested");
    expect(await w.d.query("select action, payload, result from jira_outbox"))
      .toEqual([{ action: "transition", payload: { key: "CNS-1", status: "To Do" }, result: { dry_run: true } }]);
  });
});
