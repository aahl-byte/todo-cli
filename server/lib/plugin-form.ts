// The Plugins settings form as data: a field per `settings:` entry, drafts of a
// plugin's instances as the dashboard edits them, and the instance list those
// drafts save as. Pure, so the page and the tests share it.
import type { Attachment, InstanceDef, SettingDef, Trigger } from "./plugins/types";

export const ANY = "*";
export const TRIGGER_KINDS = ["status", "push", "pr", "deployment", "manual"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
const INSTANCE_ID = /^[A-Za-z0-9][\w.-]*$/;

// ── fields ────────────────────────────────────────────────────────────────────
export type Control = "text" | "textarea" | "select" | "checkbox" | "number" | "list" | "password";

export interface Field {
  key: string;
  label: string;
  type: SettingDef["type"];
  control: Control;
  scope: "plugin" | "instance";
  /** The choices of a choice with fixed options. */
  options?: string[];
  /** Shown faintly while the field is empty: the default the plugin falls back to. */
  placeholder?: string;
  /** A line under the field, such as where a choice's options come from. */
  note?: string;
  /** The instance is skipped while this is empty. */
  required: boolean;
}

const CONTROL: Record<SettingDef["type"], Control> = {
  text: "text", "long-text": "textarea", choice: "select", toggle: "checkbox", number: "number", list: "list", secret: "password",
};

const shown = (v: unknown) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

export function fieldOf(key: string, def: SettingDef): Field {
  const live = def.type === "choice" && !def.options && !!def.options_from;
  const field: Field = {
    key, label: def.label || key, type: def.type, control: live ? "text" : CONTROL[def.type] ?? "text",
    scope: def.scope === "plugin" ? "plugin" : "instance",
    required: !def.optional && (def.default === undefined || def.default === null || def.default === "") && def.type !== "toggle" && def.type !== "list",
  };
  if (def.type === "choice" && def.options) field.options = def.options;
  if (live) field.note = `Its options come from the connection's ${def.options_from!.tool} tool, which the dashboard doesn't list; type the value.`;
  if (def.type === "list") field.note = "One per line.";
  if (def.default !== undefined && def.type !== "toggle" && def.type !== "secret") field.placeholder = `default: ${shown(def.default)}`;
  return field;
}

/** Every setting as a field, in the order the plugin declares them. */
export function fieldsOf(settings: Record<string, SettingDef> | undefined): Field[] {
  return Object.entries(settings ?? {}).map(([k, def]) => fieldOf(k, def));
}

// ── values ────────────────────────────────────────────────────────────────────
/** A secret as the form holds it: never its text once stored, only whether there is one. */
export type SecretDraft =
  | { state: "unset" }
  | { state: "stored" }
  | { state: "new"; value: string }
  | { state: "cleared" };

export type Value = string | boolean | SecretDraft;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isSecret = (v: Value): v is SecretDraft => isMap(v) && "state" in v;
const isSetMarker = (v: unknown) => isMap(v) && v.set === true;

/** What the form shows for a stored value. */
export function draftValue(def: SettingDef, stored: unknown): Value {
  switch (def.type) {
    case "secret": return isSetMarker(stored) || (typeof stored === "string" && stored !== "") ? { state: "stored" } : { state: "unset" };
    case "toggle": return typeof stored === "boolean" ? stored : def.default === true;
    case "list": return Array.isArray(stored) ? stored.map(String).join("\n") : "";
    default: return stored === undefined || stored === null ? "" : typeof stored === "object" ? JSON.stringify(stored) : String(stored);
  }
}

export interface Stored { value?: unknown; error?: string }

/** What the form saves for a value; no `value` leaves the setting to the plugin's default. `stored` is what it had. */
export function storedValue(def: SettingDef, label: string, draft: Value, stored: unknown): Stored {
  if (def.type === "secret") {
    const s: SecretDraft = isSecret(draft) ? draft : { state: "unset" };
    if (s.state === "new") return s.value ? { value: s.value } : isSetMarker(stored) ? { value: { set: true } } : {};
    if (s.state === "stored") return { value: { set: true } };
    if (s.state === "cleared") return isSetMarker(stored) ? { value: null } : {};
    return {};
  }
  if (def.type === "toggle") {
    const on = draft === true;
    return stored === undefined && on === (def.default === true) ? {} : { value: on };
  }
  const text = typeof draft === "string" ? draft : "";
  if (def.type === "list") {
    const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
    if (list.length) return { value: list };
    return Array.isArray(def.default) && def.default.length ? { value: [] } : {};
  }
  if (!text.trim()) return {};
  if (def.type === "number") {
    const n = Number(text.trim());
    return Number.isFinite(n) ? { value: n } : { error: `${label} must be a number` };
  }
  if (def.type === "choice" && def.options && !def.options.includes(text) && text !== stored) {
    return { error: `${label} must be one of ${def.options.join(", ")}` };
  }
  return { value: def.type === "long-text" ? text : text.trim() };
}

// ── triggers ──────────────────────────────────────────────────────────────────
export interface TriggerDraft { kind: TriggerKind; from: string; to: string }

export function draftTrigger(t: Trigger): TriggerDraft {
  if (typeof t === "object") return { kind: "status", from: t.status.from ?? ANY, to: t.status.to ?? ANY };
  return { kind: t, from: ANY, to: ANY };
}

export function storedTrigger(t: TriggerDraft): Trigger {
  if (t.kind !== "status") return t.kind;
  const status: { from?: string; to?: string } = {};
  if (t.from && t.from !== ANY) status.from = t.from;
  if (t.to && t.to !== ANY) status.to = t.to;
  return { status };
}

/** A trigger as people read it: `review`, `* → review`, `push`. */
export function describeTrigger(t: Trigger): string {
  if (typeof t === "string") return t;
  const { from, to } = t.status;
  if (!from || from === ANY) return to && to !== ANY ? `→ ${to}` : "any status move";
  return `${from} → ${to && to !== ANY ? to : ANY}`;
}

// ── instances ─────────────────────────────────────────────────────────────────
export interface InstanceDraft {
  /** Stable across edits, for React. */
  key: string;
  id: string;
  name: string;
  enabled: boolean;
  dryRun: boolean;
  button: string;
  /** Use the plugin's own triggers. */
  inherit: boolean;
  triggers: TriggerDraft[];
  settings: Record<string, Value>;
  /** The repo file declares it (or it's the plugin's automatic default), so removing it only switches it off. */
  declared: boolean;
  /** The repo file's version of a declared instance, which a save overrides only where the draft differs. */
  base?: InstanceDef;
  /** The id it was stored under, whose secrets the server keeps; null for a new or duplicated instance. */
  storedAs: string | null;
  /** Its settings as they were loaded, secrets masked. */
  loaded: Record<string, unknown>;
}

export interface PluginShape { settings?: Record<string, SettingDef>; on?: Trigger[] }

export interface PluginDraft {
  instances: InstanceDraft[];
  /** Values of `scope: plugin` settings, shown once and saved into every instance. */
  shared: Record<string, Value>;
}

let counter = 0;
const nextKey = () => `d${++counter}`;

export function draftInstance(plugin: PluginShape, inst: InstanceDef, opts: { declared: boolean; base?: InstanceDef; stored: boolean }): InstanceDraft {
  const settings: Record<string, Value> = {};
  for (const [k, def] of Object.entries(plugin.settings ?? {})) {
    if (def.scope !== "plugin") settings[k] = draftValue(def, inst.settings?.[k]);
  }
  return {
    key: nextKey(), id: inst.id, name: inst.name ?? inst.id, enabled: inst.enabled !== false, dryRun: !!inst.dry_run, button: inst.button ?? "",
    inherit: inst.on === undefined, triggers: (inst.on ?? plugin.on ?? []).map(draftTrigger), settings,
    declared: opts.declared, base: opts.base, storedAs: opts.stored || opts.declared ? inst.id : null, loaded: { ...(inst.settings ?? {}) },
  };
}

/** Drafts for a plugin's instances. `declared` maps each id the repo file declares (or the automatic default) to its definition there. */
export function draftPlugin(plugin: PluginShape, instances: InstanceDef[], declared: Record<string, InstanceDef>, storedIds: string[]): PluginDraft {
  const shared: Record<string, Value> = {};
  for (const [k, def] of Object.entries(plugin.settings ?? {})) {
    if (def.scope !== "plugin") continue;
    const withValue = instances.find((i) => i.settings?.[k] !== undefined && i.settings?.[k] !== null);
    shared[k] = draftValue(def, withValue?.settings?.[k]);
  }
  return {
    instances: instances.map((i) => draftInstance(plugin, i, { declared: i.id in declared, base: declared[i.id], stored: storedIds.includes(i.id) })),
    shared,
  };
}

function uniqueId(base: string, taken: string[]): string {
  const stem = base.replace(/[^\w.-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "instance";
  if (!taken.includes(stem)) return stem;
  for (let n = 2; ; n++) if (!taken.includes(`${stem}-${n}`)) return `${stem}-${n}`;
}

export function addInstance(plugin: PluginShape, draft: PluginDraft): PluginDraft {
  const id = uniqueId("instance", draft.instances.map((i) => i.id));
  const inst = draftInstance(plugin, { id, name: id }, { declared: false, stored: false });
  return { ...draft, instances: [...draft.instances, inst] };
}

/** A copy that saves as a new instance. Its secrets aren't copied: the server keeps them under the original's id. */
export function duplicateInstance(plugin: PluginShape, draft: PluginDraft, key: string): PluginDraft {
  const i = draft.instances.findIndex((x) => x.key === key);
  if (i < 0) return draft;
  const src = draft.instances[i];
  const settings = { ...src.settings };
  for (const [k, def] of Object.entries(plugin.settings ?? {})) if (def.type === "secret" && k in settings) settings[k] = { state: "unset" };
  const copy: InstanceDraft = {
    ...src, key: nextKey(), id: uniqueId(`${src.id}-copy`, draft.instances.map((x) => x.id)), name: `${src.name} (copy)`,
    settings, triggers: src.triggers.map((t) => ({ ...t })), declared: false, base: undefined, storedAs: null, loaded: {},
  };
  return { ...draft, instances: [...draft.instances.slice(0, i + 1), copy, ...draft.instances.slice(i + 1)] };
}

/** Drop an instance the dashboard added; one the repo file declares is switched off instead, since it would come back. */
export function removeInstance(draft: PluginDraft, key: string): PluginDraft {
  return {
    ...draft,
    instances: draft.instances.flatMap((x) => (x.key !== key ? [x] : x.declared ? [{ ...x, enabled: false }] : [])),
  };
}

/** Whether an instance can move: declared ones keep the repo file's order, ahead of the ones the dashboard added. */
export function canMove(draft: PluginDraft, key: string, by: -1 | 1): boolean {
  const i = draft.instances.findIndex((x) => x.key === key);
  const j = i + by;
  return i >= 0 && j >= 0 && j < draft.instances.length && !draft.instances[i].declared && !draft.instances[j].declared;
}

export function moveInstance(draft: PluginDraft, key: string, by: -1 | 1): PluginDraft {
  if (!canMove(draft, key, by)) return draft;
  const list = [...draft.instances];
  const i = list.findIndex((x) => x.key === key);
  [list[i], list[i + by]] = [list[i + by], list[i]];
  return { ...draft, instances: list };
}

export function editInstance(draft: PluginDraft, key: string, patch: Partial<InstanceDraft>): PluginDraft {
  return { ...draft, instances: draft.instances.map((x) => (x.key === key ? { ...x, ...patch } : x)) };
}

// ── saving ────────────────────────────────────────────────────────────────────
export interface Saved { instances: InstanceDef[]; errors: string[]; warnings: string[] }

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The full definition a draft stands for, or the errors that stop it saving. */
function fullDef(plugin: PluginShape, draft: PluginDraft, x: InstanceDraft, errors: string[]): InstanceDef {
  const settings: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(plugin.settings ?? {})) {
    const value = def.scope === "plugin" ? draft.shared[k] : x.settings[k];
    // A shared secret kept as stored means "keep" only where this instance has one.
    const stored = x.storedAs === x.id ? x.loaded[k] : undefined;
    const out = storedValue(def, def.label || k, value ?? draftValue(def, undefined), stored);
    if (out.error) errors.push(`${x.id}: ${out.error}`);
    else if (out.value !== undefined) settings[k] = out.value;
  }
  // Settings the plugin no longer declares are kept as they were.
  for (const [k, v] of Object.entries(x.loaded)) if (!(k in (plugin.settings ?? {})) && !(k in settings)) settings[k] = v;
  const def: InstanceDef = { id: x.id, name: x.name.trim() || x.id };
  if (!x.enabled) def.enabled = false;
  if (!x.inherit) def.on = x.triggers.map(storedTrigger);
  if (x.button.trim()) def.button = x.button.trim();
  if (x.dryRun) def.dry_run = true;
  if (Object.keys(settings).length) def.settings = settings;
  return def;
}

/** Only what differs from the repo file's version, or null when nothing does. */
function override(full: InstanceDef, base: InstanceDef): InstanceDef | null {
  const out: InstanceDef = { id: full.id, name: full.name };
  let differs = !same(full.name, base.name);
  if ((full.enabled !== false) !== (base.enabled !== false)) { out.enabled = full.enabled !== false; differs = true; }
  if (!same(full.on, base.on)) { if (full.on !== undefined) out.on = full.on; differs = true; }
  if (!same(full.button, base.button)) { out.button = full.button ?? ""; differs = true; }
  if (!!full.dry_run !== !!base.dry_run) { out.dry_run = !!full.dry_run; differs = true; }
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full.settings ?? {})) if (!same(v, base.settings?.[k])) settings[k] = v;
  for (const k of Object.keys(base.settings ?? {})) if (!(k in (full.settings ?? {}))) settings[k] = null;
  if (Object.keys(settings).length) { out.settings = settings; differs = true; }
  return differs ? out : null;
}

