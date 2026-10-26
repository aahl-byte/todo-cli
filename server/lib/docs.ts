// An item's docs: files it keeps on purpose (designs, plans, handoffs). A doc
// is one row per (item, name key); its bytes sit in the files store. Bytes go
// up under a key this server issued for that item and name; a write then
// names `base`, the sha256 the writer last saw, and is a conflict unless that
// is the current one. Each write is a change in the feed, so CLIs pull it.
import crypto from "node:crypto";
import type { Db, Row } from "./db";
import { DOC_MAX_BYTES, deleteObject, docExt, docType, getObject, inProject, isDocKey, newDocKey } from "./files";
import { nowIso } from "./model";
import { hashUid } from "./ulid";
import { docNameError, docNameKey } from "./doc-view";

export * from "./doc-view";

/** The same uid the CLI gives the doc, so a name key is one doc everywhere. */
export const docUid = (itemUid: string, name: string) => hashUid("doc", itemUid, docNameKey(name));

/** How long an issued upload key can be recorded, and when an unrecorded one is swept. */
const UPLOAD_HOURS = 1;
const SWEEP_HOURS = 24;

export class DocError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface DocWrite {
  status: "applied" | "conflict";
  /** The doc as the server has it now; null when there is none. */
  doc: Row | null;
}

const COLUMNS = "uid, item_uid, name, size, sha256, file_key, content_type, by, via, at, versions, plugin, plugin_sha256, plugin_version";

const clean = (row: Row | undefined): Row | null => (row ? { ...row, size: Number(row.size) } : null);

/** An item's docs, by name. */
export async function listDocs(d: Db, project: string, itemUid: string): Promise<Row[]> {
  const rows = await d.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 order by name`, [project, itemUid]);
  return rows.map((r) => clean(r)!);
}

/** A page of the project's docs (or one item's) in uid order; `next` is the uid to continue after. */
export async function docPage(d: Db, project: string, opts: { item?: string | null; after?: string | null; limit?: number }):
    Promise<{ docs: Row[]; next: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 1000);
  const rows = await d.query(
    `select ${COLUMNS} from docs where project = $1 and ($2::text is null or item_uid = $2) and uid > $3
      order by uid limit $4`, [project, opts.item ?? null, opts.after ?? "", limit + 1]);
  const page = rows.slice(0, limit).map((r) => clean(r)!);
  return { docs: page, next: rows.length > limit ? page[page.length - 1].uid : null };
}

export async function getDoc(d: Db, project: string, uid: string): Promise<Row | null> {
  const [row] = await d.query(`select ${COLUMNS} from docs where project = $1 and uid = $2`, [project, uid]);
  return clean(row);
}

export async function docByName(d: Db, project: string, itemUid: string, name: string): Promise<Row | null> {
  const [row] = await d.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 and name_key = $3`,
    [project, itemUid, docNameKey(name)]);
  return clean(row);
}

/** A 409 when another spelling of `name` is already a doc of the item. */
function refuseTwin(existing: Row | null, name: string): void {
  if (existing && existing.name !== name) {
    throw new DocError(409, `a doc named ${existing.name} already exists; names differing only in case or accents are one doc`);
  }
}

/** Issue a key to upload the doc `name` of an item under, after checking the name. */
export async function issueUpload(d: Db, project: string, itemUid: string, name: unknown, size: unknown): Promise<string> {
  const bad = docNameError(name);
  if (bad) throw new DocError(422, bad);
  const n = Number(size);
  if (!Number.isInteger(n) || n < 0 || n > DOC_MAX_BYTES) throw new DocError(413, "docs are limited to 25 MB");
  const [p] = await d.query("select 1 from projects where key = $1", [project]);
  if (!p) throw new DocError(404, "no such project");
  const [item] = await d.query("select 1 from items where project = $1 and uid = $2", [project, itemUid]);
  if (!item) throw new DocError(422, "no such item");
  refuseTwin(await docByName(d, project, itemUid, name as string), name as string);
  const key = newDocKey(project, name as string);
  await d.query("insert into doc_uploads (project, file_key, item_uid, name_key) values ($1, $2, $3, $4)",
    [project, key, itemUid, docNameKey(name as string)]);
  return key;
}

async function lockProject(t: Db, project: string): Promise<void> {
  const [p] = await t.query("select key from projects where key = $1 for update", [project]);
  if (!p) throw new DocError(404, "no such project");
}

async function bump(t: Db, project: string, uid: string, itemUid: string, deleted: boolean, author: string): Promise<number> {
  const [row] = await t.query("update projects set seq = seq + 1 where key = $1 returning seq", [project]);
  const seq = Number(row.seq);
  await t.query(
    `insert into changes (project, seq, entity, uid, item_uid, deleted, author, ts) values ($1, $2, 'doc', $3, $4, $5, $6, $7)`,
    [project, seq, uid, itemUid, deleted, author, nowIso()]);
  return seq;
}

/** Delete bytes nothing points to any more; a failure is only logged. */
async function discard(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (e) {
    console.error(`docs: couldn't delete ${key}:`, e);
  }
}

/** Record an uploaded file as the doc `name` of an item. The file key must be
 * one issued for this item and name within the hour; size and sha256 come
 * from the stored bytes, and a claimed sha256 must match them. */
