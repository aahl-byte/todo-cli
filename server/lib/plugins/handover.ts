// Moving a job from the Jira bridge or the General tab's Actions into the
// plugin that replaces it, and back. Each move is one transaction under the
// project's lock: the plugin takes the job in every repo the project runs
// plugins for as the old code stops doing it, so the two never both act. A
// move's plan says in words what it will do; the page shows it, then sends the
// plan's base back, and the move is refused once that has changed.
import type { Db } from "../db";
import { STATUSES } from "../model";
import { ruleInstances, rulesOf } from "../jira/plugin-rules";
import { outboundRules, validateRules } from "../jira/rules";
import { bridgeState, JIRA_ISSUE, JIRA_TRANSITION, lockProject, settleJira } from "./exclusive";
import { PluginConflict, PluginInputError } from "./errors";
import { actionInstanceId, credentialSecret, planPort, pluginRepos, REST, WATCHTOWER } from "./port";
import { secretKeyProblem } from "./secrets";
import { hostSet, putGrants, putInstances, putProjectConnection, setShipped, storedGrants, storedInstances } from "./store";
import { storedActions, type ActionDef } from "../actions/model";
import type { AddressGuard } from "./connections";
import { POST_REQUEST, type InstanceDef } from "./types";

export const MOVES = ["jira-triggers", "jira-polling", "watchtower", "rest"] as const;
export type Move = (typeof MOVES)[number];
export type Direction = "here" | "back";

export interface MovePlan {
  move: Move;
  direction: Direction;
  /** What the move does, a sentence each. */
  lines: string[];
  /** Why it can't be made now; empty when it can. */
  blockers: string[];
  /** What the page sends back with the move, which is refused once it no longer matches. */
  base: unknown;
}

