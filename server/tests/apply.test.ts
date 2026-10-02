import { describe, expect, it, beforeEach } from "vitest";
import { applyOps } from "@/lib/apply";
import { changesSince } from "@/lib/changes";
import { child, item, set, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
});

const row = async (table: string, uid: string) =>
  (await w.d.query(`select * from ${table} where uid = $1`, [uid]))[0];

describe("creates", () => {
  it("applies once per op_id and replays the stored result", async () => {
    const op = { op_id: "OP1", ...item("I1") };
    const [first] = await applyOps(w.d, "p", [op as any], { handle: "alice" });
    const [again] = await applyOps(w.d, "p", [op as any], { handle: "alice" });
    expect(first.status).toBe("applied");
    expect(again).toMatchObject({ status: "applied", duplicate: true, versions: first.versions });
    const { changes } = await changesSince(w.d, "p", 0);
    expect(changes).toHaveLength(1);
  });

  it("serializes concurrent pushes of the same op", async () => {
    const op = { op_id: "OP2", ...item("I2") } as any;
    const [a, b] = await Promise.all([
      applyOps(w.d, "p", [op], { handle: "alice" }),
      applyOps(w.d, "p", [op], { handle: "alice" }),
    ]);
    expect([a[0].status, b[0].status]).toEqual(["applied", "applied"]);
    expect([a[0].duplicate, b[0].duplicate].filter(Boolean)).toHaveLength(1);
  });

  it("treats a known uid with identical data as applied and different data as uid-exists", async () => {
    await w.one("alice", item("I1"));
    expect((await w.one("bob", item("I1"))).status).toBe("applied");
    expect(await w.one("bob", item("I1", { title: "other" }))).toMatchObject({ status: "rejected", reason: "uid-exists" });
  });

  it("reassigns a taken item id and child n", async () => {
    await w.one("alice", item("I1", { id: "login" }));
    const r = await w.one("bob", item("I2", { id: "login" }));
    expect(r.assigned_id).toBe("login-2");
    await w.one("alice", child("note", "N1", "I1", { n: 4, kind: "context", text: "a", ts: "t" }));
    const n = await w.one("bob", child("note", "N2", "I1", { n: 4, kind: "context", text: "b", ts: "t" }));
    expect(n.assigned_n).toBe(5);
    expect((await row("notes", "N2")).n).toBe(5);
  });

  it("stamps the note author from the token, not the op", async () => {
    await w.one("alice", item("I1"));
    await w.one("bob", child("note", "N1", "I1", { n: 1, text: "hi", ts: "t", author: "mallory" }));
    expect((await row("notes", "N1")).author).toBe("bob");
  });

  it("rejects children of unknown items", async () => {
    expect(await w.one("alice", child("task", "T1", "NOPE", { n: 1, title: "x" })))
      .toMatchObject({ status: "rejected", reason: "no-item" });
  });
});

describe("field writes", () => {
  it("rejects a stale base with who and when", async () => {
    const created = await w.one("alice", item("I1", { status: "review" }));
    const v = created.versions!.status;
    expect((await w.one("carol", set("item", "I1", "I1", { status: "in-qa" }, { status: v }))).status).toBe("applied");
    const stale = await w.one("alice", set("item", "I1", "I1", { status: "in-progress" }, { status: v }));
    expect(stale.status).toBe("rejected");
    expect(stale.rejected![0]).toMatchObject({ field: "status", reason: "stale", server_value: "in-qa", by: "carol" });
    expect(stale.rejected![0].at).toMatch(/^\d{4}-/);
    expect((await row("items", "I1")).status).toBe("in-qa");
  });

  it("applies fresh fields of a partial op and rejects the stale ones", async () => {
    const v = (await w.one("alice", item("I1"))).versions!;
    await w.one("bob", set("item", "I1", "I1", { priority: "high" }, { priority: v.priority }));
    const r = await w.one("alice", set("item", "I1", "I1", { priority: "low", developer: "alice" },
      { priority: v.priority, developer: v.developer }));
    expect(r.status).toBe("applied");
    expect(r.rejected!.map((x) => x.field)).toEqual(["priority"]);
    const it1 = await row("items", "I1");
    expect([it1.priority, it1.developer]).toEqual(["high", "alice"]);
  });

  it("accepts a write equal to the current value as a no-op", async () => {
    const v = (await w.one("alice", item("I1"))).versions!;
    await w.one("bob", set("item", "I1", "I1", { status: "in-progress" }, { status: v.status }));
    const r = await w.one("alice", set("item", "I1", "I1", { status: "in-progress" }, { status: v.status }));
    expect(r.status).toBe("applied");
    expect(r.rejected).toBeUndefined();
  });

  it("does not version-check positions or unconditional writes", async () => {
    await w.one("alice", item("I1"));
    const t = await w.one("alice", child("task", "T1", "I1", { n: 1, title: "x", position: 0 }));
    await w.one("bob", set("task", "T1", "I1", { position: 3 }, { position: t.versions!.position }));
    expect((await w.one("alice", set("task", "T1", "I1", { position: 1 }, { position: t.versions!.position }))).rejected).toBeUndefined();
    expect((await w.one({ handle: "jira-bridge", unconditional: true }, set("item", "I1", "I1", { developer: "bob" }))).rejected).toBeUndefined();
  });

  it("merges extra.* keys into the jsonb column", async () => {
    await w.one("alice", item("I1"));
    await w.one("alice", set("item", "I1", "I1", { "extra.acceptance": "works" }));
    expect((await row("items", "I1")).extra).toEqual({ acceptance: "works" });
    await w.one("alice", set("item", "I1", "I1", { "extra.acceptance": null }, { "extra.acceptance": (await row("items", "I1")).versions["extra.acceptance"] }));
    expect((await row("items", "I1")).extra).toEqual({});
  });

  it("refuses fields that are not settable", async () => {
    await w.one("alice", item("I1"));
    const r = await w.one("alice", set("item", "I1", "I1", { calc_status: "done" }));
    expect(r).toMatchObject({ status: "rejected", rejected: [{ field: "calc_status", reason: "not-settable" }] });
  });
});

