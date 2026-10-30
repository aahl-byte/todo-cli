// The Automation settings page as data: one row per thing todo can do for a
// repo's items, each in exactly one state (on, off, needs setup, or done
// elsewhere today), with the evidence or the steps that go with it. Pure, so the
// page and the tests share it.
import { fieldsOf } from "./plugin-form";
import type { BridgeFacts, DashConnection, DashCustom, DashPlugin, DashRepo, HostConnection, RepoEntry, RunRow } from "./plugin-views";
import type { Attachment } from "./plugins/types";
import { serviceLabel, type Service } from "./services";

export type RowState = "on" | "setup" | "elsewhere" | "off";

/** One thing to do on this page before a row is on, or one already done. */
export interface Step {
  text: string;
  done: boolean;
  /** Taken in this row's settings, which open from the step. */
  setup?: boolean;
  /** Taken in the form for this connection, which opens from the step in the row. */
  connect?: string;
}

export interface Note { text: string; warn?: boolean; link?: { label: string; href: string } }

export interface LastRun {
  at: string;
  item: { id: string; title: string } | null;
  did: string;
  detail: string | null;
  tone: "ok" | "warn" | "fail";
}

export interface AutomationRow {
  key: string;
  /** What happens to items, as a sentence. */
  title: string;
  /** The plugins behind it, shown small. */
  plugins: string[];
  state: RowState;
  /** On: the last thing it did, null when it hasn't run; absent where runs aren't the evidence. */
  last?: LastRun | null;
  /** What turning it on would give. */
  offers?: string;
  notes: Note[];
  steps: Step[];
  /** The plugin whose settings and history open from the row. */
  plugin: DashPlugin | null;
  /** A shipped plugin's switch, on while the repo runs it; absent where there's none to flip. */
  toggle?: { plugin: string; on: boolean };
  /** The custom plugin the row's editor opens. */
  custom?: DashCustom;
  /** The row's settings are the deploy-branches field. */
  branches?: boolean;
  /** A move between the old code that does this job and the plugin, with the button for each way it can go now. */
  handover?: Handover;
}

export interface Handover {
  move: "jira-triggers" | "jira-polling" | "watchtower" | "rest";
  /** Offered while the old code does the job. */
  here?: string;
  /** Offered while the plugin does it. */
  back?: string;
}

export interface RowContext { project: string; bridge: BridgeFacts; host: HostConnection[]; services: Service[] }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The verb that agrees with a count: "1 trigger moves", "2 triggers move". */
const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ── repos ─────────────────────────────────────────────────────────────────────
const byItems = (a: RepoEntry, b: RepoEntry) => b.items - a.items || a.repo.localeCompare(b.repo);

/** The picker's repos: those items name or the project lists, most items first; those only a checkout brings in; and
 * those the project can't read yet. */
export function repoChoices(repos: RepoEntry[]): { main: RepoEntry[]; checkoutOnly: RepoEntry[]; unconnected: RepoEntry[] } {
  return {
    main: repos.filter((r) => !r.refusal && !r.folded).sort(byItems),
    checkoutOnly: repos.filter((r) => !r.refusal && r.folded).sort(byItems),
    unconnected: repos.filter((r) => r.refusal).sort(byItems),
  };
}

/** The repo to show: the one asked for when the project can read it, else the one most items name. */
export function pickRepo(repos: RepoEntry[], wanted: string | null): string | null {
  const { main, checkoutOnly } = repoChoices(repos);
  const readable = [...main, ...checkoutOnly];
  if (wanted && readable.some((r) => r.repo === wanted)) return wanted;
  return readable[0]?.repo ?? null;
}

// ── deploy branches ───────────────────────────────────────────────────────────
/** The branches a field holds: separated by commas or spaces, once each. */
export const splitBranches = (text: string) => [...new Set(text.split(/[\s,]+/).map((b) => b.trim()).filter(Boolean))];

