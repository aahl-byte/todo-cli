// Convert a project's Actions and Jira triggers into plugin instances: prints
// them, with the connections, secrets and allowed hosts they need; --write
// switches their plugins on and stores them in each repo the project's items use.
import { db } from "../lib/db";
import { describePlan, planPort, writePlan } from "../lib/plugins/port";

const args = process.argv.slice(2);
const project = args.find((a, i) => !a.startsWith("--") && !["--repo", "--by"].includes(args[i - 1]));
const repos = args.flatMap((a, i) => (args[i - 1] === "--repo" ? [a] : []));
const by = args.includes("--by") ? args[args.indexOf("--by") + 1] : "plugins-port";
if (!project) {
  console.error("usage: npx tsx scripts/plugins-port.ts <project> [--repo owner/name]... [--write [--by handle]]");
  process.exit(2);
}
const d = await db();
const plan = await planPort(d, project, { repos });
console.log(describePlan(plan));
let failed = false;
if (args.includes("--write")) {
  const problems = await writePlan(d, plan, by);
  for (const p of problems) console.error(`not written: ${p}`);
  failed = problems.length > 0;
  console.log(failed ? "written, except as above" : "written");
}
await d.close?.();
process.exit(failed ? 1 : 0);
