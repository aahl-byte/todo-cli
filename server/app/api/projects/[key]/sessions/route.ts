import { boardSessions, itemSessions } from "@/lib/actions/sessions";
import { authed, json } from "@/lib/http";

/** Watchtower session states: one item's per Action and watchtower-session instance (?item=<uid>), or the board's working and waiting items. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const itemUid = new URL(req.url).searchParams.get("item");
  return json(itemUid ? { sessions: await itemSessions(a.d, key, itemUid) } : { items: await boardSessions(a.d, key) });
}