/** The instance list a PUT stores: every instance the dashboard added, and overrides of declared ones where they differ. */
export function savedInstances(plugin: PluginShape, draft: PluginDraft): Saved {
  const errors: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const instances: InstanceDef[] = [];
  for (const x of draft.instances) {
    if (!INSTANCE_ID.test(x.id)) errors.push(`"${x.id}" isn't an instance id: letters, digits, . _ and -, starting with a letter or digit`);
    else if (ids.has(x.id)) errors.push(`two instances have the id ${x.id}`);
    ids.add(x.id);
    if (!x.inherit && x.triggers.some((t) => t.kind === "status" && (!t.to || t.to === ANY) && (!t.from || t.from === ANY))) {
      warnings.push(`${x.id}: a status trigger with * on both sides fires on every move`);
    }
    const full = fullDef(plugin, draft, x, errors);
    if (x.storedAs && x.storedAs !== x.id && Object.values(x.loaded).some(isSetMarker)) {
      warnings.push(`${x.id}: its secrets are stored under ${x.storedAs}, so a new id needs them entered again`);
    }
    if (x.enabled) {
      for (const f of fieldsOf(plugin.settings)) {
        if (f.required && full.settings?.[f.key] === undefined) warnings.push(`${x.id}: ${f.label} is empty, so it's skipped until it has a value`);
      }
    }
    if (!x.declared) instances.push(full);
    else {
      const o = override(full, x.base ?? { id: x.id, name: x.id });
      if (o) instances.push(o);
    }
  }
  return { instances, errors, warnings };
}

// ── run log ───────────────────────────────────────────────────────────────────
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const KIND_NAME: Record<Attachment["kind"], string> = { link: "link", edge: "edge", doc: "doc", log: "log line", request: "request" };

/** "2 links, 1 log line". */
export function attachedSummary(attached: Attachment[]): string {
  const n = new Map<Attachment["kind"], number>();
  for (const a of attached) n.set(a.kind, (n.get(a.kind) ?? 0) + 1);
  return [...n].map(([k, c]) => plural(c, KIND_NAME[k])).join(", ");
}
