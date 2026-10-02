import { addUser } from "../lib/auth";
import { db } from "../lib/db";

const [handle, ...rest] = process.argv.slice(2);
if (!handle) {
  console.error("usage: npm run user:add -- <handle> [--name NAME] [--jira ACCOUNT_ID]");
  process.exit(2);
}
const opt = (flag: string) => {
  const i = rest.indexOf(flag);
  return i >= 0 ? rest[i + 1] : undefined;
};
const d = await db();
const token = await addUser(d, handle, opt("--name"));
const jira = opt("--jira");
if (jira) await d.query("update users set jira_account_id = $2 where handle = $1", [handle, jira]);
console.log(`${handle}: ${token}`);
await (await db()).close?.();
process.exit(0);
