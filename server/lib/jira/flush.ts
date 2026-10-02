import type { Db } from "../db";

/** Deliver queued Jira calls. Filled in by the bridge (phase 3). */
export async function flushJira(_db: Db): Promise<void> {}
