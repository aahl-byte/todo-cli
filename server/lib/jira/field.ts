// An item's `extra.jira` list of issue keys, kept in step with its 'field'
// rows in jira_links. Mirrors JIRA_KEY in todo/store.py.
import type { Db } from "../db";

export const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** Whether `value` is a valid `extra.jira`: a list of distinct issue keys. */
export function validJiraKeys(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((k) => typeof k === "string" && JIRA_KEY.test(k))
    && new Set(value).size === value.length;
}

/** Make the item's 'field' links match `keys`. A key the bridge already
 * linked by import keeps that link. */
export async function syncFieldLinks(t: Db, project: string, itemUid: string, keys: string[]): Promise<void> {
  await t.query(
    `delete from jira_links where project = $1 and item_uid = $2 and source = 'field' and not (jira_key = any($3::text[]))`,
    [project, itemUid, keys]);
  for (const key of keys) {
    await t.query(
      `insert into jira_links (project, item_uid, jira_key, source) values ($1, $2, $3, 'field') on conflict do nothing`,
      [project, itemUid, key]);
  }
}
