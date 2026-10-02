import type { Db } from "../db";
import type { Actor } from "../apply";

export type JiraEvent =
  | { kind: "status"; itemUid: string; status: string }
  | { kind: "note"; itemUid: string; note: Record<string, any> };

/** Queue the Jira side of a todo change. Filled in by the bridge (phase 3). */
export async function queueJira(_t: Db, _actor: Actor, _event: JiraEvent): Promise<void> {}
