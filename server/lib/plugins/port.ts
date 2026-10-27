// Converting a project's Actions and Jira triggers into stored plugin
// instances: watchtower Actions become watchtower-session instances, rest
// Actions rest instances, and each Jira trigger a jira-transition instance, in
// the order the triggers were listed so the first that fires still wins.
import type { Db } from "../db";
import { checkoutDir, repoAllowed, repoKey } from "../checkouts";
import { storedActions, type ActionDef } from "../actions/model";
import { outboundRules } from "../jira/rules";
import { ruleInstances } from "../jira/plugin-rules";
import { jiraConfig } from "../jira/config";
import { apiBase } from "../watchtower";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { blockedAddress, type AddressGuard } from "./connections";
import { hostSet, putGrants, putInstances, setShipped, storedInstances } from "./store";
import { CREDENTIAL_HEADER } from "./limits";
import { POST_REQUEST, type ConnectionDef, type HttpAuth, type InstanceDef, type Trigger } from "./types";

/** An Action template name and the plugin scope path it becomes. */
const SAME = ["item.id", "item.title", "item.status", "item.type", "item.priority", "item.app", "item.section", "item.repo",
              "item.repo_name", "item.developer", "item.dir"];
const RENAMED: Record<string, string> = { "item.from": "event.from", "item.qa": "item.qa_assignee", "item.branch": "item.branches.0" };
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

export const JIRA_TRANSITION = "jira-transition";
export const JIRA_ISSUE = "jira-issue";
export const WATCHTOWER = "watchtower-session";
export const REST = "rest";
export const actionInstanceId = (a: ActionDef) => `action-${a.id}`;

export interface PortPlan {
  project: string;
  /** The repos the instances go in: each a repo of the project's items that the project may use. */
  repos: string[];
  instances: Record<string, InstanceDef[]>;
  grants: Record<string, string[]>;
  /** Connections the instances need that neither the project nor the server has yet, to add on Settings → Automation. */
  connections: Record<string, ConnectionDef>;
  /** Connections with no secret yet, and what it holds, to give on Settings → Automation. */
  secrets: Record<string, string>;
  /** Private addresses, as host:port, someone has to let todo call on Settings → Automation. */
  allowHosts: string[];
  /** Where an instance can't do exactly what the old code did. */
  notes: string[];
}

interface Places { project: string; dir: string; repo: string }

/** An Action template in the plugin language: names mapped, project values filled in now, filters applied by the caller's rule. */
function translate(text: string, where: string, places: Places, notes: string[], filter: (value: string, f: string | undefined, name: string) => string): string {
  return text.replace(PLACEHOLDER, (_, name: string, f?: string) => {
    const literal = name === "project" ? places.project : name === "project.dir" ? places.dir : name === "project.repo" ? places.repo : null;
    if (literal !== null) {
      notes.push(`${where}: {{${name}}} is fixed as ${JSON.stringify(literal)}, its value now; it no longer follows the CLI's reports`);
      return f === "json" ? JSON.stringify(literal) : f === "url" ? encodeURIComponent(literal) : literal;
    }
    const path = SAME.includes(name) ? name : RENAMED[name];
    if (!path) {
      notes.push(`${where}: {{${name}}} has no plugin equivalent, so it fills as empty`);
      return f === "json" ? '""' : "";
    }
    return filter(`{{${path}}}`, f, name);
  });
}

