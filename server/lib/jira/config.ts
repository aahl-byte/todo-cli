export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
}

export function jiraConfig(): JiraConfig | null {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return null;
  return {
    baseUrl: JIRA_BASE_URL.replace(/\/+$/, ""),
    email: JIRA_EMAIL,
    token: JIRA_API_TOKEN,
  };
}

/** Jira is mirrored but never written to: no outbox rows, no deliveries. */
export const jiraReadOnly = () => process.env.JIRA_READ_ONLY === "1";

export const MAX_ATTEMPTS = 5;
/** A claimed row whose delivery hasn't finished is reclaimable after this. */
export const LEASE_MINUTES = 5;
export const COMMENT_MARK = "(via todo)";