const DEPLOY_LIKE = /^(main|master|staging|stage|production|prod|develop|dev|qa|uat|release([/-].+)?)$/i;
const SUGGESTED = 6;

/** The remote's branches worth offering as deploy branches: the default and the ones named like a deploy target, less those chosen. */
export function suggestBranches(branches: DashRepo["branches"], chosen: string[]): string[] {
  const named = branches.names.filter((n) => n === branches.default || DEPLOY_LIKE.test(n));
  return named.filter((n) => !chosen.includes(n)).slice(0, SUGGESTED);
}

/** What a new custom plugin's editor starts with: a manual button that logs a line, to change into the real thing. */
export const CUSTOM_STARTER = `description: Says what it does, in one line.
on: [manual]
attach:
  - log: "{{item.id}}: ran"
`;

// ── what each shipped plugin does, in words ──────────────────────────────────
interface Copy {
  title: string;
  /** What items would get. */
  offers: string;
  /** The step taken here once it's on, when it has settings to fill. */
  here?: string;
}

const SHIPPED_COPY: Record<string, Copy> = {
  "pr-link": { title: "Link each branch's pull request", offers: "Items would link the pull request of each of their branches." },
  "jira-transition": {
    title: "Move Jira tickets when items move",
    offers: "When an item moves, the Jira tickets it links would move to the Jira status you pick for that move.",
    here: "pick the Jira status for each move",
  },
  "jira-issue": {
    title: "Show linked Jira tickets' status and comments on items",
    offers: "Items that link a Jira ticket would show its status, comments and images.",
  },
  "watchtower-session": {
    title: "Start or resume a Claude session in Watchtower",
    offers: "Items would get a Watchtower button that hands the item to its Claude session there: sent to the live one, its last one resumed, or a new one started.",
  },
  rest: {
    title: "Send a web request to any URL",
    offers: "Items would get a button that sends a request you define to any URL, filled in from the item.",
    here: "set the button's connection and request",
  },
  "vercel-preview": {
    title: "Link each branch's Vercel preview",
    offers: "Items would link the newest ready Vercel preview of each of their branches.",
    here: "enter the Vercel project and team",
  },
  "db-request": {
    title: "Link db-request submissions for each branch",
    offers: "Items would link each db-request submission for their branches, and wait on its migrations pull request.",
  },
};
/** Rows in this order within a state; a shipped plugin missing here, and the repo's custom ones, follow. */
const ORDER = ["track", ...Object.keys(SHIPPED_COPY)];
const STATE_ORDER: Record<RowState, number> = { on: 0, setup: 1, elsewhere: 3, off: 4 };

const settingsHref = (project: string, part: "jira" | "actions") => `/p/${project}/settings#${part}`;

// ── what still does a plugin's job outside plugins ───────────────────────────
interface Duplicate { text: string; also: string; link: { label: string; href: string } }

const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");

/** The Jira bridge or the Actions that do this plugin's job today, if any. */
function doneElsewhere(plugin: string, ctx: RowContext): Duplicate | null {
  const { jira, actions } = ctx.bridge;
  if (plugin === "jira-transition" && jira.triggers) {
    const n = plural(jira.triggers, "trigger");
    const sending = jira.writes && !jira.readOnly ? "" : "; sending is off there, so it records the moves it would make";
    return {
      text: `${n} in the Jira bridge ${verb(jira.triggers, "moves", "move")} tickets today${sending}.`,
      also: jira.writes ? `The Jira bridge also moves tickets with ${n}, so this only records what it would do until they move here.`
        : `The Jira bridge also has ${n}, which only record the moves they'd make.`,
      link: { label: "General → Jira", href: settingsHref(ctx.project, "jira") },
    };
  }
  if (plugin === "jira-issue" && jira.polls) {
    const n = plural(jira.linked, "linked ticket");
    return {
      text: jira.linked ? `The Jira bridge does this today, for ${n}.` : "The Jira bridge does this today, once an item links a ticket.",
      also: `The Jira bridge also mirrors ${n}, so this attaches nothing until its polling moves here.`,
      link: { label: "General → Jira", href: settingsHref(ctx.project, "jira") },
    };
  }
  const kind = plugin === "rest" ? "rest" : plugin === "watchtower-session" ? "watchtower" : null;
  const named = kind ? actions.filter((a) => a.kind === kind).map((a) => a.name) : [];
  if (named.length) {
    const n = plural(named.length, "Action");
    return {
      text: `${n} on the General tab ${verb(named.length, "does", "do")} this today: ${quoted(named)}.`,
      also: `${n} on the General tab also ${verb(named.length, "does", "do")} this (${quoted(named)}), so items would get both buttons.`,
      link: { label: "General → Actions", href: settingsHref(ctx.project, "actions") },
    };
  }
  return null;
}