describe("status rules", () => {
  it("gates deployed on pending pre-deploy checks unless forced, and records forced history", async () => {
    const v = (await w.one("alice", item("I1", { status: "ready-to-deploy" }))).versions!;
    const c = await w.one("alice", child("check", "C1", "I1", { n: 1, kind: "db-script", title: "migrate" }));
    const r = await w.one("alice", set("item", "I1", "I1", { status: "deployed" }, { status: v.status }));
    expect(r.rejected![0]).toMatchObject({ field: "status", reason: "checks-pending" });
    const f = await w.one("alice", set("item", "I1", "I1", { status: "deployed" }, { status: v.status }, { force: true }));
    expect(f.rejected).toBeUndefined();
    const [h] = await w.d.query("select * from status_history where item_uid = 'I1'");
    expect(h).toMatchObject({ from_status: "ready-to-deploy", to_status: "deployed", forced: true, by: "alice" });
    expect((await row("items", "I1")).completed).toBeTruthy();
    expect(c.status).toBe("applied");
  });

  it("lets the deploy through once the check is done in the same push", async () => {
    const v = (await w.one("alice", item("I1", { status: "ready-to-deploy" }))).versions!;
    const c = await w.one("alice", child("check", "C1", "I1", { n: 1, kind: "db-script", title: "migrate" }));
    const [cr, ir] = await w.apply("alice",
      set("check", "C1", "I1", { status: "done" }, { status: c.versions!.status }),
      set("item", "I1", "I1", { status: "deployed" }, { status: v.status }));
    expect([cr.rejected, ir.rejected]).toEqual([undefined, undefined]);
    const [h] = await w.d.query("select forced from status_history where item_uid = 'I1'");
    expect(h.forced).toBe(false);
  });

  it("refuses an agent handing work to QA", async () => {
    const v = (await w.one("alice", item("I1", { status: "review" }))).versions!;
    const r = await w.one("alice", set("item", "I1", "I1", { status: "ready-for-qa" }, { status: v.status }, { via: "agent" }));
    expect(r.rejected![0].reason).toBe("agent-handoff");
    const ok = await w.one("alice", set("item", "I1", "I1", { status: "ready-for-qa" }, { status: v.status }, { via: "human" }));
    expect(ok.rejected).toBeUndefined();
  });

  it("writes history only for applied status changes", async () => {
    const v = (await w.one("alice", item("I1", { status: "review" }))).versions!;
    await w.one("carol", set("item", "I1", "I1", { status: "in-qa" }, { status: v.status }));
    await w.one("alice", set("item", "I1", "I1", { status: "in-progress" }, { status: v.status }));
    const hist = await w.d.query("select from_status, to_status from status_history order by n");
    expect(hist).toEqual([{ from_status: "review", to_status: "in-qa" }]);
  });

  it("recomputes calc_status on task changes", async () => {
    await w.one("alice", item("I1"));
    const t = await w.one("alice", child("task", "T1", "I1", { n: 1, title: "x" }));
    expect((await row("items", "I1")).calc_status).toBe("todo");
    await w.one("alice", set("task", "T1", "I1", { status: "done" }, { status: t.versions!.status }));
    expect((await row("items", "I1")).calc_status).toBe("done");
  });
});

