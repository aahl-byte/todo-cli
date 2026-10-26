import { DocError, getDoc, removeDoc } from "@/lib/docs";
import { fileResponse } from "@/lib/files";
import { authed, json } from "@/lib/http";

type Ctx = { params: Promise<{ key: string; uid: string }> };

/** A doc's bytes, only through its own project; `?download=1` saves rather than shows. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key, uid } = await ctx.params;
  const doc = await getDoc(a.d, key, uid);
  if (!doc) return json({ error: "no such doc" }, 404);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const name = encodeURIComponent(doc.name);
  return fileResponse(doc.file_key, { type: doc.content_type, disposition: `${download ? "attachment" : "inline"}; filename*=UTF-8''${name}` });
}

/** Delete a doc unless it changed since `?base=<sha256>`. */
export async function DELETE(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key, uid } = await ctx.params;
  try {
    return json(await removeDoc(a.d, key, a.user.handle, uid, new URL(req.url).searchParams.get("base")));
  } catch (e) {
    if (e instanceof DocError) return json({ error: e.message }, e.status);
    throw e;
  }
}
