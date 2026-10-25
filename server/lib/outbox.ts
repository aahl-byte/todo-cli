import type { Db } from "./db";
import { flushActions } from "./actions/runs";
import { sweepDocUploadsIfDue } from "./docs";
import { flushJira } from "./jira/flush";

/** Deliver whatever the last writes queued: Jira calls and Actions; and, hourly, sweep stale doc uploads. */
export async function flushOutboxes(d: Db): Promise<void> {
  const sweep = sweepDocUploadsIfDue(d).catch((e) => { console.error("docs: upload sweep failed:", e); });
  await Promise.all([flushJira(d), flushActions(d), sweep]);
}
