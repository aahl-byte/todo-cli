import { json } from "@/lib/http";
import { vercelChoices } from "@/lib/plugins/vercel";
import { projectRepo } from "@/lib/plugins/route-helpers";

/** The Vercel teams the project's vercel connection can see, and with `team`, that team's projects:
 * `?repo=owner/name&team=<id>`, for picking vercel-preview's settings. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const url = new URL(req.url);
  const a = await projectRepo(req, ctx, url.searchParams.get("repo"));
  if (a instanceof Response) return a;
  return json(await vercelChoices(a.d, a.key, a.repo, url.searchParams.get("team")));
}
