// A project's Actions: what they are, how they're checked, and how a template
// is filled from an item. Mirrors todo/actions.py in the CLI.
import { BASE } from "../base";
import type { Problem } from "../jira/rules";

export const ACTION_KINDS = ["rest", "watchtower"] as const;
export const RUNNERS = ["server", "cli"] as const;
export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
export const ANY_STATUS = "*";
export const DEFAULT_PROMPT = "/todo {{item.id}}";
/** Watchtower takes an initialPrompt of one line up to this long. */
export const INITIAL_PROMPT_MAX = 200;

export interface AutoRule { from: string; to: string }

export interface ActionDef {
  id: string;
  name: string;
  kind: (typeof ACTION_KINDS)[number];
  runner: (typeof RUNNERS)[number];
  auto: AutoRule[];
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  base?: string;
  dir?: string;
  prompt?: string;
  model?: string;
}

export const TEMPLATE_NAMES = [
  "item.id", "item.title", "item.status", "item.from", "item.type", "item.priority", "item.app", "item.section",
  "item.repo", "item.repo_name", "item.branch", "item.developer", "item.qa", "item.url", "project", "actor",
];
const FILTERS = ["json", "url"];
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g;

/** The template fields of an Action, by name, for checking and filling. */
function templates(a: Partial<ActionDef>): [string, string][] {
  const out: [string, string][] = [];
  if (a.kind === "rest") {
    out.push(["url", a.url ?? ""], ["body", a.body ?? ""]);
    for (const [k, v] of Object.entries(a.headers ?? {})) out.push([`header ${k}`, v]);
  } else {
    out.push(["dir", a.dir ?? ""], ["prompt", a.prompt ?? ""]);
  }
  return out;
}

export function templateProblems(where: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    if (!TEMPLATE_NAMES.includes(m[1])) out.push(`${where} uses {{${m[1]}}}, which isn't a template name.`);
    if (m[2] && !FILTERS.includes(m[2])) out.push(`${where} uses the filter ${m[2]}; filters are ${FILTERS.join(" and ")}.`);
  }
  return out;
}

/** Trim an editor's draft into the stored shape. */
export function cleanAction(a: Partial<ActionDef>): ActionDef {
  const kind = a.kind === "watchtower" ? "watchtower" : "rest";
  const base: ActionDef = {
    id: String(a.id ?? "").trim(), name: String(a.name ?? "").trim(), kind,
    runner: a.runner === "cli" ? "cli" : "server",
    auto: (a.auto ?? []).map((r) => ({ from: String(r.from ?? "").trim() || ANY_STATUS, to: String(r.to ?? "").trim() })),
  };
  if (kind === "rest") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.headers ?? {})) if (k.trim()) headers[k.trim()] = String(v);
    return { ...base, method: String(a.method ?? "POST").toUpperCase(), url: String(a.url ?? "").trim(), headers, body: a.body ?? "" };
  }
  return { ...base, base: String(a.base ?? "").trim().replace(/\/+$/, ""), dir: String(a.dir ?? "").trim(),
           prompt: String(a.prompt ?? "").trim() || DEFAULT_PROMPT, ...(a.model?.trim() ? { model: a.model.trim() } : {}) };
}

