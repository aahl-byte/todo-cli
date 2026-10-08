import { flushActions, projectActions, queueManualAction, runState } from "@/lib/actions/runs";
import { authed, json } from "@/lib/http";

/** Run a server Action on an item now; answers with how the first attempt went. */
export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const body = await req.json().catch(() => null);
  const action = (await projectActions(a.d, key)).find((x) => x.id === body?.action);
  if (!action) return json({ error: `no action ${body?.action ?? ""} in ${key}` }, 404);
  if (action.runner !== "server") return json({ error: `${action.id} runs from the CLI` }, 400);
  const [item] = await a.d.query("select uid from items where project = $1 and (uid = $2 or id = $2)", [key, String(body?.item ?? "")]);
  if (!item) return json({ error: "no such item" }, 404);
  const id = await queueManualAction(a.d, key, item.uid, action, a.user.handle);
  await flushActions(a.d);
  return json(await runState(a.d, id!));
}
