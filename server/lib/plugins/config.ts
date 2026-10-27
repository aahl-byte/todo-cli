// A repo's plugin config as todo keeps it: its deploy branches, the shipped
// plugins switched on, the connections its custom plugins call, and each custom
// plugin's YAML manifest and code. Composed here into the one map the host
// reads, and checked here before a custom plugin is saved. Pure, so the
// dashboard's editor checks a draft as it's typed with the same rules.
import { parse, stringify } from "yaml";
import { pluginErrors } from "./load";
import type { ConnectionDef, PluginConfig, PluginDef } from "./types";

/** A custom plugin's name, and a connection's. */
export const NAME = /^[A-Za-z][\w-]*$/;
/** Names every object already has, which a plugin or connection can't take. */
export const INHERITED = Object.getOwnPropertyNames(Object.prototype);
export const MAX_MANIFEST = 64 * 1024;
export const MAX_CODE = 1024 * 1024;
/** A branch name as git allows one, near enough: no spaces, no `..`, no leading `-`. */
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\s~^:?*[\\\x00-\x1f\x7f]+(?<![./])$/;

export interface CustomPlugin { name: string; manifest: string; code: string | null }

export interface ConfigParts {
  track: string[];
  shipped: string[];
  connections: Record<string, ConnectionDef>;
  custom: CustomPlugin[];
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const yamlError = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

/** The config as the host reads it; a custom plugin whose YAML no longer parses is left out, with an error naming it. */
export function composeConfig(parts: ConfigParts): { config: PluginConfig; errors: string[] } {
  const errors: string[] = [];
  const plugins: Record<string, unknown> = {};
  const code: Record<string, string> = {};
  for (const name of parts.shipped) plugins[name] = { use: "shipped" };
  for (const p of parts.custom) {
    let def: unknown;
    try {
      def = parse(p.manifest) ?? {};
    } catch (e) {
      errors.push(`plugin ${p.name}: its YAML doesn't parse: ${yamlError(e)}`);
      continue;
    }
    plugins[p.name] = def;
    if (p.code !== null) code[p.name] = p.code;
  }
  const map: Record<string, unknown> = {};
  if (parts.track.length) map.track = parts.track;
  if (Object.keys(parts.connections).length) map.connections = parts.connections;
  if (Object.keys(plugins).length) map.plugins = plugins;
  return { config: { text: stringify(map), code }, errors };
}

/** The deploy branches as given, trimmed and once each; throws on one git wouldn't take. */
export function branchList(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.every((b) => typeof b === "string")) throw new TypeError("deploy branches are a list of branch names");
  const names = [...new Set(raw.map((b) => b.trim()).filter(Boolean))];
  const bad = names.filter((b) => !BRANCH.test(b));
  if (bad.length) throw new TypeError(`not a branch name: ${bad.join(", ")}`);
  return names;
}

export interface CustomCheck {
  errors: string[];
  /** Worth knowing, but saving goes ahead: a connection it calls that the repo doesn't declare yet. */
  warnings: string[];
  def: PluginDef | null;
}

/** Everything wrong with a custom plugin before it's saved. `reserved`: names it can't take (the shipped plugins and the
 * repo's other custom plugins); `connections`: the ones the repo's config declares. */
export function checkCustom(p: CustomPlugin, ctx: { reserved: string[]; connections: string[] }): CustomCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const name = p.name.trim();
  if (!name) errors.push("give the plugin a name");
  else if (!NAME.test(name)) errors.push("a name starts with a letter and has only letters, digits, - and _");
  else if (INHERITED.includes(name)) errors.push(`${name} can't be a plugin's name`);
  else if (ctx.reserved.includes(name)) errors.push(`${name} is taken: a plugin ships with todo or this repo has one by that name`);
  if (p.manifest.length > MAX_MANIFEST) errors.push(`the YAML is over ${MAX_MANIFEST / 1024} KB`);
  if (p.code !== null && p.code.length > MAX_CODE) errors.push(`the code is over ${MAX_CODE / 1024} KB`);
  let def: unknown;
  try {
    def = parse(p.manifest) ?? {};
  } catch (e) {
    return { errors: [...errors, `the YAML doesn't parse: ${yamlError(e)}`], warnings, def: null };
  }
  if (!isMap(def)) return { errors: [...errors, "the YAML is a map of the plugin's keys: description, on, steps…"], warnings, def: null };
  if ("use" in def) {
    errors.push("a custom plugin is defined here in full; a plugin that ships with todo is switched on with its own switch");
    return { errors, warnings, def: null };
  }
  const label = name && NAME.test(name) ? name : "(unnamed)";
  errors.push(...pluginErrors(label, def).map((e) => e.replace(`plugin ${label}: `, "")));
  const code = typeof def.code === "string" ? def.code : null;
  if (code && !p.code?.trim()) errors.push(`code names ${code}: paste that file's code`);
  if (!code && p.code?.trim()) errors.push("the YAML names no code: file, so this code would never run");
  const calls = Array.isArray(def.connections) ? def.connections.filter((c): c is string => typeof c === "string" && !c.includes("{{")) : [];
  for (const c of calls) {
    if (c !== "github" && !ctx.connections.includes(c)) warnings.push(`it calls ${c}, which isn't one of this repo's connections yet`);
  }
  return { errors, warnings, def: errors.length ? null : (def as PluginDef) };
}
