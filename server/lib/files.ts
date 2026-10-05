// Images pasted into requests and comments. S3 when `S3_BUCKET` is set: the
// browser posts straight to the bucket with a presigned form, and reads go
// through a short-lived presigned URL, so the bucket stays private. Without
// S3 (local dev) the files live under `TODO_FILES_DIR`.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ulid } from "./ulid";

export const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
export const KEY_RE = /^[\w-]+\/[\w-]+\/[0-9A-Z]{26}\.(png|jpe?g|gif|webp)$/;
const READ_SECONDS = 300;

export const s3 = () => !!process.env.S3_BUCKET;
/** Uploads work with S3, or locally off Vercel (whose disk doesn't keep files). */
export const filesEnabled = () => s3() || !process.env.VERCEL;
export const typeOf = (key: string) => TYPES[key.split(".").pop()!.toLowerCase()];

export function newKey(project: string, scope: string, contentType: string): string | null {
  const ext = EXT[contentType];
  if (!ext) return null;
  const clean = (s: string) => s.replace(/[^\w-]/g, "").slice(0, 64) || "x";
  return `${clean(project)}/${clean(scope)}/${ulid()}.${ext}`;
}

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
  if (!s3()) return { url: `/api/files/${key}`, fields: {} };
  const { createPresignedPost } = await import("@aws-sdk/s3-presigned-post");
  return createPresignedPost(await client(true), {
    Bucket: process.env.S3_BUCKET!,
    Key: key,
    Conditions: [["content-length-range", 1, MAX_BYTES], ["eq", "$Content-Type", contentType]],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });
}

export async function readUrl(key: string): Promise<string> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  return getSignedUrl(await client(true), new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }), { expiresIn: READ_SECONDS });
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
