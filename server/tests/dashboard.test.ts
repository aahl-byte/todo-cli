import { beforeEach, describe, expect, it } from "vitest";
import * as build from "@/lib/ops-builder";
import { allowedMove, deriveCalcStatus, moves, NEXT_STATUSES, PAST_TRIAGE } from "@/lib/model";
import { board, bounceCount, choices, deployPlan, item as loadItem, project, qaQueue } from "@/lib/views";
import { backfillRequestVersions, type Op } from "@/lib/apply";
import { child, item, set, world, type World } from "./helpers";

let w: World;
beforeEach(async () => {
  w = await world();
});

const ref = (uid: string, versions: Record<string, number>) => ({ uid, item_uid: uid, versions });

describe("ops builder", () => {
  const it1 = ref("I1", { status: 7, qa_assignee: 3, title: 2 });

  it("carries the versions the form was opened with", () => {
    const [op] = build.statusOps(it1, "review");
    expect(op).toMatchObject({ op: "set", entity: "item", uid: "I1", data: { status: "review" }, base: { status: 7 }, via: "human" });
    expect(build.statusOps(it1, "deployed", { force: true })[0].force).toBe(true);
  });

  it("groups a rejection with its status change and requires text", () => {
    expect(() => build.rejectOps(it1, "  ")).toThrow(/comment/);
    const [status, note] = build.rejectOps(it1, "broken on Safari");
    expect(status.group).toBeTruthy();
    expect(note.group).toBe(status.group);
    expect(status.data).toEqual({ status: "qa-rejected" });
    expect(note).toMatchObject({ op: "create", entity: "note", item_uid: "I1",
      data: { kind: "qa-rejection", text: "broken on Safari", meta: { with_status: "qa-rejected" } } });
  });

  it("sends back to work with an optional grouped comment", () => {
    expect(build.backToWorkOps(it1, "")).toHaveLength(1);
    const ops = build.backToWorkOps(it1, "please split the PR");
    expect(ops.map((o) => o.entity)).toEqual(["item", "note"]);
    expect(ops[1].data!.kind).toBe("comment");
  });

  it("picks up QA and claims it only when unassigned", () => {
    expect(build.pickUpOps({ ...it1, qa_assignee: null }, "carol")[0].data).toEqual({ status: "in-qa", qa_assignee: "carol" });
    expect(build.pickUpOps({ ...it1, qa_assignee: "dave" }, "carol")[0].data).toEqual({ status: "in-qa" });
  });

  it("approves to done when the project has no deploy step", () => {
    expect(build.approveOps(it1, true)[0].data).toEqual({ status: "ready-to-deploy" });
    expect(build.approveOps(it1, false)[0].data).toEqual({ status: "done" });
  });

  it("builds a request as a requested item plus its ticket-request note", () => {
    const ops = build.requestOps({ title: "Safari login", type: "bug", priority: "high", description: "steps" }, "pat");
    expect(ops[0]).toMatchObject({ op: "create", entity: "item", data: { title: "Safari login", status: "requested", creator: "pat", type: "bug" } });
    expect(ops[0].item_uid).toBe(ops[0].uid);
    expect(ops[1]).toMatchObject({ entity: "note", item_uid: ops[0].uid, data: { kind: "ticket-request", text: "steps" } });
  });

  it("answers a clarification through meta fields with their base", () => {
    const [op] = build.answerOps({ uid: "N1", item_uid: "I1", versions: { "meta.state": 4 } }, "yes", "pat");
    expect(op.data).toMatchObject({ "meta.state": "answered", "meta.answer": "yes", "meta.answered_by": "pat" });
    expect(op.base).toEqual({ "meta.state": 4 });
  });

  it("validates links, tasks and checks", () => {
    expect(() => build.linkOps("I1", "not a url", "", "pr")).toThrow();
    expect(build.linkOps("I1", "https://x/pr/1", "", "pr")[0].data).toMatchObject({ text: "https://x/pr/1", meta: { type: "pr", label: null } });
    expect(build.taskOps("I1", "t", 2)[0].data).toMatchObject({ phase: 2, status: "todo" });
    expect(build.checkOps("I1", "env-var", "TTL", "", "post-deploy")[0].data).toMatchObject({ payload: null, timing: "post-deploy" });
    expect(build.removeOp("check", { uid: "C1", item_uid: "I1", versions: { status: 9 } }).base).toEqual({ status: 9 });
  });
});

