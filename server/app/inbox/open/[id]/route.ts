import { bearer, userForToken } from "@/lib/auth";
import { db } from "@/lib/db";
import { markRead } from "@/lib/inbox";

// Open a notification: mark it read and go to the note or item it points at.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const d = await db();
  const user = await userForToken(d, bearer(req));
  if (!user) return go("/login");
  const id = Number((await ctx.params).id);
  const [n] = await d.query(
    `select n.project, i.id as item_id, nt.n as note_n from notifications n
       join items i on i.uid = n.item_uid and i.project = n.project
       left join notes nt on nt.uid = n.note_uid and nt.project = n.project
      where n.id = $1 and n.handle = $2`, [id, user.handle]);
  if (!n) return go("/inbox");
  await markRead(d, user.handle, [id]);
  return go(`/p/${n.project}/i/${n.item_id}${n.note_n ? `#n-${n.note_n}` : ""}`);
}

// A relative Location: req.url carries the server's own host (localhost behind
// a proxy), which would send the browser somewhere else.
function go(path: string): Response {
  return new Response(null, { status: 307, headers: { location: path } });
}
