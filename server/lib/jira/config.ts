export interface JiraConfig {
  baseUrl: string;
  email: string;
  token: string;
  webhookSecret: string;
  /** The integration's own account, whose comments are never imported. */
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

export const MAX_ATTEMPTS = 5;
export const COMMENT_MARK = "(via todo)";
