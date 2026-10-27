import { json } from "@/lib/http";
import { jiraChoices } from "@/lib/plugins/jira-statuses";
import { projectRepo } from "@/lib/plugins/route-helpers";

/** The Jira statuses the project's jira connection lists, for jira-transition's pickers: `?repo=owner/name`. */
export async function GET(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const a = await projectRepo(req, ctx, new URL(req.url).searchParams.get("repo"));
  if (a instanceof Response) return a;
  return json(await jiraChoices(a.d, a.key, a.repo));
}