/** The move between the old code and this plugin that fits now: here while the old code does the job, back while the plugin does. */
function handoverOf(plugin: string, ctx: RowContext, on: DashPlugin | null): Handover | undefined {
  const { jira } = ctx.bridge;
  if (plugin === "jira-transition") {
    const back = !!on && on.instances.length > 0;
    if (!jira.triggers && !back) return undefined;
    return { move: "jira-triggers", ...(jira.triggers ? { here: "Move these triggers here" } : {}),
             ...(back ? { back: "Move these triggers back to the Jira bridge" } : {}) };
  }
  if (plugin === "jira-issue") {
    if (jira.polls) return { move: "jira-polling", here: "Move polling here" };
    if (on && jira.polled) return { move: "jira-polling", back: "Move polling back to the Jira bridge" };
  }
  const kind = plugin === "rest" ? "rest" : plugin === "watchtower-session" ? "watchtower" : null;
  if (kind) {
    const here = ctx.bridge.actions.some((a) => a.kind === kind);
    const back = ctx.bridge.moved.some((m) => m.plugin === plugin);
    if (!here && !back) return undefined;
    return { move: kind, ...(here ? { here: "Move these Actions here" } : {}), ...(back ? { back: "Move these Actions back to the General tab" } : {}) };
  }
  return undefined;
}

// ── steps ─────────────────────────────────────────────────────────────────────
/** What todo still needs to read the repo on GitHub, which git facts and every plugin run need: a token, or one that can see it. */
function githubSteps(repo: DashRepo): Step[] {
  const connect = "github";
  if (repo.github === null) {
    return [{ text: `Give todo a GitHub token that can read ${repo.repo}, so it can see the repo's branches, commits and pull requests.`, done: false, connect }];
  }
  if (repo.branches.visible !== false) return [];
  const whose = repo.github === "page" ? "This project's GitHub token" : "The server's GitHub token";
  return [{ text: `${whose} can't see ${repo.repo}: give the project a token that can read its branches, commits and pull requests.`, done: false, connect }];
}

/** How a service authorizes, in words: "an API token", "an email and API token". */
function credentialWords(s: Service | undefined): string {
  if (s?.auth === "basic") return `${s.user ? `an ${s.user.toLowerCase()}` : "a user"} and ${s.pass ?? "password"}`;
  const what = s?.secret ? s.secret.replace(new RegExp(`^${s.label} `), "") : "token";
  return `${/^[AEIOUaeiou]/.test(what) ? "an" : "a"} ${what}`;
}

