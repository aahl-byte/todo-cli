import { authed, json } from "@/lib/http";
import { backfillLinked } from "@/lib/jira/sync";

/** The CLI asks, right after pushing a link, for `{item_uid}`'s new tickets to reach its request now. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  const body = await req.json().catch(() => null);
  if (typeof body?.item_uid !== "string" || !body.item_uid) return json({ error: "item_uid is required" }, 400);
  try {
    return json(await backfillLinked(a.d, key, body.item_uid));
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}
