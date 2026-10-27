// The Jira bridge and the Jira plugins never both act on a project: while the
// bridge sends its triggers' moves, jira-transition can't send in any of the
// project's repos, and while it polls linked tickets, jira-issue can't mirror
// them. Every write that could break that takes the project's lock and checks.
import type { Db } from "../db";
import { outboundRules } from "../jira/rules";
import { allInstances } from "./host";
import { SHIPPED } from "./shipped";
import { PluginInputError } from "./errors";
import type { InstanceDef } from "./types";

export const JIRA_TRANSITION = "jira-transition";
export const JIRA_ISSUE = "jira-issue";

/** A change that would let the bridge and a plugin both act; the API answers 400 with what to do instead. */
export class HandoverConflict extends PluginInputError {}

/** Holds the project's row for the rest of the transaction, so its checks and writes see one state. */
export async function lockProject(t: Pick<Db, "query">, project: string): Promise<void> {
  await t.query("select 1 from projects where key = $1 for update", [project]);
}

const acts = (i: InstanceDef) => i.enabled !== false && !i.dry_run;

/** The repos where a shipped plugin is switched on with an instance that would act: switched on itself and not in test mode. */
export async function liveRepos(t: Pick<Db, "query">, project: string, plugin: string): Promise<string[]> {
  const on = await t.query("select repo from plugin_configs where project = $1 and $2 = any(shipped) order by repo", [project, plugin]);
  const out: string[] = [];
  for (const { repo } of on) {
    const rows = await t.query("select def from plugin_instances where project = $1 and repo = $2 and plugin = $3", [project, repo, plugin]);
    if (allInstances(SHIPPED[plugin].def, rows.map((r) => r.def as InstanceDef)).some(acts)) out.push(repo);
  }
  return out;
}

export interface BridgeState {
  /** It sends its triggers' moves to Jira: writes on, with a trigger. */
  sends: boolean;
  /** It mirrors the project's linked tickets: its poller hasn't been stopped here, and has polled the project. */
  polls: boolean;
}

export async function bridgeState(t: Pick<Db, "query">, project: string): Promise<BridgeState> {
  const [p] = await t.query("select jira_outbound, jira_poll, jira_synced_at from projects where key = $1", [project]);
  const rules = outboundRules(p?.jira_outbound);
  return { sends: !!rules?.writes && rules.triggers.length > 0, polls: p?.jira_poll !== false && !!p?.jira_synced_at };
}

const listed = (repos: string[]) => repos.join(", ");

/** Refuse the transaction's writes if they leave the bridge and a Jira plugin both acting; with `plugin`, only the pair that plugin
 * belongs to, and nothing for any other plugin. A project the bridge has never polled stops being polled once jira-issue mirrors
 * it. The caller holds the project's lock. */
export async function settleJira(t: Pick<Db, "query">, project: string, plugin?: string): Promise<void> {
  if (plugin !== undefined && plugin !== JIRA_TRANSITION && plugin !== JIRA_ISSUE) return;
  const bridge = await bridgeState(t, project);
  if (bridge.sends && plugin !== JIRA_ISSUE) {
    const live = await liveRepos(t, project, JIRA_TRANSITION);
    if (live.length) {
      throw new HandoverConflict(`the Jira bridge moves this project's tickets, so jira-transition can't send too (in ${listed(live)}); `
        + "move the bridge's triggers here, or keep it in test mode");
    }
  }
  if (plugin === JIRA_TRANSITION) return;
  const mirrored = await liveRepos(t, project, JIRA_ISSUE);
  if (!mirrored.length) return;
  if (bridge.polls) {
    throw new HandoverConflict(`the Jira bridge mirrors this project's linked tickets, so jira-issue can't too (in ${listed(mirrored)}); `
      + "move the bridge's polling here instead");
  }
  await t.query("update projects set jira_poll = false where key = $1 and jira_poll", [project]);
}

/** Plugins the server holds in test mode for a project while the bridge does their job, each with why. */
export async function heldPlugins(t: Pick<Db, "query">, project: string): Promise<Record<string, string>> {
  const bridge = await bridgeState(t, project);
  return {
    ...(bridge.sends ? { [JIRA_TRANSITION]: "the Jira bridge sends this project's Jira moves, so this run only records what it would do" } : {}),
    ...(bridge.polls ? { [JIRA_ISSUE]: "the Jira bridge mirrors this project's linked tickets, so this run attaches nothing" } : {}),
  };
}
