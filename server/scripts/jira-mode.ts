import { db } from "../lib/db";
import { JIRA_MODES } from "../lib/jira/sync";

const [key, mode] = process.argv.slice(2);
if (!key || !JIRA_MODES.includes(mode)) {
  console.error(`usage: npm run jira:mode -- <project> ${JIRA_MODES.join("|")}`);
  process.exit(2);
}
const d = await db();
const rows = await d.query("update projects set jira_mode = $2 where key = $1 returning key", [key, mode]);
if (!rows.length) {
  console.error(`no project ${key}; create it with npm run project:add`);
  process.exit(1);
}
console.log(`project ${key} is in Jira ${mode} mode`);
await d.close?.();
process.exit(0);
