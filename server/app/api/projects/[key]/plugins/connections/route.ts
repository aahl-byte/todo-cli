import { scheduleRecompute } from "@/lib/gitfacts";
import { GITHUB } from "@/lib/github-token";
import { authed, json } from "@/lib/http";
import { NoSecretKey } from "@/lib/plugins/secrets";
import { PluginConflict, PluginInputError, PrivateAddress, projectConnections, putProjectConnection } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

async function project(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  return { ...a, key };
}

/** The project's own connections, which plugins that ship with todo use in every repo of it; never a secret. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  return json({ connections: await projectConnections(a.d, a.key) });
}

/** Add, change or remove one of the project's own connections: `{name, def?, secret?, base, allowPrivate?}`, `def: null` to remove
 * it, `base` the version the change was made on (null for a new one). A stale base answers 409; a private address nobody allowed
 * answers 400 with `private: true`. */
export async function PUT(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  const body = await req.json().catch(() => null);
  try {
    await putProjectConnection(a.d, a.key, body, a.user.handle);
  } catch (e) {
    if (e instanceof PrivateAddress) return json({ error: e.message, private: true }, 400);
    if (e instanceof PluginInputError) return json({ error: e.message, errors: e.errors }, 400);
    if (e instanceof PluginConflict) return json({ error: e.message }, 409);
    if (e instanceof NoSecretKey) return json({ error: e.message }, 503);
    throw e;
  }
  if (body?.name === GITHUB) void scheduleRecompute(a.d, a.key);
  return json({ ok: true, connections: await projectConnections(a.d, a.key) });
}
