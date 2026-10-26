// Replay a project's recent status moves and manual Action runs through the
// old Action and Jira-trigger code and through the plugin instances its port
// makes, both in dry-run, and print every difference in what they'd send.
import { db } from "../lib/db";
import { describeParity, parity } from "../lib/plugins/parity";
import { parseDuration } from "../lib/plugins/triggers";

const args = process.argv.slice(2);
const project = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--since");
const since = args.includes("--since") ? args[args.indexOf("--since") + 1] : "7d";
if (!project) {
  console.error("usage: npx tsx scripts/plugins-parity.ts <project> [--since 7d]");
  process.exit(2);
}
const d = await db();
const result = await parity(d, project, { since: new Date(Date.now() - parseDuration(since)) });
console.log(describeParity(result));
await d.close?.();
process.exit(result.diffs ? 1 : 0);