export function validateActions(actions: ActionDef[], statuses: readonly string[]): Problem[] {
  const problems: Problem[] = [];
  const error = (message: string) => problems.push({ level: "error", message });
  const ids = new Set<string>();
  for (const a of actions) {
    const label = a.name || a.id || "An action";
    if (!/^[a-z0-9][a-z0-9-]*$/.test(a.id)) error(`${label} needs an id of lowercase letters, digits and dashes.`);
    else if (ids.has(a.id)) error(`Two actions share the id ${a.id}.`);
    ids.add(a.id);
    if (!a.name) error(`${a.id || "An action"} has no name.`);
    if (a.kind === "rest") {
      if (!METHODS.includes(a.method ?? "")) error(`${label} has the method ${a.method}; use one of ${METHODS.join(", ")}.`);
      if (!/^https?:\/\//i.test(a.url ?? "")) error(`${label} needs a URL starting with http:// or https://.`);
    } else {
      if (!/^https?:\/\//i.test(a.base ?? "")) error(`${label} needs Watchtower's address, e.g. http://leaf-rain:10011.`);
      if (!a.dir) error(`${label} needs the folder to start the session in.`);
    }
    for (const [where, text] of templates(a)) for (const m of templateProblems(`${label}'s ${where}`, text)) error(m);
    const seen = new Set<string>();
    for (const r of a.auto) {
      if (r.from !== ANY_STATUS && !statuses.includes(r.from)) error(`${label} fires from ${r.from}, which isn't a todo status.`);
      if (!statuses.includes(r.to)) error(`${label} fires on a move to ${r.to || "nothing"}, which isn't a todo status.`);
      if (seen.has(`${r.from}>${r.to}`)) error(`${label} lists ${r.from} → ${r.to} twice.`);
      seen.add(`${r.from}>${r.to}`);
    }
  }
  return problems;
}

/** Stored Actions, read leniently: a malformed entry is dropped. */
export function storedActions(raw: unknown): ActionDef[] {
  return Array.isArray(raw) ? raw.filter((a) => a && typeof a === "object" && a.id).map((a) => cleanAction(a)) : [];
}

export function firesOn(a: ActionDef, from: string, to: string): boolean {
  return from !== to && a.auto.some((r) => r.to === to && (r.from === ANY_STATUS || r.from === from));
}

export type Vars = Record<string, string>;

export interface ItemLike {
  id: string; title: string; status: string; type?: string | null; priority?: string | null;
  developer?: string | null; qa_assignee?: string | null; extra?: Record<string, any> | null;
}

export function itemVars(project: string, it: ItemLike, from: string, actor: string, publicUrl = ""): Vars {
  const x = it.extra ?? {};
  const repo = String(x.repo ?? "");
  return {
    "item.id": it.id, "item.title": it.title, "item.status": it.status, "item.from": from,
    "item.type": it.type ?? "", "item.priority": it.priority ?? "",
    "item.app": String(x.app ?? ""), "item.section": String(x.section ?? ""),
    "item.repo": repo, "item.repo_name": repo.split("/").pop() ?? "", "item.branch": String(x.branch ?? ""),
    "item.developer": it.developer ?? "", "item.qa": it.qa_assignee ?? "",
    "item.url": publicUrl ? `${publicUrl.replace(/\/+$/, "")}${BASE}/p/${project}/i/${it.id}` : "",
    project, actor,
  };
}

export function fill(text: string, vars: Vars): string {
  return text.replace(PLACEHOLDER, (_, name: string, filter?: string) => {
    const v = vars[name] ?? "";
    return filter === "json" ? JSON.stringify(v) : filter === "url" ? encodeURIComponent(v) : v;
  });
}

/** What a run sends, fixed when it's queued so a later edit to the item can't change it. */
export type Request =
  | { kind: "rest"; method: string; url: string; headers: Record<string, string>; body: string | null }
  | { kind: "watchtower"; base: string; dir: string; name: string; prompt: string; model?: string };

export function render(a: ActionDef, vars: Vars): Request {
  if (a.kind === "rest") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.headers ?? {})) headers[k] = fill(v, vars);
    const body = a.method === "GET" || a.method === "DELETE" || !a.body ? null : fill(a.body, vars);
    return { kind: "rest", method: a.method ?? "POST", url: fill(a.url ?? "", vars), headers, body };
  }
  return { kind: "watchtower", base: a.base ?? "", dir: fill(a.dir ?? "", vars), name: `todo: ${vars["item.id"]}`,
           prompt: fill(a.prompt || DEFAULT_PROMPT, vars), ...(a.model ? { model: a.model } : {}) };
}
