// Images pasted into requests and comments, and items' docs. S3 when
// `S3_BUCKET` is set: the browser posts straight to the bucket with a
// presigned form, and reads go through a short-lived presigned URL, so the
// bucket stays private. Without S3 (local dev) the files live under
// `TODO_FILES_DIR`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "./ulid";
import { withBase } from "@/lib/base";

export const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const KEY_RE = /^[\w-]+\/[\w-]+\/[0-9A-Z]{26}\.(png|jpe?g|gif|webp)$/;
const READ_SECONDS = 300;

/** Docs take any type, up to 25 MB, under `<project>/docs/<ulid>.<ext>`. */
export const DOC_MAX_BYTES = 25 * 1024 * 1024;
export const DOC_KEY_RE = /^[\w-]+\/docs\/[0-9A-Z]{26}\.[a-z0-9]{1,10}$/;
const DOC_SCOPE = "docs";
const DOC_TYPES: Record<string, string> = {
  md: "text/markdown", markdown: "text/markdown", html: "text/html", htm: "text/html", txt: "text/plain", log: "text/plain",
  csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", xml: "application/xml",
  yaml: "text/yaml", yml: "text/yaml", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  pdf: "application/pdf", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
  flac: "audio/flac", opus: "audio/opus", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm",
  mov: "video/quicktime", ogv: "video/ogg", zip: "application/zip", ...TYPES,
};

export const s3 = () => !!process.env.S3_BUCKET;
/** S3 the browser never talks to: the app streams reads and takes uploads itself. */
export const proxied = () => s3() && process.env.S3_PROXY === "1";
/** Whether the app itself receives uploads and serves bytes (local files or proxied S3). */
export const viaApp = () => !s3() || proxied();
/** Uploads work with S3, or locally off Vercel (whose disk doesn't keep files). */
export const filesEnabled = () => s3() || !process.env.VERCEL;
export const typeOf = (key: string) => TYPES[key.split(".").pop()!.toLowerCase()];

const keyPart = (s: string) => s.replace(/[^\w-]/g, "").slice(0, 64) || "x";

export function newKey(project: string, scope: string, contentType: string): string | null {
  const ext = EXT[contentType];
  if (!ext) return null;
  const s = keyPart(scope);
  return `${keyPart(project)}/${s === DOC_SCOPE ? `${s}_` : s}/${ulid()}.${ext}`;
}

/** A doc's file extension, lowercased, as its key carries it. */
export function docExt(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : "bin";
}

/** The type a doc is stored and served as, from its name. */
export const docType = (name: string) => DOC_TYPES[docExt(name)] ?? "application/octet-stream";

export const newDocKey = (project: string, name: string) => `${keyPart(project)}/${DOC_SCOPE}/${ulid()}.${docExt(name)}`;
export const isDocKey = (key: string) => DOC_KEY_RE.test(key);

/** Whether a stored file belongs to the project. */
export const inProject = (key: string, project: string) => key.startsWith(`${keyPart(project)}/`);

/** The S3 client; `browser` signs URLs for the address browsers use, which
 * differs from the server's own when the bucket is local. */
async function client(browser = false) {
  const { S3Client } = await import("@aws-sdk/client-s3");
  const endpoint = (browser && process.env.S3_PUBLIC_ENDPOINT) || process.env.S3_ENDPOINT || undefined;
  return new S3Client({ region: process.env.S3_REGION, endpoint, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "1" });
}

/** Where and how the browser sends the file: a multipart POST of `fields`
 * plus the file as `file`, last. */
export async function uploadTarget(key: string, contentType: string): Promise<{ url: string; fields: Record<string, string> }> {
  if (viaApp()) return { url: withBase(`/api/files/${key}`), fields: {} };
  const { createPresignedPost } = await import("@aws-sdk/s3-presigned-post");
  const [min, max] = isDocKey(key) ? [0, DOC_MAX_BYTES] : [1, MAX_BYTES];
  return createPresignedPost(await client(true), {
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    Conditions: [["content-length-range", min, max], ["eq", "$Content-Type", contentType]],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });
}

export async function readUrl(key: string, disposition?: string): Promise<string> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await client(true), new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, ResponseContentDisposition: disposition }),
    { expiresIn: READ_SECONDS });
}

/** Store a file the server itself produced, in S3 or locally. */
export async function putObject(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (!s3()) {
    await saveLocal(key, bytes).catch((e) => { if (e?.code !== "EEXIST") throw e; });
    return;
  }
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await (await client()).send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key, Body: bytes, ContentType: contentType }));
}

/** A stored file's bytes, from S3 or local disk; null when absent. */
export async function getObject(key: string): Promise<Uint8Array | null> {
  if (!s3()) {
    const b = await readLocal(key);
    return b ? new Uint8Array(b) : null;
  }
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    const res = await (await client()).send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return res.Body ? await res.Body.transformToByteArray() : null;
  } catch (e) {
    if ((e as { name?: string }).name === "NoSuchKey") return null;
    throw e;
  }
}

export async function hasObject(key: string): Promise<boolean> {
  if (!s3()) return (await readLocal(key)) !== null;
  const { HeadObjectCommand } = await import("@aws-sdk/client-s3");
  try {
    await (await client()).send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
    return true;
  } catch {
    return false;
  }
}

const localPath = (key: string) => path.join(path.resolve(process.env.TODO_FILES_DIR ?? ".files"), ...key.split("/"));

export async function saveLocal(key: string, bytes: Uint8Array): Promise<void> {
  const file = localPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: "wx" });
}

export async function readLocal(key: string): Promise<Buffer | null> {
  try {
    return await readFile(localPath(key));
  } catch {
    return null;
  }
}

/** A stored file for the browser: a short-lived S3 link, or the bytes when the
 * app serves them. A doc passes its own type and `content-disposition`. */
export async function fileResponse(key: string, doc?: { type: string; disposition: string }): Promise<Response> {
  if (!viaApp()) {
    return new Response(null, { status: 302, headers: { location: await readUrl(key, doc?.disposition), "cache-control": "private, max-age=240" } });
  }
  const bytes = await getObject(key);
  if (!bytes) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  const type = doc?.type ?? typeOf(key);
  const headers: Record<string, string> = {
    "content-type": /^text\//.test(type) ? `${type}; charset=utf-8` : type,
    "x-content-type-options": "nosniff", "cache-control": doc ? "private, no-cache" : "private, max-age=86400",
  };
  const csp = cspFor(type);
  if (csp) headers["content-security-policy"] = csp;
  if (doc) headers["content-disposition"] = doc.disposition;
  return new Response(new Uint8Array(bytes), { headers });
}

/** Opened on its own, a stored file runs no script on our origin. PDFs get
 * none, as a sandbox stops browsers' PDF viewers. */
function cspFor(type: string): string | null {
  if (type === "application/pdf") return null;
  if (/^(text\/html|image\/svg|application\/xml|text\/xml)/.test(type)) return "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";
  return "default-src 'none'";
}
