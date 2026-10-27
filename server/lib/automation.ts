// The Automation settings page as data: one row per thing todo can do for a
// repo's items, each in exactly one state (on, off, needs setup, or done
// elsewhere today), with the evidence or the steps that go with it. Pure, so the
// page and the tests share it.
import { fieldsOf } from "./plugin-form";
import { secretVar } from "./plugin-summary";
import type { BridgeFacts, DashConnection, DashCustom, DashPlugin, DashRepo, HostConnection, RepoEntry, RunRow } from "./plugin-views";
import type { Attachment } from "./plugins/types";

export type RowState = "on" | "setup" | "elsewhere" | "off";
/** Who takes a step: a person on this page, or the server's admin. */
export type Who = "here" | "admin";

export interface Step {
  who: Who;
  text: string;
  /** The environment variables to set. */
  code?: string;
  done: boolean;
  /** Taken in this row's settings, which open from the step. */
  setup?: boolean;
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
}

export interface RowContext { project: string; bridge: BridgeFacts; host: HostConnection[] }

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
    title: "Add a button that hands the item to a Claude session",
    offers: "Items would get a button that sends the item to its Claude session in Watchtower, starting one if needed.",
  },
  rest: {
    title: "Add a button that sends a web request",
    offers: "Items would get a button that sends a request you define, filled in from the item.",
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

const SERVICE: Record<string, string> = { github: "GitHub", jira: "Jira", vercel: "Vercel", watchtower: "Watchtower" };
const service = (c: string) => SERVICE[c] ?? c;

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
      also: `The Jira bridge also moves tickets with ${n}, so both would send.`,
      link: { label: "General → Jira", href: settingsHref(ctx.project, "jira") },
    };
  }
  if (plugin === "jira-issue" && jira.polled) {
    const n = plural(jira.linked, "linked ticket");
    return {
      text: jira.linked ? `The Jira bridge does this today, for ${n}.` : "The Jira bridge does this today, once an item links a ticket.",
      also: `The Jira bridge also mirrors ${n}, so comments would come in twice.`,
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

// ── steps ─────────────────────────────────────────────────────────────────────
/** A server that can't see the repo on GitHub can't read its branches, commits or pull requests. */
function readableStep(repo: DashRepo): Step[] {
  if (repo.branches.visible !== false) return [];
  return [{ who: "admin", text: `Let the server's GitHub token read ${repo.repo}, so it can see the repo's branches, commits and pull requests.`,
            code: "GITHUB_TOKEN", done: false }];
}

/** What a connection still needs before the server can call it, and what it already has. */
function connectionSteps(name: string, conn: DashConnection | undefined, shipped: boolean, host: HostConnection[], canSetUp: boolean): Step[] {
  if (name === "github") return [];
  const label = service(name);
  if (conn?.origin === "repo") {
    if (conn.command) return [{ who: "here", text: `Point ${name} at a URL under Connections: the server never starts a command.`, done: false }];
    if (!conn.needsSecret) return [];
    return [conn.held ? { who: "here", text: `${label} credential stored.`, done: true }
                      : { who: "here", text: `Enter the ${label} credential.`, done: false, setup: canSetUp }];
  }
  const h = host.find((c) => c.name === name);
  if (!shipped) {
    return [{ who: "here", text: h ? `Add a connection named ${name} under Connections: only plugins that ship with todo use the server's.`
                                   : `Add a connection named ${name} under Connections.`, done: false }];
  }
  if (!h) {
    return [{ who: "admin", text: `Connect the server to ${label}: its address and a token.`,
              code: `TODO_PLUGIN_CONNECTIONS\n${secretVar(name)}`, done: false }];
  }
  if (!h.auth) return [{ who: "admin", text: `Server connected to ${label}.`, done: true }];
  return [h.held ? { who: "admin", text: `Server has a ${label} token.`, done: true }
                 : { who: "admin", text: `Give the server a ${label} token.`, code: secretVar(name), done: false }];
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
  if (!p.instances.length) return [{ who: "here", text: `${sentence(here)}.`, done: false, setup: true }];
  if (!enabled.length) return [{ who: "here", text: "Switch it on: it's switched off here.", done: false, setup: true }];
  if (!required.length) return [];
  const ready = enabled.find((i) => !missingSettings(p, i).length);
  if (ready) return [{ who: "here", text: `${sentence(here)}.`, done: true }];
  const missing = missingSettings(p, enabled[0]);
  const text = copy?.here ? `${sentence(copy.here)}: ${listed(missing)} ${verb(missing.length, "is", "are")} empty.` : `Fill in ${listed(missing)}.`;
  return [{ who: "here", text, done: false, setup: true }];
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
    const steps = readableStep(repo);
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
    steps: [...readableStep(repo), { who: "here", text: "Name the branches work deploys from, such as staging and main.", done: false, setup: true }],
  };
}

function offeredRow(repo: DashRepo, name: string, description: string | null, connections: string[], ctx: RowContext): AutomationRow {
  const copy = SHIPPED_COPY[name];
  const title = copy?.title ?? description ?? name;
  const toggle = { plugin: name, on: false };
  const elsewhere = doneElsewhere(name, ctx);
  if (elsewhere) {
    return { key: name, title, plugins: [name], state: "elsewhere", notes: [{ text: elsewhere.text, link: elsewhere.link }], steps: [], plugin: null, toggle };
  }
  const steps: Step[] = [];
  if (copy?.here) steps.push({ who: "here", text: `${sentence(copy.here)}, once it's switched on.`, done: false });
  for (const c of staticConnections(connections)) {
    steps.push(...connectionSteps(c, repo.connections.find((x) => x.name === c), true, ctx.host, false));
  }
  return { key: name, title, plugins: [name], state: "off", offers: copy?.offers ?? description ?? undefined, notes: [], steps, plugin: null, toggle };
}

function pluginRow(repo: DashRepo, p: DashPlugin, ctx: RowContext): AutomationRow {
  const copy = p.shipped ? SHIPPED_COPY[p.name] : undefined;
  const title = copy?.title ?? p.description?.replace(/\.$/, "") ?? p.name;
  const enabled = p.instances.filter((i) => i.enabled !== false);
  const steps: Step[] = [...instanceSteps(p, copy)];
  for (const c of repo.connections.filter((x) => x.usedBy.includes(p.name))) {
    steps.push(...connectionSteps(c.name, c, p.shipped, ctx.host, true));
  }
  const notes: Note[] = [];
  if (!p.shipped && !p.description) notes.push({ text: "A custom plugin of this repo; its YAML gives no description." });
  const elsewhere = p.shipped ? doneElsewhere(p.name, ctx) : null;
  if (elsewhere) notes.push({ text: elsewhere.also, link: elsewhere.link });
  const base = {
    key: p.name, title, plugins: [p.name], notes, plugin: p,
    ...(p.shipped && !p.always ? { toggle: { plugin: p.name, on: true } } : {}),
    ...(p.shipped ? {} : { custom: repo.custom.find((c) => c.name === p.name) }),
  };
  if (p.instances.length && !enabled.length) {
    return { ...base, state: "off", offers: copy?.offers ?? undefined, steps };
  }
  const open = steps.some((s) => !s.done);
  const stuck = enabled.length > 0 && enabled.every((i) => !i.server_runs);
  if (!open && stuck) notes.unshift({ text: `The server can't run it yet: ${enabled[0].server_runs_reason}.`, warn: true });
  if (open || stuck) return { ...base, state: "setup", steps, last: lastRun(p) };
  if (enabled.every((i) => i.dry_run)) notes.unshift({ text: "In test mode: it shows what it would do without doing it." });
  return { ...base, state: "on", steps, last: lastRun(p) };
}

/** A custom plugin whose stored YAML doesn't load, so it runs nowhere until it's fixed. */
function brokenRow(c: DashCustom): AutomationRow {
  return {
    key: c.name, title: c.name, plugins: [c.name], state: "setup", plugin: null, custom: c,
    notes: [{ text: `Its YAML has problems, so it doesn't run: ${c.errors.join("; ")}.`, warn: true }],
    steps: [{ who: "here", text: "Fix its YAML.", done: false, setup: true }],
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

export const WHO: Record<Who, string> = { here: "Here", admin: "Server admin" };
