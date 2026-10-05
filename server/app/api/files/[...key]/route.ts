import { authed, json } from "@/lib/http";
import { getObject, hasObject, KEY_RE, MAX_BYTES, putObject, readUrl, viaApp, typeOf } from "@/lib/files";

type Params = { params: Promise<{ key: string[] }> };

async function keyOf(p: Params): Promise<string | null> {
  const key = (await p.params).key.join("/");
  return KEY_RE.test(key) ? key : null;
}

export async function GET(req: Request, p: Params) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const key = await keyOf(p);
  if (!key) return json({ error: "not found" }, 404);
  if (!viaApp()) return new Response(null, { status: 302, headers: { location: await readUrl(key), "cache-control": "private, max-age=240" } });
  const bytes = await getObject(key);
  if (!bytes) return json({ error: "not found" }, 404);
  return new Response(new Uint8Array(bytes), { headers: {
    "content-type": typeOf(key), "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400",
    "content-security-policy": "default-src 'none'",
  } });
}

/** The app-side stand-in for S3's presigned POST: local files, or proxied S3. */
export async function POST(req: Request, p: Params) {
  if (!viaApp() || (process.env.VERCEL && !process.env.S3_BUCKET)) return json({ error: "upload to S3" }, 405);
  const a = await authed(req);
  if (a instanceof Response) return a;
  const key = await keyOf(p);
  if (!key) return json({ error: "bad key" }, 400);
  const file = (await req.formData()).get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_BYTES) return json({ error: "images are limited to 10 MB" }, 413);
  if (file.type !== typeOf(key)) return json({ error: "type doesn't match the key" }, 415);
  if (await hasObject(key)) return json({ error: "already uploaded" }, 409);
  await putObject(key, new Uint8Array(await file.arrayBuffer()), file.type);
  return new Response(null, { status: 204 });
}