/** What one of the project's or the server's connections still needs before a shipped plugin can call it, and what it has. */
function hostSteps(name: string, h: HostConnection | undefined, services: Service[], canSetUp: boolean): Step[] {
  const label = serviceLabel(services, name);
  const s = services.find((x) => x.name === name);
  const connect = canSetUp ? { connect: name } : {};
  if (!h) {
    const text = s?.auth === "none" ? `Give todo ${label}'s address.` : s ? `Connect todo to ${label} with ${credentialWords(s)}.`
      : `Add the ${name} connection: where it is and how it authorizes.`;
    return [{ text, done: false, ...connect }];
  }
  if (h.refused) return [{ text: `Allow todo to call ${label} at ${h.url}, which is on your private network.`, done: false, ...connect }];
  if (h.unreadable) return [{ text: `Enter the ${label} credential again: the stored one doesn't decrypt on this server.`, done: false, ...connect }];
  if (h.auth && !h.held) return [{ text: `Enter ${label}'s ${s?.auth === "basic" ? `${s.user?.toLowerCase() ?? "user"} and ${s.pass ?? "password"}` : "token"}.`, done: false, ...connect }];
  return [{ text: h.source === "page" ? `Connected to ${label}.` : `Connected to ${label} through the server's connection.`, done: true, ...connect }];
}

/** What a connection still needs before the server can call it, and what it already has. */
function connectionSteps(name: string, conn: DashConnection | undefined, shipped: boolean, ctx: RowContext, canSetUp: boolean): Step[] {
  if (name === "github") return [];
  if (conn?.origin === "repo") {
    if (conn.command) return [{ text: `Point ${name} at a URL under Connections: the server never starts a command.`, done: false }];
    if (!conn.needsSecret) return [];
    return [conn.held ? { text: `${name} credential stored.`, done: true }
                      : { text: `Enter the ${name} credential.`, done: false, setup: canSetUp }];
  }
  const h = ctx.host.find((c) => c.name === name);
  if (!shipped) {
    return [{ text: h ? `Add a connection named ${name} under Connections: only plugins that ship with todo use the project's own.`
                      : `Add a connection named ${name} under Connections.`, done: false }];
  }
  return hostSteps(name, h, ctx.services, canSetUp);
}

const staticConnections = (names: string[]) => names.filter((c) => !c.includes("{{"));

