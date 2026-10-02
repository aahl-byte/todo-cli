import { changesSince } from "@/lib/changes";
import { authed, json } from "@/lib/http";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 500) || 500, 1), 2000);
  const [p] = await a.d.query("select key, deploy_step from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  return json({ ...(await changesSince(a.d, key, since, limit)), deploy_step: p.deploy_step });
}
