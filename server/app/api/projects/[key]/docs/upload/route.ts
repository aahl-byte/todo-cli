import { DocError, issueUpload } from "@/lib/docs";
import { docType, filesEnabled, uploadTarget } from "@/lib/files";
import { authed, json } from "@/lib/http";

/** Where to send a doc's bytes: `{item_uid, name, size}` → `{key, url, fields, content_type}`.
 * The bucket's presigned form when S3 is direct, else the app's files route. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key: project } = await ctx.params;
  if (!filesEnabled()) return json({ error: "docs need S3 (set S3_BUCKET)" }, 501);
  const body = await req.json().catch(() => ({}));
  try {
    const fileKey = await issueUpload(a.d, project, String(body.item_uid ?? ""), body.name, body.size);
    const contentType = docType(body.name);
    return json({ key: fileKey, content_type: contentType, ...(await uploadTarget(fileKey, contentType)) });
  } catch (e) {
    if (e instanceof DocError) return json({ error: e.message }, e.status);
    throw e;
  }
}
