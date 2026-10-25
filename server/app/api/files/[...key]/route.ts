import { pendingUpload } from "@/lib/docs";
import { authed, json } from "@/lib/http";
import { DOC_MAX_BYTES, docType, fileResponse, hasObject, isDocKey, KEY_RE, MAX_BYTES, putObject, viaApp, typeOf } from "@/lib/files";

type Params = { params: Promise<{ key: string[] }> };

/** An image's key, or with `docs` a doc's too; a doc is read only through its project's docs route. */
async function keyOf(p: Params, docs = false): Promise<string | null> {
  const key = (await p.params).key.join("/");
  return isDocKey(key) ? (docs ? key : null) : KEY_RE.test(key) ? key : null;
}

export async function GET(req: Request, p: Params) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const key = await keyOf(p);
  if (!key) return json({ error: "not found" }, 404);
  return fileResponse(key);
}

/** The app-side stand-in for S3's presigned POST: local files, or proxied S3. */
export async function POST(req: Request, p: Params) {
  if (!viaApp() || (process.env.VERCEL && !process.env.S3_BUCKET)) return json({ error: "upload to S3" }, 405);
  const a = await authed(req);
  if (a instanceof Response) return a;
  const key = await keyOf(p, true);
  if (!key) return json({ error: "bad key" }, 400);
  // A doc is any type: it is stored as the type its name gives, whatever the form says.
  const doc = isDocKey(key);
  if (doc && !(await pendingUpload(a.d, key))) return json({ error: "not an upload this server issued" }, 403);
  const file = (await req.formData()).get("file");
  if (!(file instanceof File)) return json({ error: "no file" }, 400);
  if (doc ? file.size > DOC_MAX_BYTES : file.size === 0 || file.size > MAX_BYTES) {
    return json({ error: doc ? "docs are limited to 25 MB" : "images are limited to 10 MB" }, 413);
  }
  if (!doc && file.type !== typeOf(key)) return json({ error: "type doesn't match the key" }, 415);
  if (await hasObject(key)) return json({ error: "already uploaded" }, 409);
  await putObject(key, new Uint8Array(await file.arrayBuffer()), doc ? docType(key) : file.type);
  return new Response(null, { status: 204 });
}
