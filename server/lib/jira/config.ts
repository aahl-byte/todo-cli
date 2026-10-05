import type { Fetch } from "./client";

export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  /** Unset when only polling; the webhook route then refuses every call. */
  webhookSecret?: string;
  /** The integration's own account, whose changes are never imported. */
  accountId?: string;
}

export function jiraConfig(): JiraConfig | null {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_WEBHOOK_SECRET, JIRA_ACCOUNT_ID } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return null;
  return {
    baseUrl: JIRA_BASE_URL.replace(/\/+$/, ""),
    email: JIRA_EMAIL,
    token: JIRA_API_TOKEN,
    webhookSecret: JIRA_WEBHOOK_SECRET || undefined,
    accountId: JIRA_ACCOUNT_ID || undefined,
  };
}

/** Jira is mirrored but never written to: no outbox rows, no deliveries. */
export const jiraReadOnly = () => process.env.JIRA_READ_ONLY === "1";

let cachedAccount: string | null = null;
let failedAt = 0;
const RETRY_MS = 60_000;

/** The account our API token acts as: JIRA_ACCOUNT_ID, else asked of Jira
 * once. Null when unknown; a failed lookup is retried after a minute. */
export async function ownAccountId(cfg: JiraConfig, fetchImpl?: Fetch): Promise<string | null> {
  if (cfg.accountId) return cfg.accountId;
  if (cachedAccount) return cachedAccount;
  if (Date.now() - failedAt < RETRY_MS) return null;
  try {
    const { JiraClient } = await import("./client");
    const me = await new JiraClient(cfg, fetchImpl).call("GET", "/rest/api/3/myself");
    cachedAccount = me?.accountId ?? null;
  } catch {
    cachedAccount = null;
  }
  if (!cachedAccount) failedAt = Date.now();
  return cachedAccount;
}

export function resetAccountCache(): void {
  cachedAccount = null;
  failedAt = 0;
}

export const MAX_ATTEMPTS = 5;
/** A claimed row whose delivery hasn't finished is reclaimable after this. */
export const LEASE_MINUTES = 5;
export const COMMENT_MARK = "(via todo)";
