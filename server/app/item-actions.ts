"use server";
// The item page's writes. Each takes the entity versions the editor captured
// when it opened, builds ops (lib/ops-builder.ts) and applies them through the
// same path as the CLI's sync.
import { revalidatePath } from "next/cache";
import { applyOps, ProjectNotFound, type Op, type Result } from "@/lib/apply";
import { describe, POSTABLE_KINDS, type ActionState } from "@/lib/action-helpers";
import { db } from "@/lib/db";
import { later } from "@/lib/http";
import { flushJira } from "@/lib/jira/flush";
import { markRead } from "@/lib/inbox";
import { LINK_TYPES, CHECK_KINDS, nowIso } from "@/lib/model";
import * as build from "@/lib/ops-builder";
import { requireUser } from "@/lib/session";
import type { Db } from "@/lib/db";
import { ulid } from "@/lib/ulid";

type Versions = Record<string, number>;
const fail = (message: string): ActionState => ({ ok: false, message, at: Date.now() });

async function apply(project: string, ops: Op[] | (() => Op[]), handle: string, d?: Db): Promise<ActionState> {
  let built: Op[];
  try {
    built = typeof ops === "function" ? ops() : ops;
  } catch (e) {
    return fail((e as Error).message);
  }
  const conn = d ?? (await db());
  let results: Result[];
  try {
    results = await applyOps(conn, project, built, { handle });
  } catch (e) {
    if (e instanceof ProjectNotFound) return fail("No such project.");
    throw e;
  }
  later(() => flushJira(conn));
  const state = describe(results);
  if (state.ok) revalidatePath(`/p/${project}`, "layout");
  return state;
}

async function itemRow(d: Db, project: string, uid: string) {
  const [row] = await d.query(
    `select i.uid, i.status, i.qa_assignee, i.versions, p.deploy_step,
            (select h.from_status from status_history h where h.project = i.project and h.item_uid = i.uid
               and h.to_status = 'blocked' order by h.n desc limit 1) as blocked_from
       from items i join projects p on p.key = i.project where i.uid = $1 and i.project = $2`, [uid, project]);
  return row ?? null;
}

export async function moveItem(a: { project: string; uid: string; versions: Versions; to: string;
                                    comment?: string; force?: boolean; override?: boolean }): Promise<ActionState> {
  const user = await requireUser();
  const d = await db();
  const cur = await itemRow(d, a.project, a.uid);
  if (!cur) return fail("No such item.");
  return apply(a.project, () => build.moveOps(
    { uid: a.uid, item_uid: a.uid, versions: a.versions, status: cur.status, qa_assignee: cur.qa_assignee },
    a.to, { me: user.handle, comment: a.comment, force: a.force, deployStep: cur.deploy_step, override: a.override,
            previous: cur.status === "blocked" ? cur.blocked_from : null }), user.handle, d);
}

const ITEM_FIELDS = ["title", "type", "priority", "developer", "qa_assignee", "super_phase", "extra.app", "extra.section"];

export async function editItem(a: { project: string; uid: string; versions: Versions; data: Record<string, unknown> }) {
  const user = await requireUser();
  const data = Object.fromEntries(Object.entries(a.data).filter(([k]) => ITEM_FIELDS.includes(k)));
  if (typeof data.title === "string" && !data.title.trim()) return fail("A title can't be empty.");
  return apply(a.project, [build.setOp("item", { uid: a.uid, versions: a.versions }, data)], user.handle);
}

/** Edit the current request in place while it isn't frozen; otherwise post a
 * new version, which sends the item back to requested. */
export async function saveRequest(a: { project: string; itemUid: string; noteUid?: string | null;
                                       versions?: Versions; text: string; url?: string | null; newVersion?: boolean }) {
  const user = await requireUser();
  const text = a.text.trim();
  return apply(a.project, () => {
    const url = build.requestUrl(a.url);
    if (!text && !url) throw new Error("Write the request first.");
    return a.noteUid && !a.newVersion
      ? [build.setOp("note", { uid: a.noteUid, item_uid: a.itemUid, versions: a.versions ?? {} }, { text, "meta.url": url })]
      : [build.createOp("note", a.itemUid, { kind: "ticket-request", text, ts: nowIso(), meta: url ? { url } : {} })];
  }, user.handle);
}

/** Name a phase, or clear its name with an empty title. Titles live together
 * in `extra.phases`, so the base is that map's version. */
export async function setPhaseTitle(a: { project: string; uid: string; versions: Versions; phase: number; title: string }) {
  const user = await requireUser();
  if (!Number.isInteger(a.phase)) return fail("Pick a phase.");
  const d = await db();
  const [row] = await d.query("select extra from items where uid = $1 and project = $2", [a.uid, a.project]);
  if (!row) return fail("No such item.");
  const phases: Record<string, string> = { ...(row.extra?.phases ?? {}) };
  const title = a.title.trim();
  if (title) phases[String(a.phase)] = title;
  else delete phases[String(a.phase)];
  return apply(a.project, [build.setOp("item", { uid: a.uid, versions: a.versions }, { "extra.phases": Object.keys(phases).length ? phases : null })], user.handle, d);
}

/** Remove a relation: every note behind it, on either item, as one group. */
export async function unrelate(a: { project: string; notes: { uid: string; item_uid: string; versions: Versions }[] }) {
  const user = await requireUser();
  const group = ulid();
  return apply(a.project, a.notes.map((n) => ({ ...build.removeOp("note", n), group })), user.handle);
}