describe("removes", () => {
  it("rejects a remove over a newer edit, and edits of removed entities", async () => {
    await w.one("alice", item("I1"));
    const t = await w.one("alice", child("task", "T1", "I1", { n: 1, title: "x" }));
    const base = t.versions!;
    await w.one("bob", set("task", "T1", "I1", { title: "renamed" }, { title: base.title }));
    const r = await w.one("alice", { op: "remove", entity: "task", uid: "T1", item_uid: "I1", base });
    expect(r).toMatchObject({ status: "rejected", reason: "stale" });
    const fresh = (await row("tasks", "T1")).versions;
    expect((await w.one("alice", { op: "remove", entity: "task", uid: "T1", item_uid: "I1", base: fresh })).status).toBe("applied");
    const late = await w.one("bob", set("task", "T1", "I1", { title: "again" }, fresh));
    expect(late).toMatchObject({ status: "rejected", reason: "removed", by: "alice" });
    const { changes } = await changesSince(w.d, "p", 0);
    expect(changes.find((c) => c.uid === "T1")).toMatchObject({ deleted: true, data: null });
  });

  it("never removes items", async () => {
    await w.one("alice", item("I1"));
    expect((await w.one("alice", { op: "remove", entity: "item", uid: "I1", item_uid: "I1" })).reason).toBe("not-removable");
  });
});

describe("groups", () => {
  it("rolls back every op in a group when any field is rejected", async () => {
    const v = (await w.one("alice", item("I1", { status: "in-qa" }))).versions!;
    await w.one("bob", set("item", "I1", "I1", { status: "ready-to-deploy" }, { status: v.status }));
    const rs = await w.apply("carol",
      { ...set("item", "I1", "I1", { status: "in-progress" }, { status: v.status }), group: "G" },
      { ...child("note", "N1", "I1", { n: 1, kind: "qa-rejection", text: "broken", ts: "t" }), group: "G" });
    expect(rs.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(rs[1].reason).toBe("group-rolled-back");
    expect(await row("notes", "N1")).toBeUndefined();
  });
});

describe("changes feed", () => {
  it("gives every changed entity its own seq, in commit order, without gaps", async () => {
    await w.one("alice", item("I1"));
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      w.one(i % 2 ? "alice" : "bob", child("task", `T${i}`, "I1", { n: i + 1, title: `t${i}` }))));
    const rows = await w.d.query("select seq from changes where project = 'p' order by seq");
    const seqs = rows.map((r) => Number(r.seq));
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("pages with a cursor and dedupes a uid within a page", async () => {
    const v = (await w.one("alice", item("I1"))).versions!;
    await w.one("alice", set("item", "I1", "I1", { priority: "high" }, { priority: v.priority }));
    for (let i = 0; i < 3; i++) await w.one("alice", child("log", `L${i}`, "I1", { n: i + 1, text: "x", ts: "t" }));
    const page1 = await changesSince(w.d, "p", 0, 2);
    expect(page1.changes.map((c) => c.uid)).toEqual(["I1"]);
    expect(page1.more).toBe(true);
    const page2 = await changesSince(w.d, "p", page1.cursor, 10);
    expect(page2.changes.map((c) => c.uid)).toEqual(["L0", "L1", "L2"]);
    expect(page2.more).toBe(false);
    expect(page1.changes[0].data!.priority).toBe("high");
    expect(page1.changes[0].data!.versions.priority).toBe(2);
  });
});

describe("notifications", () => {
  const kinds = async (h: string) =>
    (await w.d.query("select kind from notifications where handle = $1 order by id", [h])).map((r) => r.kind);

  it("covers mentions, rejections, questions, answers, QA hand-off and deploys", async () => {
    const v = (await w.one("alice", item("I1", { status: "review", creator: "alice", developer: "bob", qa_assignee: "carol" }))).versions!;
    await w.one("bob", child("note", "N1", "I1", { n: 1, kind: "comment", text: "@carol @nobody look", ts: "t" }));
    await w.one("bob", child("note", "N2", "I1", { n: 2, kind: "clarification", text: "which?", ts: "t", meta: { state: "open" } }));
    const ans = (await row("notes", "N2")).versions;
    await w.one("alice", set("note", "N2", "I1", { "meta.state": "answered", "meta.answer": "this" }, ans));
    const s1 = await w.one("bob", set("item", "I1", "I1", { status: "ready-for-qa" }, { status: v.status }));
    await w.one("carol", child("note", "N3", "I1", { n: 3, kind: "qa-rejection", text: "nope", ts: "t" }));
    await w.one("carol", set("item", "I1", "I1", { status: "deployed" }, { status: s1.versions!.status }));
    expect(await kinds("carol")).toEqual(["mention", "ready-for-qa"]);
    expect(await kinds("alice")).toEqual(["clarification", "deployed"]);
    expect(await kinds("bob")).toEqual(["answer", "qa-rejection"]);
  });

  it("never notifies people about their own actions", async () => {
    await w.one("alice", item("I1", { developer: "alice" }));
    await w.one("alice", child("note", "N1", "I1", { n: 1, kind: "qa-rejection", text: "@alice", ts: "t" }));
    expect(await kinds("alice")).toEqual([]);
  });
});
