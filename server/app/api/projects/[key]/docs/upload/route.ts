import { docNameError } from "@/lib/docs";
import { DOC_MAX_BYTES, docType, filesEnabled, newDocKey, uploadTarget } from "@/lib/files";
import { authed, json } from "@/lib/http";

/** Where to send a doc's bytes: `{item_uid, name, size}` → `{key, url, fields, content_type}`.
 * The bucket's presigned form when S3 is direct, else the app's files route. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key: project } = await ctx.params;
  if (!filesEnabled()) return json({ error: "docs need S3 (set S3_BUCKET)" }, 501);
  const body = await req.json().catch(() => ({}));
  const bad = docNameError(body.name);
  if (bad) return json({ error: bad }, 422);
  const size = Number(body.size);
  if (!Number.isInteger(size) || size < 0 || size > DOC_MAX_BYTES) return json({ error: "docs are limited to 25 MB" }, 413);
  const [p] = await a.d.query("select 1 from projects where key = $1", [project]);
  if (!p) return json({ error: "no such project" }, 404);
  const [item] = await a.d.query("select 1 from items where project = $1 and uid = $2", [project, String(body.item_uid ?? "")]);
  if (!item) return json({ error: "no such item" }, 422);
  const fileKey = newDocKey(project, body.name);
  const contentType = docType(body.name);
  return json({ key: fileKey, content_type: contentType, ...(await uploadTarget(fileKey, contentType)) });
}
