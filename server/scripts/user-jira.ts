// Link an existing user to their Jira account without issuing a new token.
import { db } from "../lib/db";

const [handle, accountId] = process.argv.slice(2);
if (!handle || !accountId) {
  console.error("usage: npm run user:jira -- <handle> <jira accountId>");
  process.exit(2);
}
const d = await db();
const rows = await d.query("update users set jira_account_id = $2 where handle = $1 returning handle", [handle, accountId]);
console.log(rows.length ? `${handle} ↔ Jira ${accountId}` : `no user ${handle}`);
await d.close?.();
process.exit(rows.length ? 0 : 1);