/** A move that can't be made as asked; the API answers 400. */
export class MoveRefused extends PluginInputError {}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const canonical = (v: unknown): string => JSON.stringify(v, (_, x) =>
  (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** The repos a move covers: those the project's items name that it may run plugins for, and the one the page shows. */
async function reposFor(d: Pick<Db, "query">, project: string, repo: string, notes: string[]): Promise<string[]> {
  const repos = await pluginRepos(d, project, notes);
  return repo && !repos.includes(repo) ? [...repos, repo].sort() : repos;
}

/** The repos where a shipped plugin is switched on. */
async function reposOn(d: Pick<Db, "query">, project: string, plugin: string): Promise<string[]> {
  return (await d.query("select repo from plugin_configs where project = $1 and $2 = any(shipped) order by repo", [project, plugin])).map((r) => r.repo);
}

/** What keeps the project's jira connection from working in its plugins, or null when it's ready. */
async function jiraUnready(d: Pick<Db, "query">, project: string, repo: string): Promise<string | null> {
  const host = await hostSet(d, project, repo);
  const def = host.connections.jira;
  if (!def || !("http" in def) || (def.http.auth && !host.secrets.jira)) return "Connect todo to Jira first, in the step above, so nothing goes unsent in between.";
  return null;
}

/** Item notes that say which items no plugin reaches, as what that means for this move. */
const reach = (notes: string[], what: string) => notes.map((n) => `${n.replace(/, so no plugin runs for them$/, "").replace(/, which this project may not run plugins for$/, ", which this project doesn't run plugins for")}: ${what}.`);

const shownInstances = async (d: Pick<Db, "query">, project: string, repo: string, plugin: string): Promise<InstanceDef[]> =>
  (await storedInstances(d, project, repo))[plugin] ?? [];

// ── todo → Jira: the bridge's triggers and jira-transition ───────────────────
async function triggersHere(d: Pick<Db, "query">, project: string, repo: string): Promise<MovePlan> {
  const [p] = await d.query("select jira_outbound from projects where key = $1", [project]);
  const rules = outboundRules(p?.jira_outbound) ?? { writes: false, never: [], triggers: [] };
  const notes: string[] = [];
  const repos = await reposFor(d, project, repo, notes);
  const blockers: string[] = [];
  const lines: string[] = [];
  const n = rules.triggers.length;
  if (!n) blockers.push("The Jira bridge has no triggers to move.");
  if (!repos.length) blockers.push("This project runs plugins in no repo yet: add one above first.");
  else {
    const unready = await jiraUnready(d, project, repos[0]);
    if (unready) blockers.push(unready);
  }
  if (n) {
    lines.push(`${plural(n, "trigger")} move here, in order, for ${listed(repos)}; the Jira bridge stops moving tickets.`);
    if (rules.never.length) lines.push(`Never move Jira to ${listed(rules.never)} comes too.`);
    lines.push(rules.writes ? "Send to Jira stays on: from now on jira-transition moves the tickets." : "Send to Jira stays off: jira-transition records the moves it would make, as the bridge did.");
  }
  for (const r of repos) {
    const had = (await shownInstances(d, project, r, JIRA_TRANSITION)).length;
    if (had) lines.push(`They replace the ${plural(had, "trigger")} jira-transition has in ${r}.`);
  }
  const [waiting] = await d.query(
    "select count(*)::int as n from jira_outbox where project = $1 and action = 'transition' and done_at is null and claimed_at is null", [project]);
  if (waiting.n) lines.push(`${plural(waiting.n, "move")} the bridge hasn't sent yet ${waiting.n === 1 ? "is" : "are"} dropped.`);
  lines.push(...reach(notes, "their tickets stop moving"));
  return { move: "jira-triggers", direction: "here", lines, blockers, base: { triggers: rules.triggers, never: rules.never, writes: rules.writes } };
}

async function triggersBack(d: Pick<Db, "query">, project: string, repo: string): Promise<MovePlan> {
  const instances = await shownInstances(d, project, repo, JIRA_TRANSITION);
  const { rules, problems } = rulesOf(instances);
  const blockers = [...problems];
  if (!rules.triggers.length && !problems.length) blockers.push(`jira-transition has no triggers in ${repo} to move back.`);
  blockers.push(...validateRules(rules, STATUSES).filter((p) => p.level === "error").map((p) => p.message));
  const [p] = await d.query("select jira_outbound from projects where key = $1", [project]);
  const had = outboundRules(p?.jira_outbound)?.triggers.length ?? 0;
  const on = await reposOn(d, project, JIRA_TRANSITION);
  const lines = [
    `${plural(rules.triggers.length, "trigger")} from ${repo} go back to the Jira bridge, which moves tickets for every item in the project.`,
    rules.writes ? "Send to Jira stays on there." : "Send to Jira stays off there: the bridge records the moves it would make.",
  ];
  if (had) lines.push(`They replace the bridge's ${plural(had, "trigger")}.`);
  if (on.length) lines.push(`jira-transition is switched off in ${listed(on)}; its triggers stay, for a later move.`);
  return { move: "jira-triggers", direction: "back", lines, blockers, base: { instances, on } };
}

// ── Jira → todo: the bridge's polling and jira-issue ─────────────────────────
async function pollingHere(d: Pick<Db, "query">, project: string, repo: string): Promise<MovePlan> {
  const state = await bridgeState(d, project);
  const notes: string[] = [];
  const repos = await reposFor(d, project, repo, notes);
  const [linked] = await d.query("select count(distinct jira_key)::int as n from jira_links where project = $1 and source = 'field'", [project]);
  const blockers: string[] = [];
  if (!state.polls) blockers.push("The Jira bridge doesn't poll this project's tickets: switch jira-issue on instead.");
  if (!repos.length) blockers.push("This project runs plugins in no repo yet: add one above first.");
  else {
    const unready = await jiraUnready(d, project, repos[0]);
    if (unready) blockers.push(unready);
  }
  const lines = [
    `jira-issue shows the status, comments and images of the ${plural(linked.n, "linked ticket")} in ${listed(repos)}; the Jira bridge stops polling this project.`,
    "It adds a newly linked ticket's summary and description to the item's request, as the bridge did.",
    "Comments the bridge already brought in stay, and don't come in again.",
    ...reach(notes, "their tickets stop coming in"),
  ];
  return { move: "jira-polling", direction: "here", lines, blockers, base: { polls: state.polls } };
}

async function pollingBack(d: Pick<Db, "query">, project: string): Promise<MovePlan> {
  const on = await reposOn(d, project, JIRA_ISSUE);
  const lines = [`The Jira bridge polls this project's linked tickets again${on.length ? `, and jira-issue is switched off in ${listed(on)}` : ""}.`];
  return { move: "jira-polling", direction: "back", lines, blockers: [], base: { on } };
}

// ── the General tab's Actions and watchtower-session or rest ─────────────────
const KIND = { watchtower: "watchtower", rest: "rest" } as const;
const PLUGIN = { watchtower: WATCHTOWER, rest: REST } as const;
type ActionMove = keyof typeof KIND;

/** An Action moved into a plugin, kept as it was so it can move back. */
interface Moved { action: ActionDef; plugin: string; repos: string[]; by: string; at: string }

const movedOf = (raw: unknown): Moved[] => (Array.isArray(raw) ? raw.filter((m) => m?.action?.id && typeof m.plugin === "string") : []);
const quoted = (names: string[]) => listed(names.map((n) => `"${n}"`));

async function actionsHere(d: Db, project: string, move: ActionMove, repo: string, lookup?: AddressGuard["lookup"]): Promise<MovePlan> {
  const [p] = await d.query("select actions from projects where key = $1", [project]);
  const actions = storedActions(p?.actions).filter((a) => a.kind === KIND[move]);
  const notes: string[] = [];
  const repos = await reposFor(d, project, repo, notes);
  const plan = await planPort(d, project, { repos, kinds: [KIND[move]], jira: false, lookup });
  const blockers: string[] = [];
  if (!actions.length) blockers.push(`The General tab has no ${move === "rest" ? "REST" : "Watchtower"} Actions to move.`);
  if (!repos.length) blockers.push("This project runs plugins in no repo yet: add one above first.");
  const secrets = actions.filter((a) => credentialSecret(a));
  const keyProblem = secretKeyProblem();
  if (secrets.length && keyProblem) blockers.push(`Their credentials can't be stored here: ${keyProblem}.`);
  const plugin = PLUGIN[move];
  const n = actions.length;
  const lines = n ? [
    `${plural(n, "Action")} ${n === 1 ? "moves" : "move"} here as ${plugin} buttons for ${listed(repos)}: ${quoted(actions.map((a) => a.name || a.id))}.`,
    `${n === 1 ? "It leaves" : "They leave"} the General tab, so items never show both buttons or fire both.`,
  ] : [];
  const fires = actions.filter((a) => a.auto.length).length;
  if (fires) lines.push(`${plural(fires, "of them fires", "of them fire")} on ${fires === 1 ? "its" : "their"} status moves here too.`);
  for (const [name, def] of Object.entries(plan.connections)) {
    const url = "http" in def ? def.http.url : "";
    lines.push(`Adds this project's ${name} connection at ${url}${plan.secrets[name] ? `, with ${plan.secrets[name]}` : ""}.`);
  }
  for (const entry of plan.allowHosts) lines.push(`Lets todo call ${entry}, a private address, as the Action did.`);
  for (const [name, what] of Object.entries(plan.secrets)) {
    if (!plan.connections[name]) lines.push(`Give ${name} ${what} on its line below; the button fails until then.`);
  }
  lines.push(...[...new Set(plan.notes)].filter((x) => !/no plugin runs for them|may not run plugins for/.test(x)).map((x) => `${x.charAt(0).toUpperCase()}${x.slice(1)}.`));
  lines.push(...reach(notes, "they get no button"));
  return { move, direction: "here", lines, blockers, base: { actions } };
}

async function actionsBack(d: Pick<Db, "query">, project: string, move: ActionMove): Promise<MovePlan> {
  const [p] = await d.query("select actions, actions_moved from projects where key = $1", [project]);
  const plugin = PLUGIN[move];
  const moved = movedOf(p?.actions_moved).filter((m) => m.plugin === plugin);
  const ids = new Set(storedActions(p?.actions).map((a) => a.id));
  const blockers = moved.filter((m) => ids.has(m.action.id))
    .map((m) => `An Action with the id ${m.action.id} is on the General tab now; remove or rename it there first.`);
  if (!moved.length) blockers.push(`No Actions moved into ${plugin} to move back.`);
  const repos = [...new Set(moved.flatMap((m) => m.repos))].sort();
  const lines = moved.length ? [
    `${plural(moved.length, "Action")} ${moved.length === 1 ? "goes" : "go"} back to the General tab as ${moved.length === 1 ? "it was" : "they were"} before the move: ${quoted(moved.map((m) => m.action.name || m.action.id))}.`,
    `Their ${plugin} buttons are removed from ${listed(repos)}, with any change made to them here; ${plugin} is switched off where no other button is left.`,
  ] : [];
  return { move, direction: "back", lines, blockers, base: { moved } };
}

async function moveActionsHere(t: Db, project: string, move: ActionMove, repo: string, by: string, lookup?: AddressGuard["lookup"]): Promise<void> {
  const [p] = await t.query("select actions, actions_moved from projects where key = $1", [project]);
  const all = storedActions(p.actions);
  const actions = all.filter((a) => a.kind === KIND[move]);
  const repos = await reposFor(t, project, repo, []);
  const plan = await planPort(t, project, { repos, kinds: [KIND[move]], jira: false, lookup });
  const plugin = PLUGIN[move];
  for (const [name, def] of Object.entries(plan.connections)) {
    const from = actions.find((a) => (plan.instances[plugin] ?? []).some((i) => i.id === actionInstanceId(a) && i.settings?.connection === name));
    const secret = from ? credentialSecret(from) : null;
    const http = "http" in def ? def.http : null;
    const entry = http ? new URL(http.url) : null;
    const privateOk = !!entry && plan.allowHosts.includes(`${entry.hostname.replace(/^\[|\]$/g, "")}:${entry.port || (entry.protocol === "https:" ? "443" : "80")}`);
    await putProjectConnection(t, project, { name, def, base: null, ...(secret ? { secret } : {}), ...(privateOk ? { allowPrivate: true } : {}) }, by,
                               { lookup });
  }
  // The Actions were live, so their buttons are too.
  const ported = (plan.instances[plugin] ?? []).map(({ dry_run: _dry, ...i }) => i);
  for (const r of repos) {
    await setShipped(t, project, r, plugin, true, by);
    const kept = ((await storedInstances(t, project, r, { secrets: true }))[plugin] ?? []).filter((i) => !ported.some((x) => x.id === i.id));
    await putInstances(t, project, r, plugin, [...kept, ...ported], by);
  }
  const at = new Date().toISOString();
  const moved = [...movedOf(p.actions_moved), ...actions.map((action) => ({ action, plugin, repos, by, at }))];
  await t.query("update projects set actions = $2::jsonb, actions_moved = $3::jsonb, actions_by = $4, actions_at = now() where key = $1",
                [project, JSON.stringify(all.filter((a) => a.kind !== KIND[move])), JSON.stringify(moved), by]);
}

async function moveActionsBack(t: Db, project: string, move: ActionMove, by: string): Promise<void> {
  const [p] = await t.query("select actions, actions_moved from projects where key = $1", [project]);
  const plugin = PLUGIN[move];
  const all = movedOf(p.actions_moved);
  const back = all.filter((m) => m.plugin === plugin);
  const ids = new Set(back.map((m) => actionInstanceId(m.action)));
  for (const r of [...new Set(back.flatMap((m) => m.repos))]) {
    await t.query("delete from plugin_instances where project = $1 and repo = $2 and plugin = $3 and id = any($4)", [project, r, plugin, [...ids]]);
    const [left] = await t.query("select 1 from plugin_instances where project = $1 and repo = $2 and plugin = $3 limit 1", [project, r, plugin]);
    if (!left) await setShipped(t, project, r, plugin, false, by);
  }
  await t.query("update projects set actions = $2::jsonb, actions_moved = $3::jsonb, actions_by = $4, actions_at = now() where key = $1",
                [project, JSON.stringify([...storedActions(p.actions), ...back.map((m) => m.action)]), JSON.stringify(all.filter((m) => m.plugin !== plugin)), by]);
}

/** What a move would do, for the page to show before it's made. */
export async function planMove(d: Db, project: string, move: Move, direction: Direction, repo: string,
                               opts: { lookup?: AddressGuard["lookup"] } = {}): Promise<MovePlan> {
  if (move === "jira-triggers") return direction === "here" ? triggersHere(d, project, repo) : triggersBack(d, project, repo);
  if (move === "jira-polling") return direction === "here" ? pollingHere(d, project, repo) : pollingBack(d, project);
  return direction === "here" ? actionsHere(d, project, move, repo, opts.lookup) : actionsBack(d, project, move);
}

/** Make a move as planned, in one transaction: refused with a 409 once its base has changed, and with a 400 while a blocker stands. */
export async function makeMove(d: Db, project: string, move: Move, direction: Direction, repo: string, base: unknown, by: string,
                               opts: { lookup?: AddressGuard["lookup"] } = {}): Promise<void> {
  await d.tx(async (t) => {
    await lockProject(t, project);
    const plan = await planMove(t, project, move, direction, repo, opts);
    if (canonical(plan.base) !== canonical(base)) throw new PluginConflict("what this move takes over changed since this page loaded; reload to see it as it is");
    if (plan.blockers.length) throw new MoveRefused(plan.blockers.join(" "));
    if (move === "watchtower" || move === "rest") {
      if (direction === "here") await moveActionsHere(t, project, move, repo, by, opts.lookup);
      else await moveActionsBack(t, project, move, by);
    } else if (move === "jira-triggers" && direction === "here") await moveTriggersHere(t, project, repo, by);
    else if (move === "jira-triggers") await moveTriggersBack(t, project, repo, by);
    else if (direction === "here") await movePollingHere(t, project, repo, by);
    else await movePollingBack(t, project, by);
    if (move === "jira-triggers") await settleJira(t, project, JIRA_TRANSITION);
    if (move === "jira-polling") await settleJira(t, project, JIRA_ISSUE);
  });
}

async function moveTriggersHere(t: Db, project: string, repo: string, by: string): Promise<void> {
  const [p] = await t.query("select jira_outbound from projects where key = $1", [project]);
  const rules = outboundRules(p.jira_outbound)!;
  await t.query("update projects set jira_outbound = $2::jsonb, jira_settings_by = $3, jira_settings_at = now() where key = $1",
                [project, JSON.stringify({ writes: false, never: [], triggers: [] }), by]);
  await t.query(
    `update jira_outbox set done_at = now(), result = '{"superseded":true}'::jsonb
      where project = $1 and action = 'transition' and done_at is null and claimed_at is null`, [project]);
  const instances = ruleInstances({ writes: rules.writes, never: rules.never, triggers: rules.triggers });
  for (const r of await reposFor(t, project, repo, [])) {
    await setShipped(t, project, r, JIRA_TRANSITION, true, by);
    await putInstances(t, project, r, JIRA_TRANSITION, instances, by);
  }
}

async function moveTriggersBack(t: Db, project: string, repo: string, by: string): Promise<void> {
  const { rules } = rulesOf(await shownInstances(t, project, repo, JIRA_TRANSITION));
  for (const r of await reposOn(t, project, JIRA_TRANSITION)) await setShipped(t, project, r, JIRA_TRANSITION, false, by);
  await t.query("update projects set jira_outbound = $2::jsonb, jira_settings_by = $3, jira_settings_at = now() where key = $1",
                [project, JSON.stringify(rules), by]);
}

async function movePollingHere(t: Db, project: string, repo: string, by: string): Promise<void> {
  await t.query("update projects set jira_poll = false where key = $1", [project]);
  for (const r of await reposFor(t, project, repo, [])) {
    await setShipped(t, project, r, JIRA_ISSUE, true, by);
    const stored = await shownInstances(t, project, r, JIRA_ISSUE);
    if (stored.length) {
      await putInstances(t, project, r, JIRA_ISSUE, stored.map(({ dry_run: _dry, enabled: _on, ...rest }) => rest), by);
    }
    const granted = (await storedGrants(t, project, r))[JIRA_ISSUE] ?? [];
    if (!granted.includes(POST_REQUEST)) await putGrants(t, project, r, JIRA_ISSUE, [...granted, POST_REQUEST], by);
  }
}

async function movePollingBack(t: Db, project: string, by: string): Promise<void> {
  for (const r of await reposOn(t, project, JIRA_ISSUE)) await setShipped(t, project, r, JIRA_ISSUE, false, by);
  await t.query("update projects set jira_poll = true where key = $1", [project]);
}
