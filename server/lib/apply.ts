// The single write path. The CLI's sync, dashboard actions and the Jira bridge
// all send ops here; see docs/plans/2026-10-02-team-store-implementation.md §2.3.
import type { Db, Row } from "./db";
import {
  CHECK_KINDS, COMPLETE, CREATE_FIELDS, DEFAULTS, JSON_FIELD, NOTE_KINDS, PAST_TRIAGE, SETTABLE, STATUSES, TABLE,
  deriveCalcStatus, isSettable, mentions, nowIso, type Entity,
} from "./model";
import { ulid } from "./ulid";
import { queueJira } from "./jira/outbound";

export interface Op {
  op_id: string;
  op: "create" | "set" | "remove";
  entity: Entity;
  uid: string;
  item_uid: string;
  data?: Record<string, any>;
  base?: Record<string, number>;
  via?: "human" | "agent";
  force?: boolean;
  group?: string;
  /** A status move outside the dashboard's normal flow; `reason` is required. */
  override?: boolean;
  reason?: string;
}

export interface Actor {
  handle: string;
  /** Bridge writes skip the version check. */
  unconditional?: boolean;
  /** Set on writes that came from Jira, so they are not echoed back. */
  bridge?: boolean;
}

export interface Rejection {
  field: string;
  reason: string;
  server_value?: unknown;
  /** The field's current version, so the client can adopt the server value. */
  version?: number;
  by?: string | null;
  at?: string | null;
}

export interface Result {
  op_id: string;
  status: "applied" | "rejected";
  versions?: Record<string, number>;
  assigned_n?: number;
  assigned_id?: string;
  rejected?: Rejection[];
  reason?: string;
  by?: string | null;
  at?: string | null;
  duplicate?: boolean;
  /** The current row, when a create meets a uid that already exists. */
  data?: Record<string, any>;
  message?: string;
}

export class ProjectNotFound extends Error {}

class Rollback extends Error {
  constructor(public results: Result[]) {
    super("group rolled back");
  }
}

/** Apply `ops` for `project` as `actor`. Results come back in input order. */
export async function applyOps(db: Db, project: string, ops: Op[], actor: Actor): Promise<Result[]> {
  const units: Op[][] = [];
  const groups = new Map<string, Op[]>();
  for (const op of ops) {
    if (!op.group) {
      units.push([op]);
      continue;
    }
    let g = groups.get(op.group);
    if (!g) {
      g = [];
      groups.set(op.group, g);
      units.push(g);
    }
    g.push(op);
  }
  const byId = new Map<string, Result>();
  for (const unit of units) {
    for (const r of await applyUnit(db, project, unit, actor)) byId.set(r.op_id, r);
  }
  return ops.map((op) => byId.get(op.op_id)!);
}

async function applyUnit(db: Db, project: string, unit: Op[], actor: Actor): Promise<Result[]> {
  const grouped = !!unit[0].group;
  try {
    return await db.tx(async (t) => {
      const locked = await t.query("select key from projects where key = $1 for update", [project]);
      if (!locked.length) throw new ProjectNotFound(project);
      const out: Result[] = [];
      for (const op of unit) {
        const prior = await t.query("select result from applied_ops where project = $1 and op_id = $2",
          [project, op.op_id]);
        if (prior.length) {
          out.push({ ...(prior[0].result as Result), duplicate: true });
          continue;
        }
        out.push(await applyOne(new Ctx(t, project, actor, op), op));
      }
      if (grouped && out.some(isRejected)) throw new Rollback(out);
      for (const r of out) {
        if (r.duplicate) continue;
        await t.query("insert into applied_ops (op_id, project, result) values ($1, $2, $3::jsonb)",
          [r.op_id, project, JSON.stringify(r)]);
      }
      return out;
    });
  } catch (e) {
    if (e instanceof ProjectNotFound) throw e;
    if (e instanceof Rollback) {
      // Nothing in a rolled-back group applied, so no result may report versions.
      return e.results.map((r) => ({
        op_id: r.op_id, status: "rejected",
        reason: r.status === "rejected" && r.reason ? r.reason : "group-rolled-back",
        ...(r.rejected?.length ? { rejected: r.rejected } : {}),
      }));
    }
    // A malformed op must not wedge the store: reject the unit and remember it.
    // Anything else (a dropped connection, a deadlock) fails the request so the
    // client's outbox retries it.
    if (!deterministic(e)) throw e;
    const message = String((e as Error)?.message ?? e).slice(0, 300);
    const results: Result[] = unit.map((op) => ({ op_id: op.op_id, status: "rejected", reason: "error", message }));
    for (const r of results) {
      await db.query(
        "insert into applied_ops (op_id, project, result) values ($1, $2, $3::jsonb) on conflict do nothing",
        [r.op_id, project, JSON.stringify(r)]);
    }
    return results;
  }
}

