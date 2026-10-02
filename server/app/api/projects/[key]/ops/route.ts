import { applyOps, ProjectNotFound, type Op } from "@/lib/apply";
import { authed, json, later } from "@/lib/http";
import { flushJira } from "@/lib/jira/flush";

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const body = await req.json().catch(() => null);
  const ops: Op[] = Array.isArray(body?.ops) ? body.ops : [];
  if (ops.some((o) => !o || typeof o.op_id !== "string" || typeof o.uid !== "string")) {
    return json({ error: "every op needs op_id and uid" }, 400);
  }
  try {
    const results = await applyOps(a.d, key, ops, { handle: a.user.handle });
    later(() => flushJira(a.d));
    return json({ results });
  } catch (e) {
    if (e instanceof ProjectNotFound) return json({ error: "no such project" }, 404);
    throw e;
  }
}
