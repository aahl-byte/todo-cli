import { authed, json } from "@/lib/http";
import { inbox } from "@/lib/inbox";

export async function GET(req: Request) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const url = new URL(req.url);
  return json(await inbox(a.d, a.user.handle, {
    all: url.searchParams.get("all") === "1",
    since: Number(url.searchParams.get("since") ?? 0) || 0,
  }));
}
