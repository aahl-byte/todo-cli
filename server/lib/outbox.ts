import type { Db } from "./db";
import { flushActions } from "./actions/runs";
import { flushJira } from "./jira/flush";

/** Deliver whatever the last writes queued: Jira calls and Actions. */
export async function flushOutboxes(d: Db): Promise<void> {
  await Promise.all([flushJira(d), flushActions(d)]);
}
