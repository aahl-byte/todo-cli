import { authed, json } from "@/lib/http";
import { markRead } from "@/lib/inbox";

export async function POST(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const body = await req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  return json({ read: await markRead(a.d, a.user.handle, ids) });
}