export async function recordDoc(d: Db, project: string, handle: string, input: {
  item_uid: string; name: string; file_key: string; base?: string | null; sha256?: string; via?: string;
  /** The <plugin>/<instance> writing it on a plugin's behalf; a write without it keeps the doc's owner. */
  plugin?: string | null;
  /** The version that plugin gave it. */
  plugin_version?: string | null;
}): Promise<DocWrite> {
  const name = input.name;
  const bad = docNameError(name);
  if (bad) throw new DocError(422, bad);
  const key = input.file_key;
  if (typeof key !== "string" || !isDocKey(key) || !inProject(key, project) || !key.endsWith(`.${docExt(name)}`)) {
    throw new DocError(422, "not a doc upload of this project");
  }
  const [issued] = await d.query(
    `select 1 from doc_uploads where project = $1 and file_key = $2 and item_uid = $3 and name_key = $4
        and created > now() - make_interval(hours => $5)`, [project, key, input.item_uid, docNameKey(name), UPLOAD_HOURS]);
  if (!issued) throw new DocError(422, "that upload wasn't issued for this doc, or has expired");
  const bytes = await getObject(key);
  if (!bytes) throw new DocError(422, "the upload is missing");
  if (bytes.length > DOC_MAX_BYTES) throw new DocError(413, "docs are limited to 25 MB");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (input.sha256 != null && input.sha256 !== sha256) throw new DocError(422, "the upload doesn't match its sha256");
  const via = input.via === "agent" ? "agent" : "human";
  const plugin = typeof input.plugin === "string" && input.plugin ? input.plugin.slice(0, 200) : null;
  const { result, superseded } = await d.tx(async (t) => {
    await lockProject(t, project);
    const [row] = await t.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 and name_key = $3`,
      [project, input.item_uid, docNameKey(name)]);
    refuseTwin(row ?? null, name);
    // Taking the key here, under the project lock, makes a second record of it find nothing.
    const [taken] = await t.query(
      `delete from doc_uploads where project = $1 and file_key = $2 and item_uid = $3 and name_key = $4
          and created > now() - make_interval(hours => $5) returning file_key`,
      [project, key, input.item_uid, docNameKey(name), UPLOAD_HOURS]);
    if (!taken) throw new DocError(422, "that upload wasn't issued for this doc, or has expired");
    const current = row?.sha256 ?? null;
    if (sha256 === current) return { result: { status: "applied" as const, doc: clean(row) }, superseded: key };
    if ((input.base ?? null) !== current) return { result: { status: "conflict" as const, doc: clean(row) }, superseded: key };
    const uid = docUid(input.item_uid, name);
    const seq = await bump(t, project, uid, input.item_uid, false, handle);
    await t.query("delete from doc_tombstones where project = $1 and uid = $2", [project, uid]);
    const [saved] = await t.query(
      `insert into docs (project, uid, item_uid, name, name_key, size, sha256, file_key, content_type, by, via, at, versions, plugin, plugin_sha256,
                         plugin_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, case when $14::text is null then null else $7 end,
               case when $14::text is null then null else $15::text end)
       on conflict (project, uid) do update set size = excluded.size, sha256 = excluded.sha256, file_key = excluded.file_key,
         content_type = excluded.content_type, by = excluded.by, via = excluded.via, at = excluded.at, versions = excluded.versions,
         plugin = coalesce(excluded.plugin, docs.plugin), plugin_sha256 = coalesce(excluded.plugin_sha256, docs.plugin_sha256),
         plugin_version = case when excluded.plugin is null then docs.plugin_version else excluded.plugin_version end
       returning ${COLUMNS}`,
      [project, uid, input.item_uid, name, docNameKey(name), bytes.length, sha256, key, docType(name), handle, via, nowIso(),
       JSON.stringify({ sha256: seq }), plugin, plugin && typeof input.plugin_version === "string" ? input.plugin_version.slice(0, 200) : null]);
    return { result: { status: "applied" as const, doc: clean(saved) }, superseded: row?.file_key as string | undefined };
  });
  if (superseded !== result.doc?.file_key) await discard(superseded);
  return result;
}

/** Whether `key` was issued as a doc upload and not yet recorded or expired. */
export async function pendingUpload(d: Db, key: string): Promise<boolean> {
  const [row] = await d.query(
    "select 1 from doc_uploads where file_key = $1 and created > now() - make_interval(hours => $2)", [key, UPLOAD_HOURS]);
  return !!row;
}

/** Delete a doc, unless it changed since `base`. */
export async function removeDoc(d: Db, project: string, handle: string, uid: string, base: string | null): Promise<DocWrite> {
  const { result, gone } = await d.tx(async (t) => {
    await lockProject(t, project);
    const [row] = await t.query(`select ${COLUMNS} from docs where project = $1 and uid = $2`, [project, uid]);
    if (!row) return { result: { status: "applied" as const, doc: null }, gone: null };
    if (row.sha256 !== base) return { result: { status: "conflict" as const, doc: clean(row) }, gone: null };
    await bump(t, project, uid, row.item_uid, true, handle);
    await t.query("delete from docs where project = $1 and uid = $2", [project, uid]);
    await t.query(
      `insert into doc_tombstones (project, uid, item_uid, sha256) values ($1, $2, $3, $4)
       on conflict (project, uid) do update set sha256 = excluded.sha256`, [project, uid, row.item_uid, row.sha256]);
    return { result: { status: "applied" as const, doc: null }, gone: row.file_key as string };
  });
  await discard(gone);
  return result;
}

const SWEEP_EVERY_MS = 60 * 60_000;
let lastSweep = 0;

/** Sweep stale uploads at most once an hour per process; null when not yet due. */
export async function sweepDocUploadsIfDue(d: Db, now = Date.now()): Promise<number | null> {
  if (now - lastSweep < SWEEP_EVERY_MS) return null;
  lastSweep = now;
  return sweepDocUploads(d);
}

/** Drop upload keys never recorded within a day, with their bytes. Returns how many. */
export async function sweepDocUploads(d: Db): Promise<number> {
  const rows = await d.query(
    "delete from doc_uploads where created < now() - make_interval(hours => $1) returning file_key", [SWEEP_HOURS]);
  for (const r of rows) await discard(r.file_key);
  return rows.length;
}
