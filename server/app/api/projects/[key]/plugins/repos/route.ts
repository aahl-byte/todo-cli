import { authed, json } from "@/lib/http";
import { PluginInputError, projectRepos, putProjectRepos } from "@/lib/plugins/store";

type Ctx = { params: Promise<{ key: string }> };

async function project(req: Request, ctx: Ctx) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  return { ...a, key };
}

/** The repos a project may use: those listed, and those its members' CLIs reported checkouts of. */
export async function GET(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  return json(await projectRepos(a.d, a.key));
}

/** Replace the listed repos: `{repos: [owner/name, …]}`. */
export async function PUT(req: Request, ctx: Ctx) {
  const a = await project(req, ctx);
  if (a instanceof Response) return a;
  const body = await req.json().catch(() => null);
  try {
    await putProjectRepos(a.d, a.key, body?.repos, a.user.handle);
  } catch (e) {
    if (e instanceof PluginInputError) return json({ error: e.message }, 400);
    throw e;
  }
  return json({ ok: true, ...(await projectRepos(a.d, a.key)) });
}
