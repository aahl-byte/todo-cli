// Pure builders for the ops each dashboard action sends. Every set carries the
// versions the form was opened with, so a stale tab is rejected rather than
// overwriting a newer change.
import type { Op } from "./apply";
import { nowIso } from "./model";
import { ulid } from "./ulid";

export type Versions = Record<string, number>;
export interface Ref {
  uid: string;
  item_uid?: string;
  versions: Versions;
}

const via = "human" as const;

function base(versions: Versions, fields: string[]): Versions {
  const out: Versions = {};
  for (const f of fields) if (versions[f] !== undefined) out[f] = versions[f];
  return out;
}

export function setOp(entity: Op["entity"], ref: Ref, data: Record<string, unknown>, extra: Partial<Op> = {}): Op {
  return { op_id: ulid(), op: "set", entity, uid: ref.uid, item_uid: ref.item_uid ?? ref.uid,
           data, base: base(ref.versions, Object.keys(data)), via, ...extra };
}

export function createOp(entity: Op["entity"], itemUid: string, data: Record<string, unknown>, extra: Partial<Op> = {}): Op {
  const uid = ulid();
  return { op_id: ulid(), op: "create", entity, uid, item_uid: entity === "item" ? uid : itemUid, data, via, ...extra };
}

export function removeOp(entity: Op["entity"], ref: Ref): Op {
  return { op_id: ulid(), op: "remove", entity, uid: ref.uid, item_uid: ref.item_uid!, base: { ...ref.versions }, via };
}

export function statusOps(item: Ref, to: string, opts: { force?: boolean } = {}): Op[] {
  return [setOp("item", item, { status: to }, opts.force ? { force: true } : {})];
}

/** Status change plus a note, applied together or not at all. */
function withNote(item: Ref, to: string, kind: string, text: string, meta: Record<string, unknown> = {}): Op[] {
  const group = ulid();
  return [
    setOp("item", item, { status: to }, { group }),
    createOp("note", item.uid, { kind, text, ts: nowIso(), meta }, { group }),
  ];
}

export function rejectOps(item: Ref, text: string): Op[] {
  if (!text.trim()) throw new Error("A rejection needs a comment saying what failed.");
  return withNote(item, "in-progress", "qa-rejection", text.trim(), { with_status: "in-progress" });
}

export function backToWorkOps(item: Ref, comment: string): Op[] {
  return comment.trim() ? withNote(item, "in-progress", "comment", comment.trim()) : statusOps(item, "in-progress");
}

export function pickUpOps(item: Ref & { qa_assignee?: string | null }, me: string): Op[] {
  const data: Record<string, unknown> = { status: "in-qa" };
  if (!item.qa_assignee) data.qa_assignee = me;
  return [setOp("item", item, data)];
}

export function approveOps(item: Ref, deployStep: boolean): Op[] {
  return statusOps(item, deployStep ? "ready-to-deploy" : "done");
}

export function requestOps(form: { title: string; type: string; priority: string; description: string;
                                   developer?: string | null; qa_assignee?: string | null }, me: string): Op[] {
  const title = form.title.trim();
  if (!title) throw new Error("A request needs a title.");
  const item = createOp("item", "", {
    title, type: form.type || "feature", priority: form.priority || "medium", status: "requested",
    creator: me, developer: form.developer || null, qa_assignee: form.qa_assignee || null, created: nowIso(),
  });
  const ops = [item];
  if (form.description.trim()) {
    ops.push(createOp("note", item.uid, { kind: "ticket-request", text: form.description.trim(), ts: nowIso() }));
  }
  return ops;
}

export function answerOps(note: Ref, text: string, me: string): Op[] {
  if (!text.trim()) throw new Error("Write an answer first.");
  return [setOp("note", note, { "meta.state": "answered", "meta.answer": text.trim(),
                                "meta.answered_by": me, "meta.answered_at": nowIso() })];
}

export function noteOps(itemUid: string, kind: string, text: string, meta: Record<string, unknown> = {}): Op[] {
  if (!text.trim()) throw new Error("Write something first.");
  const m = kind === "clarification" ? { state: "open", ...meta } : meta;
  return [createOp("note", itemUid, { kind, text: text.trim(), ts: nowIso(), meta: m })];
}

export function linkOps(itemUid: string, url: string, label: string, type: string): Op[] {
  if (!/^https?:\/\//.test(url.trim())) throw new Error("A link needs an http(s) URL.");
  const l = label.trim();
  return [createOp("note", itemUid, { kind: "link", text: l || url.trim(), ts: nowIso(),
                                      meta: { url: url.trim(), label: l || null, type: type || "other" } })];
}

export function taskOps(itemUid: string, title: string, phase: number | null): Op[] {
  if (!title.trim()) throw new Error("A task needs a title.");
  return [createOp("task", itemUid, { title: title.trim(), status: "todo", phase, position: 1e6 })];
}

export function checkOps(itemUid: string, kind: string, title: string, payload: string, timing: string): Op[] {
  if (!title.trim()) throw new Error("A check needs a title.");
  return [createOp("check", itemUid, { kind, title: title.trim(), payload: payload.trim() || null,
                                       timing: timing || "pre-deploy", status: "pending" })];
}
