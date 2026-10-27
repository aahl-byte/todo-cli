import { json } from "@/lib/http";
import { scheduleRecompute } from "@/lib/gitfacts";
import { projectRepo } from "@/lib/plugins/route-helpers";
import { loadConfig, PluginInputError, putConnection, putTrack, setShipped } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

/** One repo's plugin config as stored: `?repo=owner/name`. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await projectRepo(req, ctx, new URL(req.url).searchParams.get("repo"));
  if (a instanceof Response) return a;
  return json(await loadConfig(a.d, a.key, a.repo));
}

/** Change one repo's plugin config: `{repo, track?, enable?, disable?, connection?: {name, def}}`, def null to drop it. */
export async function PUT(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  const changes = ["track", "enable", "disable", "connection"].filter((k) => body[k] !== undefined);
  if (!changes.length) return json({ error: "give track, enable, disable or connection" }, 400);
  if (body.connection !== undefined && body.connection?.def === undefined) return json({ error: "connection is {name, def}, def null to drop it" }, 400);
  try {
    if (body.track !== undefined) await putTrack(a.d, a.key, a.repo, body.track, a.user.handle);
    if (body.enable !== undefined) await setShipped(a.d, a.key, a.repo, body.enable, true, a.user.handle);
    if (body.disable !== undefined) await setShipped(a.d, a.key, a.repo, body.disable, false, a.user.handle);
    if (body.connection !== undefined) await putConnection(a.d, a.key, a.repo, body.connection?.name, body.connection.def, a.user.handle);
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message, errors: e.errors }, 400);
    throw e;
  }
  if (body.track !== undefined) void scheduleRecompute(a.d, a.key, fetch, a.repo);
  return json({ ok: true, config: await loadConfig(a.d, a.key, a.repo) });
}
