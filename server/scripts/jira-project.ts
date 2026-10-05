import { addProject } from "../lib/auth";
import { db } from "../lib/db";

const [key, jiraProject, map, name, inbound] = process.argv.slice(2);
if (!key || !jiraProject || !map) {
  console.error(`usage: npm run jira:project -- <key> <JIRA_KEY> '{"<todo status>": "<Jira status>", ...}' [name] ['<inbound rules json>']`);
  process.exit(2);
}
const d = await db();
await addProject(d, key, name);
await d.query("update projects set jira_project = $2, jira_status_map = $3::jsonb, jira_inbound = $4::jsonb where key = $1",
  [key, jiraProject, JSON.stringify(JSON.parse(map)), inbound ? JSON.stringify(JSON.parse(inbound)) : null]);
console.log(`project ${key} mirrors Jira ${jiraProject}`);
await d.close?.();
process.exit(0);
