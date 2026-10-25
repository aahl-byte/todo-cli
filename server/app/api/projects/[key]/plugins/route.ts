import { repoKey } from "@/lib/checkouts";
import { authed, json } from "@/lib/http";
import { PluginInputError, putGrants, putInstances, repoPlugins } from "@/lib/plugins/server";

type Ctx = { params: Promise<{ key: string }> };

async function project(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  return { ...a, key };
}

/** One repo's plugins for the CLI and the dashboard: `?repo=owner/name`. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  const repo = repoKey(new URL(req.url).searchParams.get("repo"));
  if (!repo) return json({ error: "repo must be owner/name" }, 400);
  return json(await repoPlugins(a.d, a.key, repo));
}

/** Replace one plugin's instances in a repo, or its grants: `{repo, plugin, instances?, grants?}`. */
export async function PUT(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  const body = await req.json().catch(() => null);
  const repo = repoKey(typeof body?.repo === "string" ? body.repo : "");
  if (!repo) return json({ error: "repo must be owner/name" }, 400);
  if (typeof body?.plugin !== "string" || !body.plugin) return json({ error: "plugin must be a plugin name" }, 400);
  if (body.instances === undefined && body.grants === undefined) return json({ error: "give instances or grants" }, 400);
  try {
    if (body.instances !== undefined) await putInstances(a.d, a.key, repo, body.plugin, body.instances, a.user.handle);
    if (body.grants !== undefined) await putGrants(a.d, a.key, repo, body.plugin, body.grants, a.user.handle);
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true });
}