/** Relate two items as associated work. */
export async function relate(a: { project: string; itemUid: string; target: string }) {
  const user = await requireUser();
  return apply(a.project, () => build.relationOps(a.itemUid, a.target), user.handle);
}

/** Items to relate to, by title or id. */
export async function findItems(a: { project: string; q: string; not: string }) {
  await requireUser();
  const d = await db();
  const q = `%${a.q.trim().toLowerCase().replace(/[%_\\]/g, "")}%`;
  return d.query(
    `select uid, id, title, status from items where project = $1 and uid <> $2
       and (lower(title) like $3 or lower(id) like $3) order by (status in ('done', 'deployed', 'cancelled')), created desc limit 12`,
    [a.project, a.not, q]) as Promise<{ uid: string; id: string; title: string; status: string }[]>;
}

export async function addEntry(a: { project: string; itemUid: string; kind: string; text: string }) {
  const user = await requireUser();
  const text = a.text.trim();
  if (!text) return fail("Write something first.");
  if (a.kind === "log") {
    return apply(a.project, [build.createOp("log", a.itemUid, { text, ts: nowIso() })], user.handle);
  }
  if (!POSTABLE_KINDS.includes(a.kind)) return fail(`Notes of kind ${a.kind} can't be posted here.`);
  return apply(a.project, () => build.noteOps(a.itemUid, a.kind, text), user.handle);
}

export async function editNote(a: { project: string; itemUid: string; uid: string; versions: Versions; text: string }) {
  const user = await requireUser();
  const d = await db();
  const [n] = await d.query("select kind from notes where uid = $1 and project = $2", [a.uid, a.project]);
  if (!n || n.kind !== "context") return fail("Only notes can be edited.");
  if (!a.text.trim()) return fail("A note can't be empty.");
  return apply(a.project, [build.setOp("note", { uid: a.uid, item_uid: a.itemUid, versions: a.versions }, { text: a.text.trim() })], user.handle, d);
}

export async function removeEntry(a: { project: string; itemUid: string; entity: "note" | "log"; uid: string; versions: Versions }) {
  const user = await requireUser();
  const d = await db();
  if (a.entity === "note") {
    const [n] = await d.query("select kind, author from notes where uid = $1 and project = $2", [a.uid, a.project]);
    if (!n) return fail("Already removed.");
    if (n.kind === "ticket-request") return fail("The request can't be removed.");
    if ((n.kind === "comment" || n.kind === "qa-rejection") && n.author !== user.handle) return fail("Only the author can remove a comment.");
  }
  return apply(a.project, [build.removeOp(a.entity, { uid: a.uid, item_uid: a.itemUid, versions: a.versions })], user.handle, d);
}

export async function answerQuestion(a: { project: string; itemUid: string; uid: string; versions: Versions; text: string }) {
  const user = await requireUser();
  return apply(a.project, () => build.answerOps({ uid: a.uid, item_uid: a.itemUid, versions: a.versions }, a.text, user.handle), user.handle);
}

export async function addTask(a: { project: string; itemUid: string; title: string; phase: number | null }) {
  const user = await requireUser();
  return apply(a.project, () => build.taskOps(a.itemUid, a.title, a.phase), user.handle);
}

export async function setTask(a: { project: string; itemUid: string; uid: string; versions: Versions;
                                   data: { status?: string; title?: string; phase?: number | null } }) {
  const user = await requireUser();
  const data: Record<string, unknown> = {};
  if (a.data.status) data.status = a.data.status;
  if (typeof a.data.title === "string") {
    if (!a.data.title.trim()) return fail("A task needs a title.");
    data.title = a.data.title.trim();
  }
  if ("phase" in a.data) {
    data.phase = a.data.phase;
    data.position = 1e6;
  }
  return apply(a.project, [build.setOp("task", { uid: a.uid, item_uid: a.itemUid, versions: a.versions }, data)], user.handle);
}

export async function removeChild(a: { project: string; itemUid: string; entity: "task" | "check"; uid: string; versions: Versions }) {
  const user = await requireUser();
  return apply(a.project, [build.removeOp(a.entity, { uid: a.uid, item_uid: a.itemUid, versions: a.versions })], user.handle);
}

export async function addLink(a: { project: string; itemUid: string; url: string; label: string; type: string }) {
  const user = await requireUser();
  const type = LINK_TYPES.includes(a.type) ? a.type : "other";
  return apply(a.project, () => build.linkOps(a.itemUid, a.url, a.label, type), user.handle);
}

export async function addCheck(a: { project: string; itemUid: string; kind: string; title: string; payload: string; timing: string }) {
  const user = await requireUser();
  const kind = CHECK_KINDS.includes(a.kind) ? a.kind : "other";
  return apply(a.project, () => build.checkOps(a.itemUid, kind, a.title, a.payload, a.timing), user.handle);
}

export async function setCheck(a: { project: string; itemUid: string; uid: string; versions: Versions; status: string }) {
  const user = await requireUser();
  return apply(a.project, [build.setOp("check", { uid: a.uid, item_uid: a.itemUid, versions: a.versions }, { status: a.status })], user.handle);
}

export async function markAllRead(): Promise<ActionState> {
  const user = await requireUser();
  const d = await db();
  const rows = await d.query("select id from notifications where handle = $1 and read_at is null", [user.handle]);
  await markRead(d, user.handle, rows.map((r) => Number(r.id)));
  revalidatePath("/inbox");
  return { ok: true, at: Date.now() };
}
