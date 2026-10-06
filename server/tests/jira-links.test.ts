import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOps, type Op } from "@/lib/apply";
import { ulid } from "@/lib/ulid";
import { migrate, pglite } from "@/lib/db";
import { addProject } from "@/lib/auth";
import { linkedProjects, syncJira } from "@/lib/jira/sync";
import { item as itemView } from "@/lib/views";
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
    expect((await d.query("select jira_mode from projects order by key")).map((r) => r.jira_mode)).toEqual(["import", "import"]);
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

  it("leaves an imported link alone and lets linked items move freely", async () => {
    await w.apply("alice", item("A"), item("B", { extra: { jira: ["CNS-1"] } }));
    await w.d.query("insert into jira_links (project, item_uid, jira_key) values ('p', 'A', 'WEB-1')");
    await link("A", ["WEB-1", "CNS-2"]);
    await link("A", null);
    expect(await links()).toEqual(["p/A/WEB-1/import", "p/B/CNS-1/field"]);
    const [b] = await w.d.query("select versions from items where uid = 'B'");
    expect((await w.one("alice", set("item", "B", "B", { status: "in-progress" }, { status: b.versions.status }))).rejected).toBeUndefined();
    expect(await status("B")).toBe("in-progress");
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

  it("skips a key Jira doesn't know and still mirrors the rest", async () => {
    const jira = fakeJira();
    await w.apply("alice", item("A", { extra: { jira: ["CNS-1", "GONE-1"] } }));
    expect((await sync(jira.impl)).backfilled).toBe(1);
    expect((await requests("A"))[0].text).toContain("## [CNS-1]");
  });

  it("lists the links-mode projects for a poll of all of them", async () => {
    await addProject(w.d, "r");
    expect(await linkedProjects(w.d)).toEqual(["p", "q"]);
  });
});
