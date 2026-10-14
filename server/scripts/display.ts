import { addDisplay, removeDisplay } from "../lib/display";
import { db } from "../lib/db";

const [cmd, project, label] = process.argv.slice(2);
const d = await db();
if (cmd === "add" && project && label) {
  if (!(await d.query("select 1 from projects where key = $1", [project])).length) {
    console.error(`no project ${project}`);
    process.exit(1);
  }
  const token = await addDisplay(d, project, label);
  console.log(`${process.env.NEXT_BASE_PATH ?? ""}/display/${project}/enroll?key=${token}`);
} else if (cmd === "remove" && project && label) {
  if (!(await removeDisplay(d, project, label))) {
    console.error(`no display ${label} on ${project}`);
    process.exit(1);
  }
} else if (cmd === "list") {
  for (const r of await d.query("select project, label, created, last_seen from display_tokens order by project, label"))
    console.log(`${r.project}\t${r.label}\tlast seen ${r.last_seen ? new Date(r.last_seen).toISOString() : "never"}`);
} else {
  console.error("usage: npm run display -- add|remove <project> <label> | list");
  process.exit(2);
}
await d.close?.();
process.exit(0);
