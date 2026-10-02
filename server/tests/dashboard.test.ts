import { beforeEach, describe, expect, it } from "vitest";
import * as build from "@/lib/ops-builder";
import { board, deployPlan, item as loadItem, project, qaQueue } from "@/lib/views";
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
    expect(status.data).toEqual({ status: "in-progress" });
    expect(note).toMatchObject({ op: "create", entity: "note", item_uid: "I1",
      data: { kind: "qa-rejection", text: "broken on Safari", meta: { with_status: "in-progress" } } });
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
    const cols = await board(w.d, p, {}, "bob");
    const by = Object.fromEntries(cols.map((c) => [c.key, c.items.map((i) => i.id)]));
    expect(by.progress).toEqual(["a1"]);
    expect(by.deploy).toEqual(["b1"]);
    expect(cols.find((c) => c.key === "parked")).toBeUndefined();
    const a = cols.find((c) => c.key === "progress")!.items[0];
    expect(a).toMatchObject({ open_questions: 1, task_statuses: ["done", "todo"] });
    expect(cols.find((c) => c.key === "deploy")!.items[0].pending_pre).toBe(2);
    const parked = await board(w.d, p, { parked: true }, "bob");
    expect(parked.find((c) => c.key === "parked")!.items.map((i) => i.id)).toEqual(["c1"]);
    expect((await board(w.d, p, { mine: true }, "bob")).flatMap((c) => c.items.map((i) => i.id))).toEqual(["a1"]);
  });

  it("finds work an agent parked in review for its developer", async () => {
    const a = await seed();
    await w.one("alice", set("item", "A1", "A1", { status: "in-progress" }, { status: a.versions!.status }));
    const v = (await w.d.query("select versions from items where uid = 'A1'"))[0].versions;
    await w.one("alice", set("item", "A1", "A1", { status: "review" }, { status: v.status }, { via: "agent" }));
    const p = (await project(w.d, "p"))!;
    const ids = (await board(w.d, p, { review: true }, "bob")).flatMap((c) => c.items.map((i) => i.id));
    expect(ids).toEqual(["a1"]);
    expect((await board(w.d, p, { review: true }, "carol")).flatMap((c) => c.items)).toEqual([]);
  });

  it("hides the deploy column for projects without a deploy step", async () => {
    await w.d.query("update projects set deploy_step = false");
    const p = (await project(w.d, "p"))!;
    expect((await board(w.d, p, {}, "x")).map((c) => c.key)).not.toContain("deploy");
  });

  it("loads an item with phases, questions, history and bounces", async () => {
    const a = await seed();
    await w.one("carol", set("item", "A1", "A1", { status: "in-qa" }, { status: a.versions!.status }));
    const v = (await w.d.query("select versions from items where uid = 'A1'"))[0].versions;
    await w.one("carol", set("item", "A1", "A1", { status: "in-progress" }, { status: v.status }));
    const view = (await loadItem(w.d, "p", "a1"))!;
    expect(view.phases).toEqual([expect.objectContaining({ phase: 1, done: 1 })]);
    expect(view.openQuestions.map((n) => n.uid)).toEqual(["Q1"]);
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
    expect(plan.pre.map((g) => g.kind)).toEqual(["prereq-branch", "db-script"]);
    expect(plan.pre[0].checks[0].warning).toBe("not deployed");
  });
});
