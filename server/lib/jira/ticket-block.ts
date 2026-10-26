// The block a linked Jira issue adds to an item's request: a heading naming
// and linking it, then its description, between separators. Shared by links
// mode and the jira-issue plugin, which bundles it.

const SEPARATOR = "---";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` already holds the block for `key`. */
export function hasTicketBlock(text: string, key: string): boolean {
  const k = escapeRe(key);
  return new RegExp(`^## (?:\\[${k}\\]\\([^)]*\\)|${k}) · `, "m").test(text);
}

/** An issue's block: a heading naming and linking it, then its description. */
export function ticketBlock(key: string, summary: string, description: string, jiraBase?: string): string {
  const name = jiraBase ? `[${key}](${jiraBase}/browse/${key})` : key;
  return [`## ${name} · ${summary}`, description].filter(Boolean).join("\n\n");
}

/** `text` with `block` appended between separators. */
export function appendTicketBlock(text: string, block: string): string {
  const body = text.trimEnd();
  const lead = !body ? `${SEPARATOR}\n\n` : body.endsWith(`\n${SEPARATOR}`) || body === SEPARATOR ? `${body}\n\n` : `${body}\n\n${SEPARATOR}\n\n`;
  return `${lead}${block}\n\n${SEPARATOR}`;
}

