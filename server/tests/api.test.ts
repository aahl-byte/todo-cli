import { beforeEach, describe, expect, it } from "vitest";
import { POST as projectsPOST } from "@/app/api/projects/route";
import { POST as opsPOST } from "@/app/api/projects/[key]/ops/route";
import { GET as changesGET } from "@/app/api/projects/[key]/changes/route";
import { GET as meGET } from "@/app/api/me/route";
import { GET as inboxGET } from "@/app/api/inbox/route";
import { POST as readPOST } from "@/app/api/inbox/read/route";
import { item, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
});

const req = (url: string, token: string | null, body?: unknown) =>
  new Request(`http://x${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const params = (key: string) => ({ params: Promise.resolve({ key }) });

describe("api", () => {
  it("401s without a valid token", async () => {
    expect((await meGET(req("/api/me", null))).status).toBe(401);
    expect((await meGET(req("/api/me", "wrong"))).status).toBe(401);
    expect((await changesGET(req("/api/projects/p/changes", null), params("p"))).status).toBe(401);
  });

  it("names the token's user", async () => {
    const r = await meGET(req("/api/me", w.tokens.bob));
    expect(await r.json()).toEqual({ handle: "bob", name: null });
  });

  it("creates projects, pushes ops and pulls changes", async () => {
    const created = await projectsPOST(req("/api/projects", w.tokens.alice, { key: "web" }));
    expect(await created.json()).toMatchObject({ key: "web", deploy_step: true });
    const push = await opsPOST(req("/api/projects/web/ops", w.tokens.alice,
      { ops: [{ op_id: "O1", ...item("I1"), data: { id: "login", title: "Login", created: "t" } }] }), params("web"));
    const { results } = await push.json();
    expect(results[0].status).toBe("applied");
    const pull = await changesGET(req("/api/projects/web/changes?since=0", w.tokens.bob), params("web"));
    const body = await pull.json();
    expect(body.changes[0]).toMatchObject({ entity: "item", uid: "I1", data: { id: "login", creator: "alice" } });
    expect(body).toMatchObject({ cursor: 1, more: false, deploy_step: true });
  });

  it("404s an unknown project and 400s malformed ops", async () => {
    const r = await opsPOST(req("/api/projects/nope/ops", w.tokens.alice, { ops: [{ op_id: "x", ...item("I1") }] }), params("nope"));
    expect(r.status).toBe(404);
    const bad = await opsPOST(req("/api/projects/p/ops", w.tokens.alice, { ops: [{ op: "create" }] }), params("p"));
    expect(bad.status).toBe(400);
  });

  it("lists and marks inbox notifications", async () => {
    await w.one("alice", item("I1"));
    await w.one("alice", { op: "create", entity: "note", uid: "N1", item_uid: "I1",
      data: { n: 1, kind: "comment", text: "@bob look", ts: "t" } });
    const inbox = await (await inboxGET(req("/api/inbox", w.tokens.bob))).json();
    expect(inbox.unread).toBe(1);
    expect(inbox.notifications[0]).toMatchObject({ kind: "mention", item_id: "i1", note_text: "@bob look", note_author: "alice" });
    const read = await (await readPOST(req("/api/inbox/read", w.tokens.bob, { ids: [inbox.notifications[0].id] }))).json();
    expect(read.read).toBe(1);
    expect((await (await inboxGET(req("/api/inbox", w.tokens.bob))).json()).unread).toBe(0);
  });
});