describe("views", () => {
  async function seed() {
    const a = await w.one("alice", item("A1", { title: "Alpha", status: "review", developer: "bob", qa_assignee: "carol", creator: "pat" }));
    await w.one("alice", item("B1", { title: "Beta", status: "ready-to-deploy" }));
    await w.one("alice", item("C1", { title: "Gamma", status: "deferred" }));
    await w.one("alice", child("task", "T1", "A1", { n: 1, title: "x", phase: 1, status: "done" }));
    await w.one("alice", child("task", "T2", "A1", { n: 2, title: "y", phase: 1 }));
    await w.one("alice", child("note", "Q1", "A1", { n: 1, kind: "clarification", text: "which?", ts: "t", meta: { state: "open" } }));
    await w.one("alice", child("check", "K1", "B1", { n: 1, kind: "db-script", title: "migrate" }));
    await w.one("alice", child("check", "K2", "B1", { n: 2, kind: "prereq-branch", title: "needs alpha", payload: "a1" }));
    return a;
  }

  it("puts cards in lifecycle columns with their badges", async () => {
    await seed();
    const p = (await project(w.d, "p"))!;
    const { columns: cols } = await board(w.d, p, {}, "bob");
    const by = Object.fromEntries(cols.map((c) => [c.key, c.items.map((i) => i.id)]));
    expect(by.ready).toEqual(["a1"]);
    expect(by.deploy).toEqual(["b1"]);
    expect(cols.find((c) => c.key === "parked")).toBeUndefined();
    const a = cols.find((c) => c.key === "ready")!.items[0];
    expect(a).toMatchObject({ open_questions: 1, task_statuses: ["done", "todo"] });
    expect(cols.find((c) => c.key === "deploy")!.items[0].pending_pre).toBe(2);
    const { columns: parked } = await board(w.d, p, { parked: true }, "bob");
    expect(parked.find((c) => c.key === "parked")!.items.map((i) => i.id)).toEqual(["c1"]);
    const mine = [{ role: "dev", who: "bob" }, { role: "qa", who: "bob" }, { role: "by", who: "bob" }] as const;
    expect((await board(w.d, p, { entries: [...mine], view: "merged" }, "bob")).columns.flatMap((c) => c.items.map((i) => i.id))).toEqual(["a1"]);
  });

  it("groups each column by status in its order, then bugs first", async () => {
    for (const [uid, status, type] of [["O1", "requested", "bug"], ["O2", "in-triage", "feature"], ["O3", "blocked", "feature"],
      ["O4", "qa-rejected", "feature"], ["O5", "in-triage", "bug"], ["Q1", "ready-for-qa", "bug"], ["Q2", "in-qa", "feature"],
      ["R1", "todo", "feature"], ["R2", "review", "feature"], ["R3", "todo", "bug"]]) {
      await w.one("alice", item(uid, { title: uid, status, type }));
    }
    const p = (await project(w.d, "p"))!;
    const by = Object.fromEntries((await board(w.d, p, {}, "bob")).columns.map((c) => [c.key, c.items.map((i) => i.id)]));
    expect(by.open).toEqual(["o4", "o3", "o5", "o2", "o1"]);
    expect(by.ready).toEqual(["r2", "r3", "r1"]);
    expect(by.qa).toEqual(["q2", "q1"]);
    expect(by.progress).toEqual([]);
  });

  it("shows the first entry's tab when no view is given", async () => {
    await w.one("alice", item("F1", { status: "todo", developer: "bob" }));
    await w.one("alice", item("F2", { status: "todo", qa_assignee: "bob" }));
    const p = (await project(w.d, "p"))!;
    const entries = [{ role: "dev", who: "bob" }, { role: "qa", who: "bob" }] as const;
    const ids = async (f: object) => (await board(w.d, p, { entries: [...entries], ...f }, "bob")).columns.flatMap((c) => c.items.map((i) => i.id));
    expect(await ids({})).toEqual(["f1"]);
    expect((await ids({ view: "merged" })).sort()).toEqual(["f1", "f2"]);
  });

  it("finds work an agent parked in review for its developer", async () => {
    const a = await seed();
    await w.one("alice", set("item", "A1", "A1", { status: "in-progress" }, { status: a.versions!.status }));
    const v = (await w.d.query("select versions from items where uid = 'A1'"))[0].versions;
    await w.one("alice", set("item", "A1", "A1", { status: "review" }, { status: v.status }, { via: "agent" }));
    const p = (await project(w.d, "p"))!;
    const ids = (await board(w.d, p, { review: true }, "bob")).columns.flatMap((c) => c.items.map((i) => i.id));
    expect(ids).toEqual(["a1"]);
    expect((await board(w.d, p, { review: true }, "carol")).columns.flatMap((c) => c.items)).toEqual([]);
  });

  it("hides the deploy column for projects without a deploy step", async () => {
    await w.d.query("update projects set deploy_step = false");
    const p = (await project(w.d, "p"))!;
    expect((await board(w.d, p, {}, "x")).columns.map((c) => c.key)).not.toContain("deploy");
  });

  it("loads an item with phases, questions, history and bounces", async () => {
    const a = await seed();
    await w.one("carol", set("item", "A1", "A1", { status: "in-qa" }, { status: a.versions!.status }));
    const v = (await w.d.query("select versions from items where uid = 'A1'"))[0].versions;
    await w.one("carol", set("item", "A1", "A1", { status: "in-progress" }, { status: v.status }));
    const view = (await loadItem(w.d, "p", "a1"))!;
    expect(view.tasks.map((t) => [t.phase, t.status])).toEqual([[1, "done"], [1, "todo"]]);
    expect(view.questions.filter((n) => n.meta?.state !== "answered").map((n) => n.uid)).toEqual(["Q1"]);
    expect(view.bounces).toBe(1);
    expect(view.item.calc_status).toBe("todo");
    expect(view.item.versions.status).toBeGreaterThan(0);
  });

  it("orders the QA queue and the deploy plan", async () => {
    await seed();
    const p = await qaQueue(w.d, "p", "carol");
    expect(p.ready).toEqual([]);
    const plan = await deployPlan(w.d, "p");
    expect(plan.ready.map((r) => r.id)).toEqual(["b1"]);
    expect(plan.byTicket[0].checks.filter((c) => c.timing === "pre-deploy").map((c) => c.kind)).toEqual(["prereq-branch", "db-script"]);
    expect(plan.byTicket[0].checks[0].warning).toBe("not deployed");
  });

  it("filters the deploy plan by role entries and counts each tab", async () => {
    await w.one("alice", item("D1", { status: "ready-to-deploy", developer: "bob" }));
    await w.one("alice", item("D2", { status: "ready-to-deploy", developer: "eve" }));
    await w.one("alice", item("D3", { status: "deployed", developer: "eve" }));
    await w.one("alice", child("check", "P1", "D3", { n: 1, kind: "manual-step", title: "verify", timing: "post-deploy" }));
    const f = { entries: [{ role: "dev" as const, who: "bob" }, { role: "dev" as const, who: "eve" }] };
    const bob = await deployPlan(w.d, "p", "x", f);
    expect(bob.byTicket.map((t) => t.item.id)).toEqual(["d1"]);
    expect(bob.afterByTicket).toEqual([]);
    expect(bob.counts).toEqual([1, 2]);
    const eve = await deployPlan(w.d, "p", "x", { ...f, tab: 1 });
    expect(eve.byTicket.map((t) => t.item.id)).toEqual(["d2"]);
    expect(eve.afterByTicket.map((t) => t.item.id)).toEqual(["d3"]);
  });
});

