import type { Db } from "./db";
import { flushActions } from "./actions/runs";
import { sweepDocUploadsIfDue } from "./docs";
import { flushJira } from "./jira/flush";
import { flushPluginRuns } from "./plugins/server";

/** Deliver whatever the last writes queued: Jira calls, Actions and plugin runs; and, hourly, sweep stale doc uploads. */
export async function flushOutboxes(d: Db): Promise<void> {
  const sweep = sweepDocUploadsIfDue(d).catch((e) => { console.error("docs: upload sweep failed:", e); });
  const plugins = flushPluginRuns(d).catch((e) => { console.error("plugins: flush failed:", e); });
  await Promise.all([flushJira(d), flushActions(d), plugins, sweep]);
}
