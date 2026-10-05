"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { jiraStatuses, saveJiraSettings } from "@/lib/jira/settings";
import type { InboundRules, OutboundRules, Problem } from "@/lib/jira/rules";
import { requireUser } from "@/lib/session";

export async function saveJiraSettingsAction(key: string, inbound: InboundRules, outbound: OutboundRules):
    Promise<{ ok: boolean; problems: Problem[] }> {
  const user = await requireUser();
  const d = await db();
  const [p] = await d.query("select jira_project from projects where key = $1", [key]);
  if (!p?.jira_project) return { ok: false, problems: [{ level: "error", message: "This project isn't linked to Jira." }] };
  const problems = await saveJiraSettings(d, key, user.handle, inbound, outbound, await jiraStatuses(p.jira_project));
  const ok = !problems.some((x) => x.level === "error");
  if (ok) revalidatePath(`/p/${key}/settings`);
  return { ok, problems };
}