/** Failures that recur on every retry: bad data (22), constraint violations
 * (23), bad SQL or names (42), and type errors from a malformed op. Anything
 * else — a dropped connection, a deadlock — fails the request so it is retried. */
function deterministic(e: unknown): boolean {
  const code = String((e as { code?: unknown })?.code ?? "");
  return /^(22|23|42)/.test(code) || e instanceof TypeError || e instanceof RangeError;
}

function isRejected(r: Result): boolean {
  return r.status === "rejected" || !!r.rejected?.length;
}

class Ctx {
  constructor(public t: Db, public project: string, public actor: Actor, public op: Op) {}

  /** Take the project's next seq and record that `uid` changed. */
  async bump(entity: Entity | "history", uid: string, itemUid: string, deleted = false): Promise<number> {
    const [row] = await this.t.query(
      "update projects set seq = seq + 1 where key = $1 returning seq", [this.project]);
    const seq = Number(row.seq);
    await this.t.query(
      `insert into changes (project, seq, entity, uid, item_uid, deleted, author, ts)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [this.project, seq, entity, uid, itemUid, deleted, this.actor.handle, nowIso()]);
    return seq;
  }

  async who(seq: number | undefined): Promise<{ by: string | null; at: string | null }> {
    if (seq === undefined) return { by: null, at: null };
    const [row] = await this.t.query(
      "select author, ts from changes where project = $1 and seq = $2", [this.project, seq]);
    return { by: row?.author ?? null, at: row?.ts ?? null };
  }

  async notify(handle: string | null | undefined, kind: string, itemUid: string, noteUid?: string) {
    if (!handle || handle === this.actor.handle) return;
    const known = await this.t.query("select 1 from users where handle = $1", [handle]);
    if (!known.length) return;
    await this.t.query(
      "insert into notifications (handle, kind, project, note_uid, item_uid, actor) values ($1, $2, $3, $4, $5, $6)",
      [handle, kind, this.project, noteUid ?? null, itemUid, this.actor.handle]);
  }
}

async function applyOne(ctx: Ctx, op: Op): Promise<Result> {
  if (op.data != null && (typeof op.data !== "object" || Array.isArray(op.data))) return reject(op, "invalid-data");
  if (op.base != null && (typeof op.base !== "object" || Array.isArray(op.base))) return reject(op, "invalid-base");
  if (!TABLE[op.entity] || op.entity === ("history" as Entity)) return reject(op, "bad-entity");
  if (op.op === "create") return create(ctx, op);
  if (op.op === "set") return set(ctx, op);
  if (op.op === "remove") return remove(ctx, op);
  return reject(op, "bad-op");
}

function reject(op: Op, reason: string, extra: Partial<Result> = {}): Result {
  return { op_id: op.op_id, status: "rejected", reason, ...extra };
}

async function load(ctx: Ctx, entity: Entity, uid: string): Promise<Row | null> {
  const rows = entity === "item"
    ? await ctx.t.query("select * from items where uid = $1 and project = $2", [uid, ctx.project])
    : await ctx.t.query(
        `select * from ${TABLE[entity]} where uid = $1 and project = $2`, [uid, ctx.project]);
  return rows[0] ?? null;
}

async function removedReason(ctx: Ctx, op: Op): Promise<Result> {
  const [tomb] = await ctx.t.query("select seq from tombstones where uid = $1 and project = $2", [op.uid, ctx.project]);
  if (!tomb) return reject(op, "unknown");
  return reject(op, "removed", await ctx.who(Number(tomb.seq)));
}

const isInt = (v: unknown) => Number.isInteger(v);

function invalid(entity: Entity, field: string, value: unknown): boolean {
  if (field === "n") return !(isInt(value) && (value as number) > 0);
  if (field === "position") return typeof value !== "number" || !Number.isFinite(value);
  if (field === "phase" || field === "super_phase") return !isInt(value);
  if (field === "text") return typeof value !== "string";
  if (["type", "priority", "creator", "developer", "qa_assignee", "payload", "ts", "id", "created"].includes(field))
    return typeof value !== "string";
  if (field === "status" && entity === "item") return !STATUSES.includes(value as any);
  if (field === "status" && entity === "task") return !STATUSES.includes(value as any);
  if (field === "status" && entity === "check") return !["pending", "done"].includes(value as any);
  if (field === "kind" && entity === "note") return !NOTE_KINDS.includes(value as any);
  if (field === "kind" && entity === "check") return !CHECK_KINDS.includes(value as any);
  if (field === "timing") return !["pre-deploy", "post-deploy"].includes(value as any);
  if (field === "title" && (entity === "item" || entity === "task" || entity === "check"))
    return typeof value !== "string" || !value.trim();
  return false;
}

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── create ───────────────────────────────────────────────────────────────────
async function create(ctx: Ctx, op: Op): Promise<Result> {
  const { entity } = op;
  const data = op.data ?? {};
  const jsonCol = JSON_FIELD[entity];
  const existing = await load(ctx, entity, op.uid);
  if (existing) {
    const fields = CREATE_FIELDS[entity].filter((f) => f !== "n" && f !== "id" && f in data);
    const identical = fields.every((f) => same(existing[f], data[f]))
      && (!jsonCol || !(jsonCol in data) || same(existing[jsonCol], data[jsonCol]));
    return identical
      ? { op_id: op.op_id, status: "applied", versions: existing.versions }
      : reject(op, "uid-exists", { data: existing });
  }
  const [tomb] = await ctx.t.query("select 1 from tombstones where uid = $1 and project = $2", [op.uid, ctx.project]);
  if (tomb) return removedReason(ctx, op);

  const row: Record<string, any> = { ...DEFAULTS[entity] };
  for (const f of CREATE_FIELDS[entity]) if (f in data) row[f] = data[f];
  for (const f of Object.keys(row)) {
    if (row[f] !== undefined && row[f] !== null && invalid(entity, f, row[f])) return reject(op, `invalid-${f}`);
  }
  if (entity === "item" && row.status === "ready-for-qa" && op.via === "agent") return reject(op, "agent-handoff");
  const result: Result = { op_id: op.op_id, status: "applied" };

  let itemUid = op.item_uid;
  if (entity === "item") {
    itemUid = op.uid;
    if (typeof row.title !== "string" || !row.title.trim()) return reject(op, "invalid-title");
    const base = slug(String(row.id || row.title));
    let id = base;
    for (let n = 2; (await ctx.t.query("select 1 from items where project = $1 and id = $2", [ctx.project, id])).length; n++) {
      id = `${base}-${n}`;
    }
    if (row.id && id !== row.id) result.assigned_id = id;
    row.id = id;
    row.created = row.created || nowIso();
    row.creator = row.creator ?? ctx.actor.handle;
    row.completed = COMPLETE.includes(row.status) ? data.completed || nowIso() : null;
  } else {
    const parent = await ctx.t.query("select 1 from items where uid = $1 and project = $2", [itemUid, ctx.project]);
    if (!parent.length) return reject(op, "no-item");
    const table = TABLE[entity];
    const wanted = Number.isInteger(row.n) && row.n > 0 ? row.n : null;
    const taken = wanted !== null
      && (await ctx.t.query(`select 1 from ${table} where project = $3 and item_uid = $1 and n = $2`, [itemUid, wanted, ctx.project])).length > 0;
    if (wanted === null || taken) {
      const [m] = await ctx.t.query(`select coalesce(max(n), 0) as n from ${table} where project = $2 and item_uid = $1`, [itemUid, ctx.project]);
      row.n = Number(m.n) + 1;
      if (wanted !== null) result.assigned_n = row.n;
    }
    if (entity === "note" || entity === "log") {
      row.ts = row.ts || nowIso();
      if (typeof row.text !== "string") return reject(op, "invalid-text");
      row.author = ctx.actor.handle;
      row.via = op.via ?? "human";
    }
    if (entity === "note") row.source = data.source ?? null;

  }
  if (jsonCol) row[jsonCol] = data[jsonCol] && typeof data[jsonCol] === "object" ? { ...data[jsonCol] } : {};
  if (entity === "note") {
    const bad = await badNoteMeta(ctx, itemUid, row.kind, row.meta);
    if (bad) return reject(op, bad);
  }
  let request: { bounce: boolean } | null = null;
  if (entity === "note" && row.kind === "ticket-request") request = await newRequestVersion(ctx, itemUid, row);

  const seq = await ctx.bump(entity, op.uid, itemUid);
  const versions: Record<string, number> = {};
  for (const f of SETTABLE[entity]) versions[f] = seq;
  if (jsonCol) for (const k of Object.keys(row[jsonCol])) versions[`${jsonCol}.${k}`] = seq;
  row.versions = versions;
  row.uid = op.uid;
  row.project = ctx.project;
  if (entity !== "item") row.item_uid = itemUid;

  const cols = Object.keys(row);
  const jsonCols = new Set([jsonCol, "versions"].filter(Boolean) as string[]);
  await ctx.t.query(
    `insert into ${TABLE[entity]} (${cols.join(", ")}) values (${cols.map((c, i) => `$${i + 1}${jsonCols.has(c) ? "::jsonb" : ""}`).join(", ")})`,
    cols.map((c) => (jsonCols.has(c) ? JSON.stringify(row[c]) : row[c])));
  result.versions = versions;

  if (entity === "item" && Array.isArray(data.history)) await importHistory(ctx, itemUid, data.history);
  if (entity === "task") await recalc(ctx, itemUid);
  if (entity === "note") await noteCreated(ctx, itemUid, row);
  if (request?.bounce) await bounceToRequested(ctx, itemUid, row.meta.version, op, op.uid);
  if (entity === "note") await queueJira(ctx.t, ctx.actor, { kind: "note", project: ctx.project, itemUid, note: row });
  return result;
}

/** A request's URL must be http(s); a relation must name another item here. */
async function badNoteMeta(ctx: Ctx, itemUid: string, kind: string, meta: Record<string, any>): Promise<string | null> {
  if (kind === "ticket-request" && meta.url != null && !/^https?:\/\/\S+$/.test(String(meta.url))) return "invalid-url";
  if (kind === "relation") {
    const target = meta.item;
    if (typeof target !== "string" || target === itemUid) return "bad-relation";
    const [hit] = await ctx.t.query("select 1 from items where project = $1 and uid = $2", [ctx.project, target]);
    if (!hit) return "bad-relation";
    const [dup] = await ctx.t.query(
      `select 1 from notes where project = $1 and kind = 'relation'
         and ((item_uid = $2 and meta->>'item' = $3) or (item_uid = $3 and meta->>'item' = $2))`, [ctx.project, itemUid, target]);
    if (dup) return "already-related";
  }
  return null;
}

// ── request versions ──────────────────────────────────────────────────────────
// A request is a series of ticket-request notes, meta.version 1, 2, 3…; the
// highest is current. A version freezes once its item leaves `requested`, and
// a frozen version never changes: a new one is posted instead, which sends the
// item back to `requested` so the change gets triaged. These meta keys are the
// server's own; no client can set them.
/** Note kinds a note can't be changed to or from: their checks run at create. */
const FIXED_KINDS = ["ticket-request", "relation"];
export const REQUEST_META = ["version", "frozen", "frozen_at", "frozen_by", "frozen_via", "triaged", "triaged_at", "triaged_by"];
/** Statuses that mean triage is done. */

async function newRequestVersion(ctx: Ctx, itemUid: string, row: Record<string, any>): Promise<{ bounce: boolean }> {
  for (const k of REQUEST_META) delete row.meta[k];
  const [m] = await ctx.t.query(
    `select coalesce(max(coalesce((meta->>'version')::int, 1)), 0) as v, count(*)::int as n from notes
      where project = $1 and item_uid = $2 and kind = 'ticket-request'`, [ctx.project, itemUid]);
  row.meta.version = Number(m.n) === 0 ? 1 : Number(m.v) + 1;
  const [item] = await ctx.t.query("select status from items where uid = $1 and project = $2", [itemUid, ctx.project]);
  if (!item || item.status === "requested") return { bounce: false };
  // An item's first request, arriving after work began, records what it was
  // built against: frozen at once and flagged untriaged.
  if (row.meta.version === 1) {
    Object.assign(row.meta, { frozen: true, frozen_at: nowIso(), frozen_by: ctx.actor.handle, frozen_via: "skip" });
    return { bounce: false };
  }
  // A changed request goes back to `requested`, and freezes like any version
  // when the item next leaves it.
  return { bounce: true };
}

/** A new request version on an item past `requested` sends it back there. */
async function bounceToRequested(ctx: Ctx, itemUid: string, version: number, op: Op, noteUid: string) {
  const [item] = await ctx.t.query("select * from items where uid = $1 and project = $2", [itemUid, ctx.project]);
  if (!item || item.status === "requested") return;
  const seq = await ctx.bump("item", itemUid, itemUid);
  const versions = { ...(item.versions ?? {}), status: seq };
  await ctx.t.query(
    "update items set status = 'requested', completed = null, versions = $3::jsonb where uid = $1 and project = $2",
    [itemUid, ctx.project, JSON.stringify(versions)]);
  await statusChanged(ctx, { ...op, override: false, reason: `request v${version}` }, item, "requested");
  for (const who of [item.developer, item.qa_assignee, item.creator]) await ctx.notify(who, "request-changed", itemUid, noteUid);
  // Jira hears of the move back even when Jira's own edit caused it.
  if (ctx.actor.bridge) await queueJira(ctx.t, { ...ctx.actor, bridge: false }, { kind: "status", project: ctx.project, itemUid, status: "requested" });
}

async function currentRequest(ctx: Ctx, itemUid: string): Promise<Row | null> {
  const [r] = await ctx.t.query(
    `select * from notes where project = $1 and item_uid = $2 and kind = 'ticket-request'
      order by coalesce((meta->>'version')::int, 1) desc, n desc limit 1`, [ctx.project, itemUid]);
  return r ?? null;
}

async function writeRequestMeta(ctx: Ctx, note: Row, patch: Record<string, unknown>) {
  const seq = await ctx.bump("note", note.uid, note.item_uid);
  const versions = { ...(note.versions ?? {}) };
  for (const k of Object.keys(patch)) versions[`meta.${k}`] = seq;
  await ctx.t.query("update notes set meta = $3::jsonb, versions = $4::jsonb where uid = $1 and project = $2",
    [note.uid, ctx.project, JSON.stringify({ ...(note.meta ?? {}), ...patch }), JSON.stringify(versions)]);
}

/** Freeze the current version when the item leaves `requested`; mark it
 * triaged on the first move past triage, if triage is how it was frozen. */
async function requestLifecycle(ctx: Ctx, itemUid: string, from: string, to: string) {
  const req = await currentRequest(ctx, itemUid);
  if (!req) return;
  const meta = req.meta ?? {};
  if (from === "requested" && to !== "requested") {
    // Superseded versions freeze too, so no version stays editable.
    const open = await ctx.t.query(
      `select * from notes where project = $1 and item_uid = $2 and kind = 'ticket-request' and coalesce(meta->>'frozen', 'false') <> 'true'`,
      [ctx.project, itemUid]);
    const stamp = { frozen: true, frozen_at: nowIso(), frozen_by: ctx.actor.handle, frozen_via: to === "in-triage" ? "triage" : "skip" };
    for (const n of open) await writeRequestMeta(ctx, n, { version: n.meta?.version ?? 1, ...stamp });
    return;
  }
  if (PAST_TRIAGE.includes(to) && meta.frozen && meta.frozen_via === "triage" && !meta.triaged) {
    await writeRequestMeta(ctx, req, { triaged: true, triaged_at: nowIso(), triaged_by: ctx.actor.handle });
  }
}

/** Version metadata for requests written before versions existed. */
export async function backfillRequestVersions(d: Db): Promise<number> {
  const rows = await d.query(
    `select n.project, n.uid, n.item_uid, i.status from notes n join items i on i.uid = n.item_uid and i.project = n.project
      where n.kind = 'ticket-request' and n.meta->>'version' is null order by n.project, n.item_uid, n.n`);
  let count = 0;
  for (const r of rows) {
    await d.tx(async (t) => {
      await t.query("select key from projects where key = $1 for update", [r.project]);
      const [{ v }] = await t.query(
        `select count(*)::int as v from notes where project = $1 and item_uid = $2 and kind = 'ticket-request' and meta->>'version' is not null`,
        [r.project, r.item_uid]);
      const version = Number(v) + 1;
      const frozen = r.status !== "requested";
      const triaged = PAST_TRIAGE.includes(r.status);
      const viaTriage = triaged || r.status === "in-triage";
      const patch: Record<string, unknown> = { version, ...(frozen ? { frozen: true, frozen_via: viaTriage ? "triage" : "skip" } : {}),
                                               ...(triaged ? { triaged: true } : {}) };
      const [{ seq }] = await t.query("update projects set seq = seq + 1 where key = $1 returning seq", [r.project]);
      await t.query(`insert into changes (project, seq, entity, uid, item_uid, deleted, author, ts) values ($1, $2, 'note', $3, $4, false, 'migration', $5)`,
        [r.project, Number(seq), r.uid, r.item_uid, nowIso()]);
      await t.query("update notes set meta = meta || $3::jsonb where uid = $1 and project = $2", [r.uid, r.project, JSON.stringify(patch)]);
    });
    count++;
  }
  return count;
}

async function set(ctx: Ctx, op: Op): Promise<Result> {
  const { entity } = op;
  const row = await load(ctx, entity, op.uid);
  if (!row) return removedReason(ctx, op);
  if (entity === "note" && row.kind === "ticket-request" && row.meta?.frozen) return reject(op, "request-frozen");
  const jsonCol = JSON_FIELD[entity];
  const versions: Record<string, number> = { ...(row.versions ?? {}) };
  const rejected: Rejection[] = [];
  const accepted: [string, unknown][] = [];
  const out: Record<string, number> = {};

  for (const [field, value] of Object.entries(op.data ?? {})) {
    const current = jsonCol && field.startsWith(jsonCol + ".")
      ? (row[jsonCol] ?? {})[field.slice(jsonCol.length + 1)]
      : row[field];
    const version = versions[field];
    if (!isSettable(entity, field) || (entity === "note" && field.startsWith("meta.") && REQUEST_META.includes(field.slice(5)))
        || (entity === "note" && field === "kind" && value !== row.kind && [row.kind, value].some((k) => FIXED_KINDS.includes(k as string)))
        || (entity === "note" && row.kind === "relation" && field === "meta.item")) {
      rejected.push({ field, reason: "not-settable", server_value: current ?? null, version });
      continue;
    }
    if (value !== null && invalid(entity, field, value)) {
      rejected.push({ field, reason: "invalid", server_value: current ?? null, version });
      continue;
    }
    if (entity === "note" && field.startsWith("meta.")) {
      const bad = await badNoteMeta(ctx, row.item_uid, row.kind, { ...(row.meta ?? {}), [field.slice(5)]: value });
      if (bad) {
        rejected.push({ field, reason: bad, server_value: current ?? null, version });
        continue;
      }
    }
    if (same(value, current)) {
      out[field] = version ?? 0;
      continue;
    }
    const checked = !ctx.actor.unconditional && field !== "position";
    if (checked && version !== undefined && op.base?.[field] !== version) {
      rejected.push({ field, reason: "stale", server_value: current, version, ...(await ctx.who(version)) });
      continue;
    }
    if (entity === "item" && field === "status") {
      const why = await statusRule(ctx, op, row, String(value));
      if (why) {
        rejected.push({ field, reason: why, server_value: current, version });
        continue;
      }
    }
    accepted.push([field, value]);
  }

  if (accepted.length) {
    const itemUid = entity === "item" ? row.uid : row.item_uid;
    const seq = await ctx.bump(entity, op.uid, itemUid);
    const json = jsonCol ? { ...(row[jsonCol] ?? {}) } : null;
    const cols: Record<string, unknown> = {};
    for (const [field, value] of accepted) {
      if (jsonCol && field.startsWith(jsonCol + ".")) {
        const key = field.slice(jsonCol.length + 1);
        if (value === null) delete json![key];
        else json![key] = value;
      } else {
        cols[field] = value;
      }
      versions[field] = seq;
      out[field] = seq;
    }
    if (json && accepted.some(([f]) => f.startsWith(jsonCol + "."))) cols[jsonCol!] = json;
    const statusChange = entity === "item" && "status" in cols ? String(cols.status) : null;
    if (statusChange) {
      const wasComplete = COMPLETE.includes(row.status);
      const isComplete = COMPLETE.includes(statusChange);
      if (isComplete && !wasComplete) cols.completed = nowIso();
      if (!isComplete && wasComplete) cols.completed = null;
    }
    cols.versions = versions;
    const names = Object.keys(cols);
    const jsonCols = new Set([jsonCol, "versions"].filter(Boolean) as string[]);
    await ctx.t.query(
      `update ${TABLE[entity]} set ${names.map((c, i) => `${c} = $${i + 2}${jsonCols.has(c) ? "::jsonb" : ""}`).join(", ")} where uid = $1 and project = $${names.length + 2}`,
      [op.uid, ...names.map((c) => (jsonCols.has(c) ? JSON.stringify(cols[c]) : cols[c])), ctx.project]);

    if (statusChange) await statusChanged(ctx, op, row, statusChange);
    if (entity === "task") await recalc(ctx, itemUid);
    if (entity === "note" && json && json.state === "answered" && (row.meta ?? {}).state !== "answered") {
      await ctx.notify(row.author, "answer", itemUid, row.uid);
    }
  }
  return { op_id: op.op_id, status: rejected.length && !accepted.length && !Object.keys(out).length ? "rejected" : "applied",
           versions: out, ...(rejected.length ? { rejected } : {}) };
}

async function statusRule(ctx: Ctx, op: Op, item: Row, to: string): Promise<string | null> {
  if (op.override && !(op.reason ?? "").trim()) return "reason-required";
  if (to === "ready-for-qa" && op.via === "agent") return "agent-handoff";
  if (to === "deployed" && !op.force) {
    const [c] = await ctx.t.query(
      "select count(*)::int as n from checks where project = $2 and item_uid = $1 and timing = 'pre-deploy' and status <> 'done'",
      [item.uid, ctx.project]);
    if (Number(c.n) > 0) return "checks-pending";
  }
  return null;
}

async function statusChanged(ctx: Ctx, op: Op, item: Row, to: string): Promise<void> {
  let forced = false;
  if (to === "deployed" && op.force) {
    const [c] = await ctx.t.query(
      "select count(*)::int as n from checks where project = $2 and item_uid = $1 and timing = 'pre-deploy' and status <> 'done'",
      [item.uid, ctx.project]);
    forced = Number(c.n) > 0;
  }
  const [m] = await ctx.t.query(
    "select coalesce(max(n), 0) as n from status_history where project = $2 and item_uid = $1", [item.uid, ctx.project]);
  const uid = ulid();
  await ctx.t.query(
    `insert into status_history (uid, item_uid, n, from_status, to_status, by, via, forced, ts, project, override, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [uid, item.uid, Number(m.n) + 1, item.status, to, ctx.actor.handle, op.via ?? "human", forced, nowIso(), ctx.project,
     !!op.override, op.reason ?? null]);
  await ctx.bump("history", uid, item.uid);
  await requestLifecycle(ctx, item.uid, item.status, to);
  const [fresh] = await ctx.t.query("select developer, qa_assignee, creator from items where uid = $1 and project = $2", [item.uid, ctx.project]);
  if (to === "ready-for-qa") await ctx.notify(fresh.qa_assignee, "ready-for-qa", item.uid);
  if (to === "deployed") await ctx.notify(fresh.creator, "deployed", item.uid);
  await queueJira(ctx.t, ctx.actor, { kind: "status", project: ctx.project, itemUid: item.uid, status: to });
}

/** Status history an item gathered before it was ever synced. */
async function importHistory(ctx: Ctx, itemUid: string, entries: any[]): Promise<void> {
  let n = 0;
  for (const h of entries) {
    if (!h || !STATUSES.includes(h.to) || (h.from != null && !STATUSES.includes(h.from))) continue;
    const uid = typeof h.uid === "string" && h.uid ? h.uid : ulid();
    n += 1;
    await ctx.t.query(
      `insert into status_history (uid, item_uid, n, from_status, to_status, by, via, forced, ts, project)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict (project, uid) do nothing`,
      [uid, itemUid, n, h.from ?? null, h.to, typeof h.by === "string" ? h.by : ctx.actor.handle,
       h.via === "agent" ? "agent" : "human", !!h.forced, typeof h.ts === "string" ? h.ts : nowIso(), ctx.project]);
    await ctx.bump("history", uid, itemUid);
  }
}

async function noteCreated(ctx: Ctx, itemUid: string, note: Row): Promise<void> {
  const [item] = await ctx.t.query("select developer, creator from items where uid = $1 and project = $2", [itemUid, ctx.project]);
  if (note.kind === "comment" || note.kind === "qa-rejection") {
    for (const h of mentions(note.text)) await ctx.notify(h, "mention", itemUid, note.uid);
  }
  if (note.kind === "qa-rejection") await ctx.notify(item.developer, "qa-rejection", itemUid, note.uid);
  if (note.kind === "clarification") await ctx.notify(item.creator, "clarification", itemUid, note.uid);
}

async function recalc(ctx: Ctx, itemUid: string): Promise<void> {
  const tasks = await ctx.t.query("select status from tasks where project = $2 and item_uid = $1", [itemUid, ctx.project]);
  const calc = deriveCalcStatus(tasks.map((r) => r.status));
  const [item] = await ctx.t.query("select calc_status from items where uid = $1 and project = $2", [itemUid, ctx.project]);
  if ((item.calc_status ?? null) === calc) return;
  await ctx.t.query("update items set calc_status = $2 where uid = $1 and project = $3", [itemUid, calc, ctx.project]);
  await ctx.bump("item", itemUid, itemUid);
}

// ── remove ───────────────────────────────────────────────────────────────────
async function remove(ctx: Ctx, op: Op): Promise<Result> {
  const { entity } = op;
  if (entity === "item") return reject(op, "not-removable");
  const row = await load(ctx, entity, op.uid);
  if (!row) return removedReason(ctx, op);
  if (entity === "note" && row.kind === "ticket-request") return reject(op, row.meta?.frozen ? "request-frozen" : "not-removable");
  if (!ctx.actor.unconditional) {
    const stale: Rejection[] = [];
    for (const [field, version] of Object.entries(row.versions ?? {})) {
      if (field === "position") continue;
      if (op.base?.[field] !== version) {
        const current = JSON_FIELD[entity] && field.startsWith(JSON_FIELD[entity] + ".")
          ? (row[JSON_FIELD[entity]!] ?? {})[field.split(".").slice(1).join(".")]
          : row[field];
        stale.push({ field, reason: "stale", server_value: current, ...(await ctx.who(version as number)) });
      }
    }
    if (stale.length) return { op_id: op.op_id, status: "rejected", reason: "stale", rejected: stale };
  }
  const seq = await ctx.bump(entity, op.uid, row.item_uid, true);
  await ctx.t.query(`delete from ${TABLE[entity]} where uid = $1 and project = $2`, [op.uid, ctx.project]);
  await ctx.t.query("insert into tombstones (uid, entity, item_uid, seq, project) values ($1, $2, $3, $4, $5)",
    [op.uid, entity, row.item_uid, seq, ctx.project]);
  if (entity === "task") await recalc(ctx, row.item_uid);
  return { op_id: op.op_id, status: "applied", versions: {} };
}
