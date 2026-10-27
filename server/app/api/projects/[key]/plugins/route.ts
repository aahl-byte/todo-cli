import { json } from "@/lib/http";
import { projectRepo } from "@/lib/plugins/route-helpers";
import { NoSecretKey } from "@/lib/plugins/secrets";
import { PluginConflict, PluginInputError, putGrants, putInstances, repoPlugins } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

/** One repo's plugins for the CLI and the dashboard: `?repo=owner/name`. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await projectRepo(req, ctx, new URL(req.url).searchParams.get("repo"));
  if (a instanceof Response) return a;
  return json(await repoPlugins(a.d, a.key, a.repo));
}

/** Replace one plugin's instances in a repo, or its grants: `{repo, plugin, instances?, grants?}`. */
export async function PUT(req: Request, ctx: Ctx) {
  const body = await req.clone().json().catch(() => null);
  const a = await projectRepo(req, ctx, body?.repo);
  if (a instanceof Response) return a;
  if (typeof body?.plugin !== "string" || !body.plugin) return json({ error: "plugin must be a plugin name" }, 400);
  if (body.instances === undefined && body.grants === undefined) return json({ error: "give instances or grants" }, 400);
  try {
    if (body.instances !== undefined) await putInstances(a.d, a.key, a.repo, body.plugin, body.instances, a.user.handle);
    if (body.grants !== undefined) await putGrants(a.d, a.key, a.repo, body.plugin, body.grants, a.user.handle);
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    if (e instanceof PluginConflict) return json({ error: e.message }, 409);
    if (e instanceof NoSecretKey) return json({ error: e.message }, 503);
    throw e;
  }
  return json({ ok: true });
}
