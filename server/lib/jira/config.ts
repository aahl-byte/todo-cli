import type { Fetch } from "./client";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  webhookSecret: string;
  /** The integration's own account, whose changes are never imported. */
  accountId?: string;
}

export function jiraConfig(): JiraConfig | null {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_WEBHOOK_SECRET, JIRA_ACCOUNT_ID } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN || !JIRA_WEBHOOK_SECRET) return null;
  return {
    baseUrl: JIRA_BASE_URL.replace(/\/+$/, ""),
    email: JIRA_EMAIL,
    token: JIRA_API_TOKEN,
    webhookSecret: JIRA_WEBHOOK_SECRET,
    accountId: JIRA_ACCOUNT_ID || undefined,
  };
}

let cachedAccount: string | null = null;

/** The account our API token acts as: JIRA_ACCOUNT_ID, else asked of Jira once. */
export async function ownAccountId(cfg: JiraConfig, fetchImpl?: Fetch): Promise<string | null> {
  if (cfg.accountId) return cfg.accountId;
  if (cachedAccount) return cachedAccount;
  try {
    const { JiraClient } = await import("./client");
    const me = await new JiraClient(cfg, fetchImpl).call("GET", "/rest/api/3/myself");
    cachedAccount = me?.accountId ?? null;
  } catch {
    return null;
  }
  return cachedAccount;
}

export function resetAccountCache(): void {
  cachedAccount = null;
}

export const MAX_ATTEMPTS = 5;
/** A claimed row whose delivery hasn't finished is reclaimable after this. */
export const LEASE_MINUTES = 5;
export const COMMENT_MARK = "(via todo)";
