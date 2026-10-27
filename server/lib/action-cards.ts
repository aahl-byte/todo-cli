// watchtower-session's and rest's instances as the General tab's Actions lay
// them out: a card per button, its settings as the Action's fields, and its
// status moves as "fires on its own" rows beside the button. Pure, so the page
// and the tests share it.
import { ANY_STATUS, DEFAULT_PROMPT, METHODS, type AutoRule } from "./actions/model";
import type { InstanceDef, Trigger } from "./plugins/types";

export const WATCHTOWER = "watchtower-session";
export const REST = "rest";
export type CardPlugin = typeof WATCHTOWER | typeof REST;

export const MODELS = ["opus", "sonnet", "haiku"];
export const BODYLESS = ["GET", "DELETE"];

export interface ActionCard {
  /** Stable across edits, for React. */
  key: string;
  /** The instance id it saves under; null for a new card. */
  id: string | null;
  /** The button's name. */
  name: string;
  dryRun: boolean;
  auto: AutoRule[];
  /** Watchtower: start a new session, or resume the item's last one first. */
  resume: boolean;
  /** The card's fields by setting key: dir, prompt, resumePrompt, model, link; or connection, method, path, headers, body. */
  values: Record<string, string>;
  /** The instance as loaded, for what the card doesn't show: switched off, git triggers, settings it doesn't name. */
  loaded: InstanceDef | null;
}

const FIELDS: Record<CardPlugin, string[]> = {
  [WATCHTOWER]: ["dir", "prompt", "resumePrompt", "model", "link"],
  [REST]: ["connection", "method", "path", "headers", "body", "text"],
};

let counter = 0;
const nextKey = () => `c${++counter}`;
const text = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));

function triggersOf(inst: InstanceDef): Trigger[] {
  return inst.on ?? ["manual"];
}

export function cardOf(plugin: CardPlugin, inst: InstanceDef): ActionCard {
  const s = inst.settings ?? {};
  const auto = triggersOf(inst).filter((t): t is Exclude<Trigger, string> => typeof t === "object")
    .map((t) => ({ from: t.status.from ?? ANY_STATUS, to: t.status.to ?? ANY_STATUS }));
  const values: Record<string, string> = plugin === WATCHTOWER
    ? { dir: text(s.dir), prompt: text(s.prompt), resumePrompt: text(s.resumePrompt), model: text(s.model), link: text(s.link) }
    : { connection: text(s.connection), method: text(s.method) || "POST", path: text(s.path), headers: text(s.headers),
        body: s.body !== undefined && s.body !== null && s.body !== "" ? text(s.body) : text(s.text) };
  return { key: nextKey(), id: inst.id, name: inst.button || inst.name || inst.id, dryRun: !!inst.dry_run, auto,
           resume: plugin === WATCHTOWER && !!text(s.resumePrompt).trim(), values, loaded: inst };
}

export const cardsOf = (plugin: CardPlugin, instances: InstanceDef[]) => instances.map((i) => cardOf(plugin, i));

export function blankCard(plugin: CardPlugin): ActionCard {
  return { key: nextKey(), id: null, name: "", dryRun: false, auto: [], resume: false, loaded: null,
           values: plugin === WATCHTOWER ? { dir: "", prompt: DEFAULT_PROMPT, resumePrompt: "", model: "", link: "" }
             : { connection: "", method: "POST", path: "", headers: "", body: "" } };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function unique(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

export interface SavedCards { instances: InstanceDef[]; errors: string[]; warnings: string[] }

/** The instances a set of cards saves as, or what stops them saving. */
export function instancesOf(plugin: CardPlugin, cards: ActionCard[]): SavedCards {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taken = new Set(cards.map((c) => c.id).filter((id): id is string => !!id));
  const instances = cards.map((c) => {
    const label = c.name.trim() || "A button";
    if (!c.name.trim()) errors.push("A button has no name.");
    const id = c.id ?? unique(slug(c.name) || "button", taken);
    const kept: Trigger[] = c.loaded ? triggersOf(c.loaded).filter((t) => typeof t === "string") : ["manual"];
    const seen = new Set<string>();
    for (const r of c.auto) {
      if (!r.to) errors.push(`${label} fires on a move to nothing; pick a status.`);
      if (seen.has(`${r.from}>${r.to}`)) errors.push(`${label} lists ${r.from} → ${r.to} twice.`);
      if (r.from === ANY_STATUS && r.to === ANY_STATUS) warnings.push(`${label} fires on every move.`);
      seen.add(`${r.from}>${r.to}`);
    }
    const status: Trigger[] = c.auto.filter((r) => r.to).map((r) => ({
      status: { ...(r.from !== ANY_STATUS ? { from: r.from } : {}), ...(r.to !== ANY_STATUS ? { to: r.to } : {}) } }));
    const settings: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c.loaded?.settings ?? {})) if (!FIELDS[plugin].includes(k)) settings[k] = v;
    const set = (k: string, v: string) => { if (v.trim()) settings[k] = k === "body" || k === "headers" || k.endsWith("rompt") ? v : v.trim(); };
    if (plugin === WATCHTOWER) {
      set("dir", c.values.dir ?? "");
      set("prompt", c.values.prompt || DEFAULT_PROMPT);
      if (c.resume) set("resumePrompt", c.values.resumePrompt || DEFAULT_PROMPT);
      if (c.values.model && !MODELS.includes(c.values.model)) errors.push(`${label}'s model is one of ${MODELS.join(", ")}, or the default.`);
      set("model", c.values.model ?? "");
      set("link", c.values.link ?? "");
    } else {
      const method = c.values.method || "POST";
      if (!METHODS.includes(method)) errors.push(`${label} has the method ${method}; use one of ${METHODS.join(", ")}.`);
      if (!c.values.connection?.trim()) errors.push(`${label} needs a connection: where the request goes.`);
      set("connection", c.values.connection ?? "");
      settings.method = method;
      set("path", c.values.path ?? "");
      set("headers", c.values.headers ?? "");
      if (!BODYLESS.includes(method)) set("body", c.values.body ?? "");
    }
    const def: InstanceDef = { id, name: c.name.trim() || id, on: [...kept, ...status] };
    if (c.loaded?.enabled === false) def.enabled = false;
    if (c.dryRun) def.dry_run = true;
    if (Object.keys(settings).length) def.settings = settings;
    return def;
  });
  return { instances, errors: [...new Set(errors)], warnings };
}

/** Template names a plugin's settings fill from the item, for the reference beside the cards. */
export const PLUGIN_TEMPLATE_GROUPS: { label: string; names: [string, string][] }[] = [
  { label: "Item", names: [
    ["item.id", "the item's id, e.g. fix-login"],
    ["item.title", "its title"],
    ["item.type", "feature, bug, refactor, …"],
    ["item.priority", "low, medium, high, urgent"],
    ["item.app", "its app"],
    ["item.section", "its section"],
  ] },
  { label: "Status", names: [
    ["item.status", "the status it has now (after the move, for a status move)"],
    ["event.from", "the status it moved from; empty for a button press"],
  ] },
  { label: "Code", names: [
    ["item.repo", "its repo, e.g. owner/name"],
    ["item.repo_name", "the repo's last part, e.g. name"],
    ["item.branches.0", "its first branch"],
    ["item.dir", "the folder its repo is checked out in, as the todo CLI last reported it"],
  ] },
  { label: "People", names: [
    ["item.developer", "the developer's handle"],
    ["item.qa_assignee", "the QA assignee's handle"],
  ] },
];
