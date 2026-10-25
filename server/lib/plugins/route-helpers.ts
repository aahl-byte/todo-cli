// Shared by the plugin API routes: the project and repo a request names, checked.
import { repoAllowed, repoKey } from "@/lib/checkouts";
import { authed, json } from "@/lib/http";

/** The caller, the project, and the repo named (owner/name) if the project may use it; otherwise the response to send. */
export async function projectRepo(req: Request, ctx: { params: Promise<{ key: string }> }, raw: unknown) {
  const a = await authed(req);
  if (a instanceof Response) return a;
  const { key } = await ctx.params;
  const [p] = await a.d.query("select 1 from projects where key = $1", [key]);
  if (!p) return json({ error: "no such project" }, 404);
  const repo = typeof raw === "string" ? repoKey(raw) : "";
  if (!repo) return json({ error: "repo must be a GitHub owner/name" }, 400);
  if (!(await repoAllowed(a.d, key, repo))) return json({ error: `${repo} isn't one of this project's repos` }, 404);
  return { ...a, key, repo };
}

