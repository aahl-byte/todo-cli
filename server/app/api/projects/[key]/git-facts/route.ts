import { BadFacts, recordFacts } from "@/lib/gitfacts";
import { authed, json } from "@/lib/http";

/** The CLI posts the git facts it computed from its checkout: `{facts: [{item_uid, data}]}`. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  const body = await req.json().catch(() => null);
  if (!Array.isArray(body?.facts)) return json({ error: "facts must be a list" }, 400);
  try {
    return json({ ok: true, ...(await recordFacts(a.d, key, a.user.handle, body.facts)) });
  } catch (e) {
    if (e instanceof BadFacts) return json({ error: e.message }, 400);
    throw e;
  }
}
