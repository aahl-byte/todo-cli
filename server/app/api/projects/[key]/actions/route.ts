import { projectActions } from "@/lib/actions/runs";
import { authed, json } from "@/lib/http";

export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select key from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  return json({ actions: await projectActions(a.d, key) });
}
