import { DocError, docPage, recordDoc } from "@/lib/docs";
import { authed, json } from "@/lib/http";

type Ctx = { params: Promise<{ key: string }> };

/** A page of the project's docs, or with `?item=<uid>` one item's: `{docs, next}`;
 * pass `next` back as `?after=` for the page after. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const q = new URL(req.url).searchParams;
  return json(await docPage(a.d, key, { item: q.get("item"), after: q.get("after"), limit: Number(q.get("limit")) || undefined }));
}

/** Record an uploaded file as a doc: `{item_uid, name, file_key, sha256, base, via}` →
 * `{status: applied | conflict, doc}`, where `doc` is the server's current copy. */
export async function PUT(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "a doc record is a JSON object" }, 400);
  try {
    return json(await recordDoc(a.d, key, a.user.handle, {
      item_uid: String(body.item_uid ?? ""), name: body.name, file_key: body.file_key,
      base: typeof body.base === "string" ? body.base : null,
      sha256: typeof body.sha256 === "string" ? body.sha256 : undefined, via: body.via,
    }));
  } catch (e) {
    if (e instanceof DocError) return json({ error: e.message }, e.status);
    throw e;
  }
}