/** The settings an instance needs before it runs and hasn't got. */
function missingSettings(p: DashPlugin, inst: DashPlugin["instances"][number]): string[] {
  return fieldsOf(p.settings).filter((f) => f.required)
    .filter((f) => { const v = inst.settings?.[f.key]; return v === undefined || v === null || v === ""; })
    .map((f) => f.label);
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

function instanceSteps(p: DashPlugin, copy: Copy | undefined): Step[] {
  const required = fieldsOf(p.settings).filter((f) => f.required).map((f) => f.label);
  const here = copy?.here ?? (required.length ? `fill in ${listed(required)}` : "add one");
  const enabled = p.instances.filter((i) => i.enabled !== false);
  if (!p.instances.length) return [{ text: `${sentence(here)}.`, done: false, setup: true }];
  if (!enabled.length) return [{ text: "Switch it on: it's switched off here.", done: false, setup: true }];
  if (!required.length) return [];
  const ready = enabled.find((i) => !missingSettings(p, i).length);
  if (ready) return [{ text: `${sentence(here)}.`, done: true }];
  const missing = missingSettings(p, enabled[0]);
  const text = copy?.here ? `${sentence(copy.here)}: ${listed(missing)} ${verb(missing.length, "is", "are")} empty.` : `Fill in ${listed(missing)}.`;
  return [{ text, done: false, setup: true }];
}

// ── evidence ──────────────────────────────────────────────────────────────────
const trivial = (r: RunRow) => !!r.skipped && /(^|: )when is false/.test(r.skipped);

function didOf(a: Attachment): { did: string; detail: string | null } {
  switch (a.kind) {
    case "link": return { did: a.type === "pr" ? `linked PR ${a.label ?? a.url}` : `linked ${a.label ?? a.url}`, detail: null };
    case "edge": return { did: "added a dependency", detail: `needs ${a.needs}` };
    case "doc": return { did: `attached ${a.name}`, detail: null };
    case "log": return { did: "logged a line", detail: a.text };
    case "request": return { did: "added to the request", detail: null };
    case "comment": return { did: "mirrored a comment", detail: null };
    case "status": return { did: `moved the item to ${a.to}`, detail: a.text ?? null };
  }
}

/** The last thing a plugin did: its newest run that did something, else its newest run; null when it hasn't run. */
export function lastRun(p: DashPlugin): LastRun | null {
  const runs = Object.values(p.runs).flat().sort((a, b) => b.id - a.id);
  const r = runs.find((x) => !trivial(x)) ?? runs[0];
  if (!r) return null;
  const base = { at: r.at, item: r.item };
  if (r.error) return { ...base, did: "failed", detail: r.error, tone: "fail" };
  if (r.skipped) return { ...base, did: "skipped", detail: r.skipped.replace(/^[^:]+: /, ""), tone: "warn" };
  const move = r.attached.find((a) => a.kind === "status");
  if (r.dryRun && move?.kind === "status") return { ...base, did: `would have moved the item to ${move.to} (test mode)`, detail: move.text ?? null, tone: "ok" };
  if (r.dryRun) return { ...base, did: `would have sent ${plural(r.wouldSend.length, "request")} (test mode)`, detail: null, tone: "ok" };
  if (!r.attached.length) return { ...base, did: "found nothing new", detail: null, tone: "ok" };
  const first = didOf(r.attached[0]);
  const more = r.attached.length > 1 ? ` and ${r.attached.length - 1} more` : "";
  return { ...base, did: first.did + more, detail: first.detail, tone: "ok" };
}

// ── rows ──────────────────────────────────────────────────────────────────────
function trackRow(repo: DashRepo): AutomationRow {
  const base = { key: "track", plugins: ["deploy branches"], plugin: null, branches: true };
  if (repo.track.length) {
    const steps = githubSteps(repo);
    return {
      ...base, title: `Show where work has landed (${repo.track.join(", ")})`, state: steps.length ? "setup" : "on", steps,
      notes: [{ text: "Items show which of these deploy branches hold their work, and dependencies are checked against them." }],
    };
  }
  return {
    ...base, title: "Show where work has landed", state: "off",
    offers: "Items would show which deploy branches hold their work, like \"in staging ✓ · in main ✗\", "
      + "and dependencies would be checked against those branches.",
    notes: [],
    steps: [...githubSteps(repo), { text: "Name the branches work deploys from, such as staging and main.", done: false, setup: true }],
  };
}

function offeredRow(repo: DashRepo, name: string, description: string | null, connections: string[], ctx: RowContext): AutomationRow {
  const copy = SHIPPED_COPY[name];
  const title = copy?.title ?? description ?? name;
  const toggle = { plugin: name, on: false };
  const elsewhere = doneElsewhere(name, ctx);
  const handover = handoverOf(name, ctx, null);
  if (elsewhere) {
    // Moving the job here needs the connections it calls first, so nothing goes undone in between.
    const steps = handover?.move.startsWith("jira") ? staticConnections(connections).flatMap((c) => connectionSteps(c, repo.connections.find((x) => x.name === c), true, ctx, true)) : [];
    // Switching jira-issue on is refused while the bridge polls: the move is the way.
    const switchable = !(name === "jira-issue" && ctx.bridge.jira.polls);
    return { key: name, title, plugins: [name], state: "elsewhere", notes: [{ text: elsewhere.text, link: elsewhere.link }], steps, plugin: null,
             ...(switchable ? { toggle } : {}), ...(handover ? { handover } : {}) };
  }
  const steps: Step[] = [];
  if (copy?.here) steps.push({ text: `${sentence(copy.here)}, once it's switched on.`, done: false });
  for (const c of staticConnections(connections)) {
    steps.push(...connectionSteps(c, repo.connections.find((x) => x.name === c), true, ctx, false));
  }
  return { key: name, title, plugins: [name], state: "off", offers: copy?.offers ?? description ?? undefined, notes: [], steps, plugin: null, toggle,
           ...(handover ? { handover } : {}) };
}

function pluginRow(repo: DashRepo, p: DashPlugin, ctx: RowContext): AutomationRow {
  const copy = p.shipped ? SHIPPED_COPY[p.name] : undefined;
  const title = copy?.title ?? p.description?.replace(/\.$/, "") ?? p.name;
  const enabled = p.instances.filter((i) => i.enabled !== false);
  // Nothing runs for a repo todo can't read on GitHub, so that comes first.
  const github = repo.github === null ? githubSteps(repo) : [];
  const steps: Step[] = [...github, ...instanceSteps(p, copy)];
  for (const c of repo.connections.filter((x) => x.usedBy.includes(p.name))) {
    steps.push(...connectionSteps(c.name, c, p.shipped, ctx, true));
  }
  const notes: Note[] = [];
  if (!p.shipped && !p.description) notes.push({ text: "A custom plugin of this repo; its YAML gives no description." });
  const elsewhere = p.shipped ? doneElsewhere(p.name, ctx) : null;
  if (elsewhere) notes.push({ text: elsewhere.also, link: elsewhere.link, warn: true });
  const handover = p.shipped ? handoverOf(p.name, ctx, p) : undefined;
  const base = {
    key: p.name, title, plugins: [p.name], notes, plugin: p, ...(handover ? { handover } : {}),
    ...(p.shipped && !p.always ? { toggle: { plugin: p.name, on: true } } : {}),
    ...(p.shipped ? {} : { custom: repo.custom.find((c) => c.name === p.name) }),
  };
  if (p.instances.length && !enabled.length) {
    return { ...base, state: "off", offers: copy?.offers ?? undefined, steps };
  }
  const open = steps.some((s) => !s.done);
  const stuck = enabled.length > 0 && enabled.every((i) => !i.server_runs);
  if (!open && stuck && !github.length) notes.unshift({ text: `The server can't run it yet: ${enabled[0].server_runs_reason}.`, warn: true });
  if (open || stuck) return { ...base, state: "setup", steps, last: lastRun(p) };
  if (enabled.every((i) => i.dry_run)) notes.unshift({ text: "In test mode: it shows what it would do without doing it." });
  return { ...base, state: "on", steps, last: lastRun(p) };
}

/** A custom plugin whose stored YAML doesn't load, so it runs nowhere until it's fixed. */
function brokenRow(c: DashCustom): AutomationRow {
  return {
    key: c.name, title: c.name, plugins: [c.name], state: "setup", plugin: null, custom: c,
    notes: [{ text: `Its YAML has problems, so it doesn't run: ${c.errors.join("; ")}.`, warn: true }],
    steps: [{ text: "Fix its YAML.", done: false, setup: true }],
  };
}

const rank = (r: AutomationRow) => {
  const i = ORDER.indexOf(r.key);
  return i < 0 ? ORDER.length : i;
};
/** Turning on deploy branches is what most people come here for, so it leads the rows that are off. */
const stateRank = (r: AutomationRow) => (r.key === "track" && r.state === "off" ? 2 : STATE_ORDER[r.state]);

/** Every row for one readable repo, in the order the page shows them. */
export function automationRows(repo: DashRepo, ctx: RowContext): AutomationRow[] {
  const rows = [
    trackRow(repo),
    ...repo.plugins.map((p) => pluginRow(repo, p, ctx)),
    ...repo.custom.filter((c) => !repo.plugins.some((p) => p.name === c.name)).map(brokenRow),
    ...repo.offered.map((o) => offeredRow(repo, o.name, o.description, o.connections, ctx)),
  ];
  return rows.map((r, i) => ({ r, i }))
    .sort((a, b) => stateRank(a.r) - stateRank(b.r) || rank(a.r) - rank(b.r) || a.r.title.localeCompare(b.r.title) || a.i - b.i)
    .map(({ r }) => r);
}

