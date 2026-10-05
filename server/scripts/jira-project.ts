import { addProject } from "../lib/auth";
import { db } from "../lib/db";

const [key, jiraProject, map, name, inbound, outbound] = process.argv.slice(2);
if (!key || !jiraProject || !map) {
  console.error(`usage: npm run jira:project -- <key> <JIRA_KEY> '{"<todo status>": "<Jira status>", ...}' [name] ['<inbound rules json>'] ['<outbound rules json>']`);
  process.exit(2);
}
const d = await db();
await addProject(d, key, name);
const json = (s?: string) => (s ? JSON.stringify(JSON.parse(s)) : null);
await d.query("update projects set jira_project = $2, jira_status_map = $3::jsonb, jira_inbound = $4::jsonb, jira_outbound = $5::jsonb where key = $1",
  [key, jiraProject, json(map), json(inbound), json(outbound)]);
console.log(`project ${key} mirrors Jira ${jiraProject}`);
await d.close?.();
process.exit(0);
