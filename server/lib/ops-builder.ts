// Pure builders for the ops each dashboard action sends. Every set carries the
// versions the form was opened with, so a stale tab is rejected rather than
// overwriting a newer change.
import type { Op } from "./apply";
import { moves, nowIso, STATUSES } from "./model";
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
  return withNote(item, "qa-rejected", "qa-rejection", text.trim(), { with_status: "qa-rejected" });
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
                                   developer?: string | null; qa_assignee?: string | null;
                                   app?: string | null; section?: string | null; url?: string | null }, me: string): Op[] {
  const title = form.title.trim();
  if (!title) throw new Error("A request needs a title.");
  const url = requestUrl(form.url);
  const extra = Object.fromEntries((["app", "section"] as const).map((k) => [k, form[k]?.trim()]).filter(([, v]) => v));
  const item = createOp("item", "", {
    title, type: form.type || "feature", priority: form.priority || "medium", status: "requested",
    creator: me, developer: form.developer || null, qa_assignee: form.qa_assignee || null, created: nowIso(),
    ...(Object.keys(extra).length ? { extra } : {}),
  });
  const ops = [item];
  if (form.description.trim() || url) {
    ops.push(createOp("note", item.uid, { kind: "ticket-request", text: form.description.trim(), ts: nowIso(), meta: url ? { url } : {} }));
  }
  return ops;
}

/** A request's "where it happens" URL: blank, or http(s). */
export function requestUrl(raw: string | null | undefined): string | null {
  const url = (raw ?? "").trim();
  if (!url) return null;
  if (!/^https?:\/\/\S+$/.test(url)) throw new Error("The URL must start with http:// or https://");
  return url;
}

export function relationOps(itemUid: string, target: string): Op[] {
  if (!target || target === itemUid) throw new Error("Pick another item.");
  return [createOp("note", itemUid, { kind: "relation", text: "related", ts: nowIso(), meta: { item: target } })];
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

/** A move outside the normal flow: any status, with a required reason that is
 * posted as a comment and kept on the history row. Server rules (the deploy
 * gate, the agent hand-off) still apply. */
function overrideOps(item: MoveItem, to: string, reason: string, opts: { me: string; force?: boolean }): Op[] {
  if (!STATUSES.includes(to as any) || to === item.status) throw new Error(`Can't move to ${to}.`);
  if (!reason) throw new Error("An override needs a reason.");
  const data: Record<string, unknown> = { status: to };
  if (to === "in-qa" && !item.qa_assignee) data.qa_assignee = opts.me;
  const group = ulid();
  return [
    setOp("item", item, data, { group, override: true, reason, ...(opts.force ? { force: true } : {}) }),
    // A rejection, even an overriding one, reaches the developer as a QA rejection.
    to === "qa-rejected"
      ? createOp("note", item.uid, { kind: "qa-rejection", text: reason, ts: nowIso(), meta: { with_status: to } }, { group })
      : createOp("note", item.uid, { kind: "comment", text: `status override → ${to}: ${reason}`, ts: nowIso() }, { group }),
  ];
}

export interface MoveItem extends Ref {
  status: string;
  qa_assignee?: string | null;
}

/** The ops for one dashboard status move: checked against the allowed moves,
 * with the comment it asks for posted in the same group (a qa-rejection when
 * QA sends work back), and QA claimed by whoever moves it into QA. */
export function moveOps(item: MoveItem, to: string, opts: {
  me: string; comment?: string; force?: boolean; deployStep?: boolean; previous?: string | null; override?: boolean;
}): Op[] {
  const ctx = { deployStep: opts.deployStep, hasQa: !!item.qa_assignee, previous: opts.previous };
  const comment = (opts.comment ?? "").trim();
  if (opts.override) return overrideOps(item, to, comment, opts);
  const move = moves(item.status, ctx).find((m) => m.status === to);
  if (!move) throw new Error(`Can't move from ${item.status} to ${to}.`);
  if (move.comment === "required" && !comment) throw new Error("This move needs a comment.");
  const data: Record<string, unknown> = { status: to };
  if (to === "in-qa" && !item.qa_assignee) data.qa_assignee = opts.me;
  const extra: Partial<Op> = opts.force ? { force: true } : {};
  if (!comment) return [setOp("item", item, data, extra)];
  const group = ulid();
  return [
    setOp("item", item, data, { ...extra, group }),
    createOp("note", item.uid, {
      kind: move.rejection ? "qa-rejection" : "comment", text: comment, ts: nowIso(),
      meta: move.rejection ? { with_status: to } : {},
    }, { group }),
  ];
}
