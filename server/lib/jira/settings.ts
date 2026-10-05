// A project's Jira rules as the settings page reads and saves them.
import type { Db } from "../db";
import { STATUSES } from "../model";
import { JiraClient, type Fetch } from "./client";
import { jiraConfig, jiraReadOnly } from "./config";
import { inboundRules, outboundRules, validateRules, type InboundRules, type OutboundRules, type Problem } from "./rules";

export interface JiraSettings {
  jiraProject: string | null;
  jiraUrl: string | null;
  inbound: InboundRules;
  outbound: OutboundRules;
  serverReadOnly: boolean;
  /** Jira's statuses for the project, or null when Jira couldn't be asked. */
  jiraStatuses: string[] | null;
  savedBy: string | null;
  savedAt: string | null;
}

export interface DryRun { id: number; at: string; itemId: string | null; title: string | null; action: string; key: string; status?: string }

const EMPTY_OUTBOUND: OutboundRules = { writes: false, comments: true, never: [], triggers: [] };

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

export async function loadJiraSettings(db: Db, key: string, fetchImpl?: Fetch): Promise<JiraSettings | null> {
  const [p] = await db.query(
    "select jira_project, jira_inbound, jira_outbound, jira_settings_by, jira_settings_at from projects where key = $1", [key]);
  if (!p) return null;
  const cfg = jiraConfig();
  return {
    jiraProject: p.jira_project ?? null,
    jiraUrl: cfg && p.jira_project ? `${cfg.baseUrl}/browse/${p.jira_project}` : null,
    inbound: inboundRules(p.jira_inbound) ?? { statuses: {}, transitions: [] },
    outbound: outboundRules(p.jira_outbound) ?? EMPTY_OUTBOUND,
    serverReadOnly: jiraReadOnly(),
    jiraStatuses: p.jira_project ? await jiraStatuses(p.jira_project, fetchImpl) : null,
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

/** Validate and store both rule sets; errors store nothing. */
export async function saveJiraSettings(db: Db, key: string, by: string, inbound: InboundRules, outbound: OutboundRules,
                                       jiraStatusList?: string[] | null): Promise<Problem[]> {
  const clean: OutboundRules = {
    writes: !!outbound.writes, comments: outbound.comments !== false,
    never: (outbound.never ?? []).map((s) => s.trim()).filter(Boolean),
    triggers: (outbound.triggers ?? []).map((t) => ({ from: t.from, to: t.to, jira: String(t.jira ?? "").trim() })),
  };
  const statuses: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(inbound.statuses ?? {})) if (k.trim()) statuses[k.trim()] = v;
  const rules: InboundRules = { statuses, transitions: inbound.transitions ?? [] };
  const problems = validateRules(rules, clean, STATUSES, jiraStatusList);
  if (problems.some((p) => p.level === "error")) return problems;
  await db.query(
    `update projects set jira_inbound = $2::jsonb, jira_outbound = $3::jsonb, jira_settings_by = $4, jira_settings_at = now()
      where key = $1`, [key, JSON.stringify(rules), JSON.stringify(clean), by]);
  return problems;
}
