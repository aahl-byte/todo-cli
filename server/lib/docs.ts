// An item's docs: files it keeps on purpose (designs, plans, handoffs). A doc
// is one row per (item, name); its bytes sit in the files store. A write names
// `base`, the sha256 the writer last saw, and is a conflict unless that is the
// current one. Each write is a change in the feed, so CLIs pull it.
import crypto from "node:crypto";
import type { Db, Row } from "./db";
import { DOC_MAX_BYTES, docType, getObject, inProject, isDocKey } from "./files";
import { nowIso } from "./model";
import { hashUid } from "./ulid";

export const MAX_NAME = 120;

/** Why `name` isn't a plain file name a doc can have, or null. Mirrors docs.name_error. */
export function docNameError(name: unknown): string | null {
  if (typeof name !== "string" || !name) return "a doc needs a name";
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return "a doc name is a plain file name, without \"/\"";
  if (name.startsWith(".")) return "a doc name can't start with \".\"";
  if (name.length > MAX_NAME) return `a doc name is at most ${MAX_NAME} characters`;
  return null;
}

/** The same uid the CLI gives the doc, so a name is one doc everywhere. */
export const docUid = (itemUid: string, name: string) => hashUid("doc", itemUid, name);

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

const COLUMNS = "uid, item_uid, name, size, sha256, file_key, content_type, by, via, at, versions";

const clean = (row: Row | undefined): Row | null => (row ? { ...row, size: Number(row.size) } : null);

export async function listDocs(d: Db, project: string, itemUid: string): Promise<Row[]> {
  const rows = await d.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 order by name`, [project, itemUid]);
  return rows.map((r) => clean(r)!);
}

export async function getDoc(d: Db, project: string, uid: string): Promise<Row | null> {
  const [row] = await d.query(`select ${COLUMNS} from docs where project = $1 and uid = $2`, [project, uid]);
  return clean(row);
}

export async function docByName(d: Db, project: string, itemUid: string, name: string): Promise<Row | null> {
  const [row] = await d.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 and name = $3`, [project, itemUid, name]);
  return clean(row);
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

/** Record an uploaded file as the doc `name` of an item. The size and sha256
 * come from the stored bytes; a claimed sha256 must match them. */
export async function recordDoc(d: Db, project: string, handle: string, input: {
  item_uid: string; name: string; file_key: string; base?: string | null; sha256?: string; via?: string;
}): Promise<DocWrite> {
  const name = input.name;
  const bad = docNameError(name);
  if (bad) throw new DocError(422, bad);
  if (typeof input.file_key !== "string" || !isDocKey(input.file_key) || !inProject(input.file_key, project)) {
    throw new DocError(422, "not a doc upload of this project");
  }
  const [item] = await d.query("select 1 from items where project = $1 and uid = $2", [project, input.item_uid]);
  if (!item) throw new DocError(422, "no such item");
  const bytes = await getObject(input.file_key);
  if (!bytes) throw new DocError(422, "the upload is missing");
  if (bytes.length > DOC_MAX_BYTES) throw new DocError(413, "docs are limited to 25 MB");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  if (input.sha256 != null && input.sha256 !== sha256) throw new DocError(422, "the upload doesn't match its sha256");
  const via = input.via === "agent" ? "agent" : "human";
  return d.tx(async (t) => {
    await lockProject(t, project);
    const [row] = await t.query(`select ${COLUMNS} from docs where project = $1 and item_uid = $2 and name = $3`,
      [project, input.item_uid, name]);
    const current = row?.sha256 ?? null;
    if (sha256 === current) return { status: "applied", doc: clean(row) };
    if ((input.base ?? null) !== current) return { status: "conflict", doc: clean(row) };
    const uid = docUid(input.item_uid, name);
    const seq = await bump(t, project, uid, input.item_uid, false, handle);
    const [saved] = await t.query(
      `insert into docs (project, uid, item_uid, name, size, sha256, file_key, content_type, by, via, at, versions)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       on conflict (project, uid) do update set size = excluded.size, sha256 = excluded.sha256, file_key = excluded.file_key,
         content_type = excluded.content_type, by = excluded.by, via = excluded.via, at = excluded.at, versions = excluded.versions
       returning ${COLUMNS}`,
      [project, uid, input.item_uid, name, bytes.length, sha256, input.file_key, docType(name), handle, via, nowIso(),
       JSON.stringify({ sha256: seq })]);
    return { status: "applied", doc: clean(saved) };
  });
}

/** Delete a doc, unless it changed since `base`. */
export async function removeDoc(d: Db, project: string, handle: string, uid: string, base: string | null): Promise<DocWrite> {
  return d.tx(async (t) => {
    await lockProject(t, project);
    const [row] = await t.query(`select ${COLUMNS} from docs where project = $1 and uid = $2`, [project, uid]);
    if (!row) return { status: "applied", doc: null };
    if (row.sha256 !== base) return { status: "conflict", doc: clean(row) };
    await bump(t, project, uid, row.item_uid, true, handle);
    await t.query("delete from docs where project = $1 and uid = $2", [project, uid]);
    return { status: "applied", doc: null };
  });
}

// ── rendering ────────────────────────────────────────────────────────────────
export type DocKind = "markdown" | "html" | "json" | "code" | "text" | "image" | "pdf" | "audio" | "video" | "download";

/** highlight.js languages by extension. */
export const LANGUAGES: Record<string, string> = {
  yaml: "yaml", yml: "yaml", css: "css", ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", py: "python", sql: "sql", sh: "bash", bash: "bash", json: "json", toml: "ini", ini: "ini",
  xml: "xml", go: "go", rs: "rust", rb: "ruby", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", php: "php",
  swift: "swift", kt: "kotlin", md: "markdown",
};

const KINDS: [DocKind, string[]][] = [
  ["markdown", ["md", "markdown"]],
  ["html", ["html", "htm"]],
  ["json", ["json"]],
  ["text", ["txt", "log", "csv", "tsv"]],
  ["image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]],
  ["pdf", ["pdf"]],
  ["audio", ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]],
  ["video", ["mp4", "m4v", "webm", "mov", "ogv"]],
];

export function docExtOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

/** How the doc page shows a doc, from its name. */
export function docKind(name: string): DocKind {
  const ext = docExtOf(name);
  for (const [kind, exts] of KINDS) if (exts.includes(ext)) return kind;
  return LANGUAGES[ext] ? "code" : "download";
}

/** Text larger than this is offered as a download instead of rendered. */
export const RENDER_MAX_BYTES = 2 * 1024 * 1024;

/** The dashboard page of a doc. */
export const docPath = (project: string, itemId: string, name: string) =>
  `/p/${encodeURIComponent(project)}/i/${encodeURIComponent(itemId)}/docs/${encodeURIComponent(name)}`;

/** The doc's bytes for the browser; `download` asks to save rather than show. */
export const docRawPath = (project: string, uid: string, download = false) =>
  `/api/projects/${encodeURIComponent(project)}/docs/${uid}${download ? "?download=1" : ""}`;