describe("transitions", () => {

  it("orders the menu: next step, forward, back, parking", () => {
    expect(moves("review", {}).map((m: any) => [m.status, m.group])).toEqual([
      ["ready-for-qa", "next"], ["done", "forward"], ["in-progress", "back"],
      ["blocked", "park"], ["deferred", "park"], ["cancelled", "park"]]);
  });
  it("hides review → done once QA is assigned", () => {
    expect(allowedMove("review", "done", { hasQa: true })).toBe(false);
    expect(allowedMove("review", "done", { hasQa: false })).toBe(true);
  });
  it("swaps deploy statuses for done without a deploy step", () => {
    expect(moves("in-qa", { deployStep: false }).map((m: any) => m.status)).toEqual(
      ["done", "ready-for-qa", "qa-rejected", "blocked", "cancelled"]);
    expect(moves("blocked", { deployStep: false }).map((m: any) => m.status)).not.toContain("deployed");
  });
  it("offers unblock to the previous status first", () => {
    expect(moves("blocked", { previous: "in-qa" })[0]).toMatchObject({ status: "in-qa", group: "next" });
  });
  it("asks for the right comments", () => {
    const m = (from: string, to: string) => moves(from, {}).find((x: any) => x.status === to);
    expect(m("in-qa", "qa-rejected")).toMatchObject({ comment: "required", rejection: true, group: "back" });
    expect(m("in-qa", "in-progress")).toBeUndefined();
    expect(m("deployed", "in-progress")).toMatchObject({ comment: "required" });
    expect(m("review", "in-progress")).toMatchObject({ comment: "optional" });
    expect(m("todo", "blocked")).toMatchObject({ comment: "optional" });
    expect(m("todo", "in-progress")).toMatchObject({ comment: null });
  });
  it("lets every active status be cancelled and requested items only reach triage", () => {
    for (const s of ["requested", "in-triage", "todo", "in-progress", "review", "ready-for-qa", "in-qa", "ready-to-deploy", "blocked", "deferred"]) {
      expect(NEXT_STATUSES[s]).toContain("cancelled");
    }
    expect(NEXT_STATUSES.requested).not.toContain("todo");
    expect(NEXT_STATUSES.requested).not.toContain("in-progress");
  });
});

