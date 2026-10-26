"use server";
import { revalidatePath } from "next/cache";
import { cleanAction, validateActions, type ActionDef } from "@/lib/actions/model";
import { db } from "@/lib/db";
import { jiraStatusesOf, linkedJiraProjects, saveJiraSettings } from "@/lib/jira/settings";
import type { OutboundRules, Problem } from "@/lib/jira/rules";
import { STATUSES } from "@/lib/model";
import { requireUser } from "@/lib/session";

export async function saveJiraSettingsAction(key: string, outbound: OutboundRules):
    Promise<{ ok: boolean; problems: Problem[] }> {
  const user = await requireUser();
  const d = await db();
  const jiraProjects = await linkedJiraProjects(d, key);
  if (!jiraProjects) return { ok: false, problems: [{ level: "error", message: "No such project." }] };
  const problems = await saveJiraSettings(d, key, user.handle, outbound, await jiraStatusesOf(jiraProjects));
  const ok = !problems.some((x) => x.level === "error");
  if (ok) revalidatePath(`/p/${key}/settings`);
  return { ok, problems };
}

export async function saveActionsAction(key: string, drafts: Partial<ActionDef>[]): Promise<{ ok: boolean; problems: Problem[] }> {
  const user = await requireUser();
  const actions = drafts.map(cleanAction);
  const problems = validateActions(actions, STATUSES);
  if (problems.some((x) => x.level === "error")) return { ok: false, problems };
  const d = await db();
  const done = await d.query("update projects set actions = $2::jsonb, actions_by = $3, actions_at = now() where key = $1 returning key",
    [key, JSON.stringify(actions), user.handle]);
  if (!done.length) return { ok: false, problems: [{ level: "error", message: "No such project." }] };
  revalidatePath(`/p/${key}`, "layout");
  return { ok: true, problems };
}
