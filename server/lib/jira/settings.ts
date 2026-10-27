// A project's Jira rules as the settings page reads and saves them.
import type { Db } from "../db";
import { STATUSES } from "../model";
import { JiraClient, type Fetch } from "./client";
import { jiraConfig, jiraReadOnly } from "./config";
import { outboundRules, validateRules, type OutboundRules, type Problem } from "./rules";
import { JIRA_TRANSITION, liveRepos, lockProject } from "../plugins/exclusive";

export interface JiraSettings {
  /** The Jira projects whose statuses the rules pick from. */
  jiraProjects: string[];
  outbound: OutboundRules;
  serverReadOnly: boolean;
  /** Jira's statuses for the project, or null when Jira couldn't be asked. */
  jiraStatuses: string[] | null;
  savedBy: string | null;
  savedAt: string | null;
}

export interface DryRun { id: number; at: string; itemId: string | null; title: string | null; action: string; key: string; status?: string }

const EMPTY_OUTBOUND: OutboundRules = { writes: false, never: [], triggers: [] };

export async function jiraStatuses(jiraProject: string, fetchImpl?: Fetch): Promise<string[] | null> {
  const cfg = jiraConfig();
  if (!cfg) return null;
  try {
    const types = await new JiraClient(cfg, fetchImpl).call("GET", `/rest/api/3/project/${encodeURIComponent(jiraProject)}/statuses`);
    const names = new Set<string>();
    for (const t of Array.isArray(types) ? types : []) for (const s of t?.statuses ?? []) if (s?.name) names.add(String(s.name));
    return [...names].sort();
  } catch {
    return null;
  }
}

/** Every status of these Jira projects, or null when Jira couldn't be asked. */
export async function jiraStatusesOf(jiraProjects: string[], fetchImpl?: Fetch): Promise<string[] | null> {
  if (!jiraProjects.length) return null;
  const lists = await Promise.all(jiraProjects.map((j) => jiraStatuses(j, fetchImpl)));
  if (lists.some((l) => !l)) return null;
  return [...new Set(lists.flat() as string[])].sort();
}

/** The Jira projects a project's items link, or null when there's no such project. */
export async function linkedJiraProjects(db: Db, key: string): Promise<string[] | null> {
  const [p] = await db.query("select 1 from projects where key = $1", [key]);
  if (!p) return null;
  const linked = await db.query(
    `select distinct split_part(jira_key, '-', 1) as j from jira_links where project = $1 and source = 'field' order by 1`, [key]);
  return linked.map((r) => r.j);
}

export async function loadJiraSettings(db: Db, key: string, fetchImpl?: Fetch): Promise<JiraSettings | null> {
  const [p] = await db.query("select jira_outbound, jira_settings_by, jira_settings_at from projects where key = $1", [key]);
  if (!p) return null;
  const jiraProjects = (await linkedJiraProjects(db, key))!;
  return {
    jiraProjects,
    outbound: outboundRules(p.jira_outbound) ?? EMPTY_OUTBOUND,
    serverReadOnly: jiraReadOnly(),
    jiraStatuses: await jiraStatusesOf(jiraProjects, fetchImpl),
    savedBy: p.jira_settings_by ?? null,
    savedAt: p.jira_settings_at ? new Date(p.jira_settings_at).toISOString() : null,
  };
}

export async function dryRuns(db: Db, key: string, limit = 20): Promise<DryRun[]> {
  const rows = await db.query(
    `select o.id, o.created, o.action, o.payload, i.id as item_id, i.title from jira_outbox o
       left join items i on i.project = o.project and i.uid = o.item_uid
      where o.project = $1 and coalesce((o.result->>'dry_run')::boolean, false)
      order by o.id desc limit $2`, [key, limit]);
  return rows.map((r) => ({ id: Number(r.id), at: new Date(r.created).toISOString(), itemId: r.item_id ?? null, title: r.title ?? null,
                            action: r.action, key: r.payload?.key, status: r.payload?.status }));
}

/** Validate and store the triggers; errors store nothing. */
export async function saveJiraSettings(db: Db, key: string, by: string, outbound: OutboundRules,
                                       jiraStatusList?: string[] | null): Promise<Problem[]> {
  const clean: OutboundRules = {
    writes: !!outbound.writes,
    never: (outbound.never ?? []).map((s) => s.trim()).filter(Boolean),
    triggers: (outbound.triggers ?? []).map((t) => ({ from: t.from, to: t.to, jira: String(t.jira ?? "").trim() })),
  };
  const problems = validateRules(clean, STATUSES, jiraStatusList);
  if (problems.some((p) => p.level === "error")) return problems;
  return db.tx(async (t) => {
    await lockProject(t, key);
    const live = clean.writes && clean.triggers.length ? await liveRepos(t, key, JIRA_TRANSITION) : [];
    if (live.length) {
      return [{ level: "error" as const, message: `jira-transition moves this project's tickets in ${live.join(", ")}, so the bridge can't send too. `
        + "Move its triggers back here from Settings → Automation, or keep sending off." }];
    }
    await t.query(
      "update projects set jira_outbound = $2::jsonb, jira_settings_by = $3, jira_settings_at = now() where key = $1",
      [key, JSON.stringify(clean), by]);
    return problems;
  });
}
