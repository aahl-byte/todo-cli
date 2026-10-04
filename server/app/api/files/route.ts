import { authed, json } from "@/lib/http";
import { filesEnabled, MAX_BYTES, newKey, uploadTarget } from "@/lib/files";

// Asks where to upload one image: `{project, scope, type, size}` → `{key, url, fields}`.
export async function POST(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  if (!filesEnabled()) return json({ error: "uploads need S3 (set S3_BUCKET)" }, 501);
  const body = await req.json().catch(() => ({}));
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) return json({ error: "images are limited to 10 MB" }, 413);
  const key = newKey(String(body.project ?? ""), String(body.scope ?? "new"), String(body.type ?? ""));
  if (!key) return json({ error: "only png, jpeg, gif and webp images" }, 415);
  return json({ key, ...(await uploadTarget(key, String(body.type))) });
}