/** A rest Action's body: JSON with each {{x|json}} as a typed value when it parses, else text. */
function restBody(a: ActionDef, places: Places, notes: string[]): { body?: unknown; text?: string } {
  if (!a.body || a.method === "GET" || a.method === "DELETE") return {};
  const where = `action ${a.id} body`;
  const lone: string[] = [];
  const marked = translate(a.body, where, places, notes, (path, f) => {
    if (f !== "json") return path;
    lone.push(path);
    return JSON.stringify(`\u0000${lone.length - 1}\u0000`);
  });
  try {
    const parsed = JSON.parse(marked);
    const unmark = (v: unknown): unknown => {
      if (typeof v === "string") {
        const m = v.match(/^\u0000(\d+)\u0000$/);
        if (m) return lone[Number(m[1])];
        if (v.includes("\u0000")) throw new Error("a json filter inside a string");
        return v;
      }
      if (Array.isArray(v)) return v.map(unmark);
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unmark(x)]));
      return v;
    };
    const body = unmark(parsed);
    if (!/"content-type"/i.test(JSON.stringify(Object.keys(a.headers ?? {})))) {
      notes.push(`${where}: sent as application/json; the Action sent it as text/plain`);
    }
    return { body };
  } catch {
    const text = translate(a.body, where, places, notes, (path, f, name) => {
      if (f) notes.push(`${where}: {{${name}|${f}}} isn't valid in a text body, so it fills unescaped`);
      return path;
    });
    return { text };
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function statusTriggers(a: ActionDef): Trigger[] {
  return a.auto.map((r) => ({ status: { from: r.from, to: r.to } }));
}

/** The secret a rest Action's credential header holds, as its connection takes it: a token, or user:password for basic. */
export function credentialSecret(a: ActionDef): string | null {
  const c = credentialOf(a);
  if (!c) return null;
  const value = a.headers![c.header];
  if (c.auth === "bearer") return value.replace(/^bearer\s+/i, "");
  if (c.auth === "basic") return Buffer.from(value.replace(/^basic\s+/i, ""), "base64").toString("utf8");
  return value;
}

/** The credential an Action's headers carry, as a connection's auth and the secret for it; the first one only. */
function credentialOf(a: ActionDef): { header: string; auth: HttpAuth; what: string } | null {
  for (const [name, value] of Object.entries(a.headers ?? {})) {
    if (!CREDENTIAL_HEADER.test(name) || value.includes("{{")) continue;
    if (/^authorization$/i.test(name)) {
      if (/^bearer\s/i.test(value)) return { header: name, auth: "bearer", what: `the bearer token in the Authorization header of action ${a.id}` };
      if (/^basic\s/i.test(value)) return { header: name, auth: "basic", what: `the user:password the Basic Authorization header of action ${a.id} encodes` };
    }
    return { header: name, auth: `header:${name}`, what: `the ${name} header of action ${a.id}` };
  }
  return null;
}

function restInstance(a: ActionDef, places: Places, plan: PortPlan): InstanceDef {
  const [, origin = "", rest = ""] = (a.url ?? "").match(/^(https?:\/\/[^/?#]+)(.*)$/i) ?? [];
  if (origin.includes("{{")) plan.notes.push(`action ${a.id}: its host is a template, which a connection can't be; it's kept as text`);
  const credential = credentialOf(a);
  const def: ConnectionDef = { http: { url: origin, ...(credential ? { auth: credential.auth } : {}) } };
  const base = `rest-${slug(origin.replace(/^https?:\/\//i, ""))}`;
  let connection = base;
  for (let n = 2; plan.connections[connection] && JSON.stringify(plan.connections[connection]) !== JSON.stringify(def); n++) connection = `${base}-${n}`;
  if (plan.connections[connection] && credential && plan.secrets[connection] !== credential.what) {
    plan.notes.push(`action ${a.id}: shares ${connection} with an Action whose ${credential.header} may differ; give it its own connection if so`);
  }
  plan.connections[connection] ??= def;
  if (credential) plan.secrets[connection] ??= credential.what;
  const where = `action ${a.id}`;
  const path = translate(rest.startsWith("/") ? rest : `/${rest}`, `${where} url`, places, plan.notes, (p, f, name) => {
    if (f === "json") plan.notes.push(`${where} url: {{${name}|json}} fills URL-encoded, without JSON quotes`);
    return p;
  });
  if (/\{\{[^}]*\}\}/.test(a.url ?? "") && !/\|\s*url/.test(a.url ?? "")) {
    plan.notes.push(`${where} url: every value is URL-encoded now; the Action put unfiltered values in as they were`);
  }
  const headers = Object.entries(a.headers ?? {}).filter(([k]) => k !== credential?.header).map(([k, v]) => {
    if (CREDENTIAL_HEADER.test(k)) plan.notes.push(`${where} header ${k}: a second credential stays in the instance's settings, readable as in the Action`);
    return `${k}: ${translate(v, `${where} header ${k}`, places, plan.notes, (p) => p)}`;
  });
  const settings: Record<string, unknown> = { connection, method: a.method ?? "POST", path, ...restBody(a, places, plan.notes) };
  if (headers.length) settings.headers = headers.join("\n");
  return { id: actionInstanceId(a), name: a.name, on: ["manual", ...statusTriggers(a)], settings };
}

function watchtowerInstance(a: ActionDef, places: Places, plan: PortPlan): InstanceDef {
  const where = `action ${a.id}`;
  const keep = (field: string) => (p: string, f: string | undefined, name: string) => {
    if (f) plan.notes.push(`${where} ${field}: the ${f} filter on {{${name}}} is dropped`);
    return p;
  };
  const api = apiBase(a.base ?? "");
  const have = plan.connections.watchtower as { http?: { url: string } } | undefined;
  if (have && have.http?.url !== api) plan.notes.push(`${where}: Watchtower at ${api}, but the watchtower connection already names ${have.http?.url}`);
  plan.connections.watchtower ??= { http: { url: api } };
  const settings: Record<string, unknown> = {
    dir: translate(a.dir ?? "", `${where} dir`, places, plan.notes, keep("dir")),
    prompt: translate(a.prompt ?? "", `${where} prompt`, places, plan.notes, keep("prompt")),
    link: a.base,
  };
  if (a.model) settings.model = a.model;
  if (a.resume) settings.resumePrompt = translate(a.resumePrompt ?? "", `${where} resume prompt`, places, plan.notes, keep("resume prompt"));
  return { id: actionInstanceId(a), name: a.name, on: ["manual", ...statusTriggers(a)], settings };
}

/** The repos a project's items name that it may run plugins for; `notes` gets the items no plugin runs for. */
export async function pluginRepos(d: Pick<Db, "query">, project: string, notes: string[]): Promise<string[]> {
  const rows = await d.query("select extra->>'repo' as repo, count(*)::int as n from items where project = $1 group by 1 order by 1", [project]);
  const out: string[] = [];
  for (const r of rows) {
    const key = repoKey(r.repo);
    if (!key) {
      notes.push(`${r.n} item(s) name no GitHub repo${r.repo ? ` (${r.repo})` : ""}, so no plugin runs for them`);
      continue;
    }
    if (out.includes(key)) continue;
    if (await repoAllowed(d, project, key)) out.push(key);
    else notes.push(`${r.n} item(s) are in ${key}, which this project may not run plugins for`);
  }
  return out;
}

/** Whether the server's guard would refuse `url` for a host connection: it is, or resolves to, a private address nobody allowed. */
async function refused(url: string, lookup: AddressGuard["lookup"], notes: string[], allowedHere: boolean): Promise<string | null> {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const entry = `${host}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
  const allowed = (process.env.TODO_PLUGIN_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => !h.includes("="));
  if (allowedHere || allowed.includes(host.toLowerCase()) || allowed.includes(entry.toLowerCase())) return null;
  try {
    const found = net.isIP(host) ? [{ address: host }] : await (lookup ?? ((h: string) => dnsLookup(h, { all: true })))(host);
    return found.some((a) => blockedAddress(a.address)) ? entry : null;
  } catch {
    notes.push(`${host} doesn't resolve here, so whether the server may reach it isn't known`);
    return null;
  }
}

export async function planPort(d: Db, project: string, opts: {
  repos?: string[]; lookup?: AddressGuard["lookup"];
  /** The kinds of Action to port, and whether the Jira bridge's jobs come too; everything by default. */
  kinds?: ActionDef["kind"][]; jira?: boolean;
} = {}): Promise<PortPlan> {
  const [p] = await d.query("select actions, jira_outbound from projects where key = $1", [project]);
  if (!p) throw new Error(`no project ${project}`);
  const plan: PortPlan = { project, repos: [], instances: {}, grants: {}, connections: {}, secrets: {}, allowHosts: [], notes: [] };
  plan.repos = opts.repos?.length ? opts.repos.map((r) => repoKey(r)).filter(Boolean) : await pluginRepos(d, project, plan.notes);
  const own = await checkoutDir(d, project, "", "");
  const places: Places = { project, dir: own.dir, repo: own.repo };

  for (const a of storedActions(p.actions).filter((x) => !opts.kinds || opts.kinds.includes(x.kind))) {
    if (a.runner === "cli") plan.notes.push(`action ${a.id} ran in the CLI; its instance runs on the server whenever the server can`);
    const inst = a.kind === "watchtower" ? watchtowerInstance(a, places, plan) : restInstance(a, places, plan);
    (plan.instances[a.kind === "watchtower" ? WATCHTOWER : REST] ??= []).push(inst);
  }

  const rules = opts.jira === false ? null : outboundRules(p.jira_outbound);
  if (rules?.triggers.length) {
    plan.instances[JIRA_TRANSITION] = ruleInstances({ writes: true, never: rules.never, triggers: rules.triggers });
    if (!rules.writes) plan.notes.push("Jira writes are off for this project: keep its jira-transition instances in dry-run at the cutover");
  }
  const [linked] = await d.query("select count(*)::int as n from jira_links where project = $1 and source = 'field'", [project]);
  if (opts.jira !== false && (rules || linked.n > 0)) {
    plan.instances[JIRA_ISSUE] = [{ id: "default", name: "Jira issues" }];
    plan.grants[JIRA_ISSUE] = [POST_REQUEST];
  }
  if (plan.instances[JIRA_TRANSITION] || plan.instances[JIRA_ISSUE]) {
    const cfg = jiraConfig();
    plan.connections.jira = { http: { url: cfg?.baseUrl ?? "https://<site>.atlassian.net", auth: "basic" } };
  }

  // The old Actions and Jira bridge keep running until the cutover, so a live instance would send twice.
  for (const list of Object.values(plan.instances)) for (const i of list) i.dry_run = true;

  // Only what the project and the server lack is left to add.
  const host = await hostSet(d, project, plan.repos[0] ?? "");
  for (const [name, def] of Object.entries(plan.connections)) {
    const has = host.connections[name];
    if (has) {
      const whose = host.page.includes(name) ? "project's" : "server's";
      if (JSON.stringify(has) !== JSON.stringify(def)) plan.notes.push(`the ${whose} ${name} connection is ${JSON.stringify(has)}, not ${JSON.stringify(def)}`);
      delete plan.connections[name];
    }
    const shape = has ?? def;
    const http = "http" in shape ? shape.http : undefined;
    if (!http?.auth || host.secrets[name]) delete plan.secrets[name];
    else plan.secrets[name] ??= name === "jira" ? "the Jira email and API token" : `the ${name} credential`;
    const entry = http?.url && !http.url.includes("<") ? await refused(http.url, opts.lookup, plan.notes, Object.hasOwn(host.privateOk, name)) : null;
    if (entry) plan.allowHosts.push(entry);
  }
  return plan;
}

/** An instance as it prints: each credential header's value masked. */
function shown(i: InstanceDef): InstanceDef {
  const h = i.settings?.headers;
  if (typeof h !== "string") return i;
  const lines = h.split("\n").map((l) => {
    const at = l.indexOf(":");
    return at > 0 && CREDENTIAL_HEADER.test(l.slice(0, at).trim()) ? `${l.slice(0, at)}: ***` : l;
  });
  return { ...i, settings: { ...i.settings, headers: lines.join("\n") } };
}

export function describePlan(plan: PortPlan): string {
  const lines = [`project ${plan.project}: instances for ${plan.repos.join(", ") || "(no repo)"}`];
  for (const [plugin, list] of Object.entries(plan.instances)) {
    lines.push(`  ${plugin}:`);
    for (const i of list) lines.push(`    ${JSON.stringify(shown(i))}`);
  }
  for (const [plugin, caps] of Object.entries(plan.grants)) lines.push(`  grant ${plugin}: ${caps.join(", ")}`);
  if (Object.keys(plan.instances).length) lines.push(`--write switches on, in each repo: ${Object.keys(plan.instances).join(", ")}`);
  const page = "on Settings → Automation, under This project's connections";
  for (const [name, def] of Object.entries(plan.connections)) lines.push(`add ${name} ${page}: ${JSON.stringify(def)}`);
  for (const [name, what] of Object.entries(plan.secrets)) lines.push(`give ${name} ${what} ${page}`);
  if (Object.keys(plan.secrets).length) lines.push("(the port never prints a secret: copy each from the Action it names)");
  for (const entry of plan.allowHosts) lines.push(`allow todo to call ${entry}, a private address, ${page}`);
  for (const n of [...new Set(plan.notes)]) lines.push(`note: ${n}`);
  lines.push("every instance is stored in dry-run, since the Actions and Jira bridge it replaces still run. The cutover: turn those off,",
             "then clear dry_run on each instance (Test mode, under Settings → Automation), which makes it send.");
  return lines.join("\n");
}

/** Switch the plan's plugins on in each repo and store its instances and grants there, beside instances already there. */
export async function writePlan(d: Db, plan: PortPlan, by: string): Promise<string[]> {
  const problems: string[] = [];
  for (const repo of plan.repos) {
    const stored = await storedInstances(d, plan.project, repo, { secrets: true });
    for (const [plugin, list] of Object.entries(plan.instances)) {
      const kept = (stored[plugin] ?? []).filter((i) => !list.some((x) => x.id === i.id));
      try {
        await setShipped(d, plan.project, repo, plugin, true, by);
        await putInstances(d, plan.project, repo, plugin, [...kept, ...list], by);
        if (plan.grants[plugin]) await putGrants(d, plan.project, repo, plugin, plan.grants[plugin], by);
      } catch (e) {
        problems.push(`${repo} ${plugin}: ${(e as Error).message}`);
      }
    }
  }
  return problems;
}