describe("move ops", () => {
  const it1 = { uid: "I1", item_uid: "I1", versions: { status: 4, qa_assignee: 2 } };
  it("refuses moves outside the table and missing required comments", () => {
    expect(() => build.moveOps({ ...it1, status: "requested" }, "in-progress", { me: "dev" })).toThrow(/Can't move/);
    expect(() => build.moveOps({ ...it1, status: "in-qa" }, "qa-rejected", { me: "qa" })).toThrow(/comment/);
  });
  it("groups a rejection comment with the status change", () => {
    const [s, n] = build.moveOps({ ...it1, status: "in-qa", qa_assignee: "qa" }, "qa-rejected", { me: "qa", comment: "broken" });
    expect(s).toMatchObject({ data: { status: "qa-rejected" }, base: { status: 4 } });
    expect(n).toMatchObject({ data: { kind: "qa-rejection", text: "broken", meta: { with_status: "qa-rejected" } } });
    expect(n.group).toBe(s.group);
  });
  it("claims QA when moving into QA unassigned, and forces on request", () => {
    const [s] = build.moveOps({ ...it1, status: "ready-for-qa", qa_assignee: null }, "in-qa", { me: "qa" });
    expect(s.data).toEqual({ status: "in-qa", qa_assignee: "qa" });
    const [d] = build.moveOps({ ...it1, status: "ready-to-deploy" }, "deployed", { me: "x", force: true });
    expect(d.force).toBe(true);
  });
});

describe("request versions", () => {
  const meta = async (uid: string) => (await w.d.query("select meta from notes where uid = $1", [uid]))[0].meta;
  const nv = async (uid: string) => (await w.d.query("select versions from notes where uid = $1", [uid]))[0].versions;
  const status = async () => (await w.d.query("select status, versions from items where uid = 'R1'"))[0];
  const move = async (who: string, to: string, extra: Partial<Op> = {}) =>
    w.one(who, set("item", "R1", "R1", { status: to }, { status: (await status()).versions.status }, extra));
  const requested = async () => {
    await w.one("alice", item("R1", { status: "requested", creator: "alice", developer: "bob", qa_assignee: "carol" }));
    await w.one("alice", child("note", "V1", "R1", { kind: "ticket-request", text: "one\ntwo" }));
  };
  const post = (uid: string, text: string, meta: Record<string, unknown> = {}) =>
    w.one("alice", child("note", uid, "R1", { kind: "ticket-request", text, meta }));

  it("edits in place while requested, then freezes on any exit", async () => {
    await requested();
    expect((await w.one("alice", set("note", "V1", "R1", { text: "one\nthree" }, await nv("V1")))).status).toBe("applied");
    await move("bob", "in-triage");
    expect(await meta("V1")).toMatchObject({ version: 1, frozen: true, frozen_by: "bob", frozen_via: "triage" });
    expect(await w.one("alice", set("note", "V1", "R1", { text: "x" }, await nv("V1")))).toMatchObject({ status: "rejected", reason: "request-frozen" });
    expect(await w.one("alice", { op: "remove", entity: "note", uid: "V1", item_uid: "R1", base: await nv("V1") }))
      .toMatchObject({ status: "rejected", reason: "request-frozen" });
  });

  it("numbers versions itself and refuses server-owned meta", async () => {
    await requested();
    await post("V2", "again", { version: 9, frozen: true, triaged: true, area: "x" });
    expect(await meta("V2")).toEqual({ version: 2, area: "x" });
    const r = await w.one("alice", set("note", "V2", "R1", { "meta.triaged": true }, await nv("V2")));
    expect(r.rejected?.[0]).toMatchObject({ field: "meta.triaged" });
  });

  it("sends a changed request back to requested, with history and notices", async () => {
    await requested();
    await move("bob", "in-triage");
    await move("bob", "todo");
    await post("V2", "one\ntwo\nfour");
    expect((await status()).status).toBe("requested");
    const [h] = await w.d.query("select from_status, to_status, note from status_history where item_uid = 'R1' order by n desc limit 1");
    expect(h).toEqual({ from_status: "todo", to_status: "requested", note: "request v2" });
    const who = (await w.d.query("select handle from notifications where kind = 'request-changed' order by handle")).map((r) => r.handle);
    expect(who).toEqual(["bob", "carol"]);
    expect((await meta("V2")).frozen).toBeUndefined();
  });

  it("marks triage only when triage froze it, even through blocked", async () => {
    await requested();
    await move("bob", "in-triage");
    await move("bob", "blocked");
    await move("bob", "todo");
    expect(await meta("V1")).toMatchObject({ triaged: true, triaged_by: "bob" });
  });

  it("leaves a version that skipped triage untriaged, and the view flags it", async () => {
    await requested();
    await move("bob", "in-progress");
    expect(await meta("V1")).toMatchObject({ frozen: true, frozen_via: "skip" });
    expect((await meta("V1")).triaged).toBeUndefined();
    const v = (await loadItem(w.d, "p", "r1"))!;
    expect(v.untriaged).toBe(true);
    expect(v.triagedVersion).toBeNull();
  });

  it("flags a new version that went straight to work, naming the last triaged one", async () => {
    await requested();
    await move("bob", "in-triage");
    await move("bob", "todo");
    await post("V2", "changed");
    await move("bob", "in-progress");
    const v = (await loadItem(w.d, "p", "r1"))!;
    expect(v.request.meta.version).toBe(2);
    expect(v.requestVersions.map((r: any) => r.meta.version)).toEqual([2, 1]);
    expect([v.untriaged, v.triagedVersion]).toEqual([true, 1]);
  });

  it("freezes an item's first request at once when work has begun", async () => {
    await w.one("alice", item("R1", { status: "in-progress" }));
    await post("V1", "late");
    expect((await status()).status).toBe("in-progress");
    expect(await meta("V1")).toMatchObject({ version: 1, frozen: true, frozen_via: "skip" });
  });

  it("backfills versions on requests written before them", async () => {
    await w.one("alice", item("R1", { status: "review" }));
    await w.one("alice", item("R2", { status: "requested" }));
    for (const [uid, it] of [["A", "R1"], ["B", "R2"]]) {
      await w.d.query(`insert into notes (uid, item_uid, n, kind, text, author, ts, meta, versions, project)
                       values ($1, $2, 1, 'ticket-request', 'x', 'alice', 't', '{}'::jsonb, '{}'::jsonb, 'p')`, [uid, it]);
    }
    expect(await backfillRequestVersions(w.d)).toBe(2);
    expect(await meta("A")).toMatchObject({ version: 1, frozen: true, triaged: true });
    expect(await meta("B")).toEqual({ version: 1 });
    expect(await backfillRequestVersions(w.d)).toBe(0);
  });
});

describe("status override", () => {
  it("moves outside the table with a required reason, recorded in history", async () => {
    const r = await w.one("alice", item("O1", { status: "requested" }));
    const base = { status: r.versions!.status };
    expect(await w.one("alice", set("item", "O1", "O1", { status: "in-qa" }, base, { override: true, reason: " " })))
      .toMatchObject({ status: "rejected" });
    const ops = build.moveOps({ uid: "O1", item_uid: "O1", status: "requested", versions: r.versions!, qa_assignee: null }, "in-qa",
      { me: "alice", override: true, comment: "QA wants an early look" });
    expect(ops[0].data).toEqual({ status: "in-qa", qa_assignee: "alice" });
    expect((await w.apply("alice", ...ops)).map((x) => x.status)).toEqual(["applied", "applied"]);
    const [h] = await w.d.query("select to_status, override, note from status_history where item_uid = 'O1'");
    expect(h).toEqual({ to_status: "in-qa", override: true, note: "QA wants an early look" });
    expect((await w.d.query("select text from notes where item_uid = 'O1' and kind = 'comment'"))[0].text).toMatch(/override.*early look/);
  });

  it("still holds the deploy gate and the agent hand-off", async () => {
    const r = await w.one("alice", item("O2", { status: "in-progress" }));
    await w.one("alice", child("check", "C1", "O2", { title: "migrate", kind: "db-script", timing: "pre-deploy" }));
    const base = { status: r.versions!.status };
    expect((await w.one("alice", set("item", "O2", "O2", { status: "deployed" }, base, { override: true, reason: "hotfix" }))).rejected?.[0].reason)
      .toBe("checks-pending");
    expect((await w.one("alice", set("item", "O2", "O2", { status: "ready-for-qa" }, base, { override: true, reason: "x", via: "agent" }))).rejected?.[0].reason)
      .toBe("agent-handoff");
  });

  it("refuses an override without a reason before building ops", () => {
    expect(() => build.moveOps({ uid: "I", item_uid: "I", status: "todo", versions: { status: 1 } }, "deployed", { me: "a", override: true, comment: "" }))
      .toThrow();
  });
});

describe("request fields, relations and phase titles", () => {
  it("files app, section and URL with a request, and refuses a non-http URL", async () => {
    const ops = build.requestOps({ title: "Cart", type: "bug", priority: "high", description: "steps", app: "web", section: "checkout",
                                   url: "https://example.com/cart" }, "alice");
    expect(ops[0].data!.extra).toEqual({ app: "web", section: "checkout" });
    expect(ops[1].data!.meta).toEqual({ url: "https://example.com/cart" });
    expect(() => build.requestOps({ title: "x", type: "", priority: "", description: "", url: "javascript:alert(1)" }, "a")).toThrow(/http/);
    await w.apply("alice", ...ops);
    expect(await choices(w.d, "p")).toEqual({ web: ["checkout"] });
    expect(await w.one("alice", child("note", "BAD", ops[0].uid, { kind: "ticket-request", text: "x", meta: { url: "ftp://x" } })))
      .toMatchObject({ status: "rejected", reason: "invalid-url" });
    const [n] = await w.d.query("select uid, versions from notes where uid = $1", [ops[1].uid]);
    const r = await w.one("alice", set("note", n.uid, ops[0].uid, { "meta.url": "file:///etc" }, n.versions));
    expect(r.rejected?.[0]).toMatchObject({ field: "meta.url", reason: "invalid-url" });
  });

  it("shows a relation on both items once, and refuses self or unknown targets", async () => {
    await w.one("alice", item("A1"));
    await w.one("alice", item("B1", { status: "in-progress", developer: "bob" }));
    expect(await w.one("alice", child("note", "R0", "A1", { kind: "relation", text: "related", meta: { item: "A1" } }))).toMatchObject({ reason: "bad-relation" });
    expect(await w.one("alice", child("note", "R0", "A1", { kind: "relation", text: "related", meta: { item: "nope" } }))).toMatchObject({ reason: "bad-relation" });
    await w.one("alice", child("note", "R1", "A1", { kind: "relation", text: "related", meta: { item: "B1" } }));
    const a = (await loadItem(w.d, "p", "a1"))!;
    const b = (await loadItem(w.d, "p", "b1"))!;
    expect(a.related.map((r: any) => [r.id, r.status, r.developer])).toEqual([["b1", "in-progress", "bob"]]);
    expect(b.related.map((r: any) => [r.id, r.notes[0].item_uid])).toEqual([["a1", "A1"]]);
    expect(a.links).toEqual([]);
  });

  it("keeps phase titles in extra.phases", async () => {
    const r = await w.one("alice", item("P1"));
    await w.one("alice", set("item", "P1", "P1", { "extra.phases": { "1": "Schema", "2": "UI" } }, {}));
    let v = (await loadItem(w.d, "p", "p1"))!;
    expect(v.phaseTitles).toEqual({ "1": "Schema", "2": "UI" });
    await w.one("alice", set("item", "P1", "P1", { "extra.phases": null }, { "extra.phases": v.item.versions["extra.phases"] }));
    v = (await loadItem(w.d, "p", "p1"))!;
    expect(v.phaseTitles).toEqual({});
    expect(r.status).toBe("applied");
  });
});

describe("validation fixes", () => {
  const nv = async (uid: string) => (await w.d.query("select versions, meta from notes where uid = $1", [uid]))[0];

  it("refuses turning a note into a request or relation, or back", async () => {
    await w.one("alice", item("K1", { status: "requested" }));
    await w.one("alice", child("note", "C1", "K1", { kind: "context", text: "x", meta: { url: "javascript:alert(1)", version: 99 } }));
    const r = await w.one("alice", set("note", "C1", "K1", { kind: "ticket-request" }, (await nv("C1")).versions));
    expect(r, JSON.stringify(r)).toMatchObject({ rejected: [{ field: "kind", reason: "not-settable" }] });
    await w.one("alice", child("note", "Q1", "K1", { kind: "ticket-request", text: "req" }));
    const back = await w.one("alice", set("note", "Q1", "K1", { kind: "context" }, (await nv("Q1")).versions));
    expect(back.rejected?.[0]).toMatchObject({ field: "kind", reason: "not-settable" });
  });

  it("freezes superseded versions too when the item leaves requested", async () => {
    const r = await w.one("alice", item("S1", { status: "requested" }));
    await w.one("alice", child("note", "V1", "S1", { kind: "ticket-request", text: "one" }));
    await w.one("alice", child("note", "V2", "S1", { kind: "ticket-request", text: "two" }));
    await w.one("bob", set("item", "S1", "S1", { status: "in-triage" }, { status: r.versions!.status }));
    expect((await nv("V1")).meta).toMatchObject({ version: 1, frozen: true });
    expect((await nv("V2")).meta).toMatchObject({ version: 2, frozen: true, frozen_via: "triage" });
    expect(await w.one("alice", set("note", "V1", "S1", { text: "rewrite" }, (await nv("V1")).versions))).toMatchObject({ reason: "request-frozen" });
  });

  it("backfills an item caught in triage so leaving triage marks it triaged", async () => {
    const r = await w.one("alice", item("T1", { status: "in-triage" }));
    await w.d.query(`insert into notes (uid, item_uid, n, kind, text, author, ts, meta, versions, project)
                     values ('TQ', 'T1', 1, 'ticket-request', 'x', 'alice', 't', '{}'::jsonb, '{}'::jsonb, 'p')`);
    await backfillRequestVersions(w.d);
    await w.one("bob", set("item", "T1", "T1", { status: "todo" }, { status: r.versions!.status }));
    expect((await nv("TQ")).meta).toMatchObject({ frozen_via: "triage", triaged: true });
  });

  it("refuses a duplicate relation either way, and unrelating removes every note behind it", async () => {
    await w.one("alice", item("A1"));
    await w.one("alice", item("B1"));
    await w.one("alice", child("note", "R1", "A1", { kind: "relation", text: "related", meta: { item: "B1" } }));
    expect(await w.one("bob", child("note", "R2", "B1", { kind: "relation", text: "related", meta: { item: "A1" } })))
      .toMatchObject({ reason: "already-related" });
    const b = (await loadItem(w.d, "p", "b1"))!;
    expect(b.related.map((r: any) => r.notes.map((n: any) => n.uid))).toEqual([["R1"]]);
    const [n] = b.related[0].notes;
    await w.apply("bob", { ...build.removeOp("note", n), group: "g" });
    expect((await loadItem(w.d, "p", "a1"))!.related).toEqual([]);
  });

  it("sets app and section with their own field versions", async () => {
    const r = await w.one("alice", item("X1"));
    const s1 = await w.one("alice", set("item", "X1", "X1", { "extra.app": "web", "extra.section": "cart" }, {}));
    expect(Object.keys(s1.versions!)).toEqual(expect.arrayContaining(["extra.app", "extra.section"]));
    const stale = await w.one("bob", set("item", "X1", "X1", { "extra.section": "checkout" }, { "extra.section": 1 }));
    expect(stale.rejected?.[0]).toMatchObject({ field: "extra.section", reason: "stale" });
    expect(r.status).toBe("applied");
  });
});

describe("request diff", () => {
  it("diffs the URL along with the text", async () => {
    const { lineDiff, said } = await import("@/components/item/RequestView");
    const d = lineDiff(said({ text: "a", meta: { url: "https://x/1" } }), said({ text: "a", meta: { url: "https://x/2" } }));
    expect(d).toEqual([["-", "URL: https://x/1"], ["+", "URL: https://x/2"], [" ", "a"]]);
  });
});

describe("qa-rejected", () => {
  it("offers back to work first, then triage, and counts as past triage", () => {
    expect(moves("qa-rejected", {}).map((m: any) => [m.status, m.group])).toEqual([
      ["in-progress", "next"], ["in-triage", "back"], ["blocked", "park"], ["cancelled", "park"]]);
    expect(PAST_TRIAGE).toContain("qa-rejected");
    expect(deriveCalcStatus(["in-progress", "qa-rejected", "done"])).toBe("qa-rejected");
  });

  it("notifies the developer, counts both bounce forms, and rejects by override too", async () => {
    const r = await w.one("alice", item("Q1", { status: "in-qa", developer: "bob", qa_assignee: "carol" }));
    await w.apply("carol", ...build.moveOps({ uid: "Q1", item_uid: "Q1", status: "in-qa", versions: r.versions!, qa_assignee: "carol" },
      "qa-rejected", { me: "carol", comment: "totals wrong" }));
    expect((await w.d.query("select handle, kind from notifications where item_uid = 'Q1'"))).toEqual([{ handle: "bob", kind: "qa-rejection" }]);
    expect(bounceCount([{ from_status: "in-qa", to_status: "qa-rejected" }, { from_status: "in-qa", to_status: "in-progress" }])).toBe(2);
    const ops = build.moveOps({ uid: "Q1", item_uid: "Q1", status: "todo", versions: {}, qa_assignee: null }, "qa-rejected",
      { me: "carol", override: true, comment: "bad" });
    expect(ops[1].data).toMatchObject({ kind: "qa-rejection", meta: { with_status: "qa-rejected" } });
  });

  it("falls back to in-progress's Jira status", async () => {
    const { jiraTarget } = await import("@/lib/jira/outbound");
    expect(jiraTarget({ "in-progress": "In Progress" }, "qa-rejected")).toBe("In Progress");
    expect(jiraTarget({ "in-progress": "In Progress", "qa-rejected": "Rejected" }, "qa-rejected")).toBe("Rejected");
  });
});

describe("seen", () => {
  it("reads only my notices for that item, and returns the previous visit", async () => {
    const { markSeen } = await import("@/lib/inbox");
    await w.one("alice", item("N1", { developer: "bob" }));
    await w.one("alice", item("N2", { developer: "bob" }));
    await w.one("alice", child("note", "C1", "N1", { kind: "comment", text: "@bob @carol look" }));
    await w.one("alice", child("note", "C2", "N2", { kind: "comment", text: "@bob here too" }));
    const first = await markSeen(w.d, "bob", "p", "N1");
    expect(first.lastSeen).not.toBeNull();             // falls back to just before the oldest unread notice
    expect(Date.parse(first.lastSeen!)).toBeLessThan(Date.now());
    expect(first.unread).toBe(1);                      // N2's notice is still unread
    const unread = await w.d.query("select handle, item_uid from notifications where read_at is null order by handle, item_uid");
    expect(unread).toEqual([{ handle: "bob", item_uid: "N2" }, { handle: "carol", item_uid: "N1" }]);
    const [{ at }] = await w.d.query("update item_seen set seen_at = seen_at - interval '1 minute' returning seen_at as at");   // a later visit
    const again = await markSeen(w.d, "bob", "p", "N1");
    expect(again.lastSeen).toBe(new Date(at).toISOString());
    expect((await markSeen(w.d, "carol", "p", "N2")).lastSeen).toBeNull();   // nothing pending, never visited
  });
});

describe("inbox grouping", () => {
  it("splits what needs you from the rest, groups by ticket, and marks settled notices", async () => {
    const { groupInbox } = await import("@/lib/inbox");
    const n = (id: number, kind: string, item: string, status: string, extra = {}) =>
      ({ id, kind, project: "p", item_uid: item, item_id: item.toLowerCase(), item_title: item, item_status: status, created: new Date(2026, 9, 1, 0, id), ...extra });
    const { needs, fyi } = groupInbox([
      n(1, "mention", "A", "in-progress"), n(2, "ready-for-qa", "B", "in-qa"), n(3, "mention", "A", "in-progress"),
      n(4, "deployed", "C", "deployed"), n(5, "clarification", "B", "in-qa", { note_meta: { state: "answered" } }),
    ]);
    expect(needs.map((g) => [g.item_uid, g.notices.map((x) => x.id)])).toEqual([["B", [5, 2]], ["A", [3, 1]]]);
    expect(needs[0].notices.map((x) => x.settled)).toEqual([true, true]);
    expect(fyi.map((g) => g.item_uid)).toEqual(["C"]);
  });
});

describe("role filters", () => {
  const rows = [
    { id: "a", developer: "dana", qa_assignee: "quinn", creator: "pat" },
    { id: "b", developer: "eli", qa_assignee: "quinn", creator: "priya" },
    { id: "c", developer: "eli", qa_assignee: "rio", creator: "pat" },
  ];
  it("merges entries with or, and tabs show one entry each", async () => {
    const { matchEntries, parseEntries } = await import("@/lib/filters");
    const e = parseEntries("dev:dana,qa:rio,bogus:x,dev:dana");
    expect(e).toEqual([{ role: "dev", who: "dana" }, { role: "qa", who: "rio" }]);
    expect(matchEntries(rows, e, "merged").map((r) => r.id)).toEqual(["a", "c"]);
    expect(matchEntries(rows, e, "tabs", 1).map((r) => r.id)).toEqual(["c"]);
    expect(matchEntries(rows, e, "tabs", 9).map((r) => r.id)).toEqual(["c"]);
    expect(matchEntries(rows, [], "merged")).toHaveLength(3);
  });
  it("rewrites links from before entries", async () => {
    const { legacyQuery } = await import("@/lib/filters");
    expect(legacyQuery({ type: "bug" }, "bob")).toBeNull();
    expect(decodeURIComponent(legacyQuery({ mine: "1", type: "bug" }, "bob")!)).toBe("type=bug&f=dev:bob,qa:bob,by:bob&view=merged");
    expect(decodeURIComponent(legacyQuery({ dev: "dana", qa: "quinn" }, "bob")!)).toBe("f=dev:dana,qa:quinn");
  });
  it("counts each tab on the board", async () => {
    await w.one("alice", item("F1", { status: "todo", developer: "bob" }));
    await w.one("alice", item("F2", { status: "todo", qa_assignee: "bob" }));
    const p = (await project(w.d, "p"))!;
    const r = await board(w.d, p, { entries: [{ role: "dev", who: "bob" }, { role: "qa", who: "bob" }], view: "tabs", tab: 1 }, "bob");
    expect(r.counts).toEqual([1, 1]);
    expect(r.columns.flatMap((c) => c.items.map((i) => i.id))).toEqual(["f2"]);
  });
});

describe("notices", () => {
  it("sends one notice per person per note, the specific kind first", async () => {
    await w.one("alice", item("D1", { developer: "bob", creator: "carol" }));
    await w.one("alice", child("note", "R1", "D1", { kind: "qa-rejection", text: "broken @bob @carol" }));
    await w.one("alice", child("note", "Q1", "D1", { kind: "clarification", text: "@carol @bob which one?" }));
    const rows = await w.d.query("select handle, kind, note_uid from notifications order by note_uid, handle");
    expect(rows).toEqual([
      { handle: "bob", kind: "mention", note_uid: "Q1" }, { handle: "carol", kind: "clarification", note_uid: "Q1" },
      { handle: "bob", kind: "qa-rejection", note_uid: "R1" }, { handle: "carol", kind: "mention", note_uid: "R1" },
    ]);
  });
});

describe("round-4 validation fixes", () => {
  it("counts a notice read on the way in as new on a first visit", async () => {
    const { markSeen } = await import("@/lib/inbox");
    await w.one("alice", item("V1", { developer: "bob" }));
    await w.one("alice", child("note", "C1", "V1", { kind: "comment", text: "@bob look" }));
    await w.d.query("update notifications set read_at = now() where handle = 'bob'");   // opened through the inbox row
    expect((await markSeen(w.d, "bob", "p", "V1")).lastSeen).not.toBeNull();
  });

  it("survives a fractional tab", async () => {
    const { matchEntries } = await import("@/lib/filters");
    const rows = [{ developer: "a" }, { developer: "b" }];
    expect(matchEntries(rows, [{ role: "dev", who: "a" }, { role: "dev", who: "b" }], "tabs", 1.5)).toEqual([{ developer: "b" }]);
  });

  it("keeps my rejections in Awaiting fix whatever the filters", async () => {
    const r = await w.one("alice", item("W1", { status: "in-qa", developer: "bob", qa_assignee: "carol" }));
    await w.apply("carol", ...build.moveOps({ uid: "W1", item_uid: "W1", status: "in-qa", versions: r.versions!, qa_assignee: "carol" },
      "qa-rejected", { me: "carol", comment: "no" }));
    const q = await qaQueue(w.d, "p", "carol", { entries: [{ role: "dev", who: "nobody" }] });
    expect(q.awaitingFix.map((c) => c.uid)).toEqual(["W1"]);
  });

  it("marks a triaged request on a move into qa-rejected", async () => {
    const r = await w.one("alice", item("T2", { status: "requested" }));
    await w.one("alice", child("note", "TR", "T2", { kind: "ticket-request", text: "x" }));
    await w.one("bob", set("item", "T2", "T2", { status: "in-triage" }, { status: r.versions!.status }));
    const v = (await w.d.query("select versions from items where uid = 'T2'"))[0].versions;
    await w.one("bob", set("item", "T2", "T2", { status: "qa-rejected" }, { status: v.status }));
    expect((await w.d.query("select meta from notes where uid = 'TR'"))[0].meta).toMatchObject({ triaged: true });
  });
});
