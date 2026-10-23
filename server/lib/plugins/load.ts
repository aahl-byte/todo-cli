// Reading a repo's .todo-plugins/plugins.yaml and checking every plugin in it,
// so a bad template or an unknown key is reported before anything runs.
import { parse } from "yaml";
import { ATTACH_FIELDS } from "./attachments";
import { exprError } from "./expr";
import { templateErrors } from "./template";
import { parseDuration } from "./triggers";
import { ATTACHMENT_KINDS, type AttachmentKind, type PluginsFile } from "./types";

export class PluginsFileError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("\n"));
  }
}

const FILE_KEYS = ["track", "connections", "plugins", "instances"];
const PLUGIN_KEYS = ["connections", "on", "every", "exclusive", "capabilities", "settings", "per", "when", "steps", "attach", "code", "use"];
const YAML_BODY = ["per", "steps", "attach"];
const STEP_KEYS = ["name", "when", "connection", "tool", "input", "http", "value"];
const STEP_ACTIONS = ["tool", "http", "value"] as const;
const HTTP_KEYS = ["method", "path", "query", "body"];
export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const ATTACH_KEYS = ["each", "when", "key"];
const SETTING_KEYS = ["label", "type", "default", "optional", "options", "options_from", "scope"];
const SETTING_TYPES = ["text", "long-text", "choice", "toggle", "number", "list", "secret"];
const INSTANCE_KEYS = ["id", "name", "enabled", "on", "button", "dry_run", "settings"];
const CAPABILITIES = ["post-request"];
const TRIGGERS = ["push", "pr", "deployment", "manual"];
/** Names a step can't take, because the scope already has them. */
const RESERVED = ["item", "event", "settings", "branch", "issue", "each"];
const STEP_NAME = /^[A-Za-z_]\w*$/;
const CODE_FILE = /^(?!.*(^|\/)\.\.(\/|$))[\w./-]+\.m?js$/;

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function unknownKeys(v: Record<string, unknown>, allowed: string[]): string[] {
  return Object.keys(v).filter((k) => !allowed.includes(k)).map((k) => `unknown key "${k}"`);
}

function exprProblems(expr: unknown, what: string): string[] {
  if (typeof expr !== "string") return [`${what} must be an expression string`];
  const bad = templateErrors(expr);
  if (bad.length) return bad;
  const err = exprError(expr);
  return err ? [err] : [];
}

export function triggerErrors(on: unknown): string[] {
  if (!Array.isArray(on)) return ["on must be a list"];
  return on.flatMap((t, i) => {
    if (typeof t === "string") return TRIGGERS.includes(t) ? [] : [`on[${i}]: unknown trigger "${t}"`];
    if (isMap(t) && Object.keys(t).length === 1 && isMap(t.status)) {
      const status = t.status;
      const bad = unknownKeys(status, ["from", "to"]);
      const notText = ["from", "to"].filter((k) => k in status && typeof status[k] !== "string");
      return [...bad, ...notText.map((k) => `status ${k} must be a status name or *`)].map((e) => `on[${i}]: ${e}`);
    }
    return [`on[${i}]: a trigger is push, pr, deployment, manual or {status: {from, to}}`];
  });
}

function stepErrors(step: unknown, connections: string[]): string[] {
  if (!isMap(step)) return ["a step must be a map"];
  const errors = unknownKeys(step, STEP_KEYS);
  const actions = STEP_ACTIONS.filter((a) => a in step);
  if (actions.length !== 1) return [...errors, "a step is exactly one of tool, http or value"];
  if ("name" in step && (typeof step.name !== "string" || !STEP_NAME.test(step.name))) errors.push(`step name ${JSON.stringify(step.name)} must be a plain identifier`);
  else if (RESERVED.includes(step.name as string)) errors.push(`step name "${step.name}" is taken by the scope`);
  if ("when" in step) errors.push(...exprProblems(step.when, "when"));
  if (actions[0] === "value") {
    errors.push(...exprProblems(step.value, "value"));
    if ("connection" in step || "input" in step) errors.push("a value step calls nothing, so it takes no connection or input");
    return errors;
  }
  if ("connection" in step) {
    if (!connections.includes(step.connection as string)) errors.push(`connection "${step.connection}" isn't one of the plugin's connections`);
  } else if (connections.length > 1) errors.push("name its connection, the plugin has several");
  else if (!connections.length) errors.push("the plugin declares no connection to call");
  if (actions[0] === "tool") {
    if (typeof step.tool !== "string" || !step.tool) errors.push("tool must be a tool name");
    errors.push(...templateErrors(step.input));
    return errors;
  }
  if ("input" in step) errors.push("an http step sends its body, not input");
  const http = step.http;
  if (!isMap(http)) return [...errors, "http must be a map of method, path, query and body"];
  errors.push(...unknownKeys(http, HTTP_KEYS));
  if (typeof http.method !== "string" || !METHODS.includes(http.method.toUpperCase())) errors.push(`http method must be one of ${METHODS.join(", ")}`);
  if (typeof http.path !== "string" || !http.path.startsWith("/")) errors.push("http path must start with /");
  if ("query" in http && !isMap(http.query)) errors.push("http query must be a map");
  errors.push(...templateErrors(http.path), ...templateErrors(http.query), ...templateErrors(http.body));
  return errors;
}

function attachErrors(entry: unknown, plugin: Record<string, unknown>): string[] {
  if (!isMap(entry)) return ["an attach entry must be a map"];
  const kinds = ATTACHMENT_KINDS.filter((k) => k in entry);
  const errors = unknownKeys(entry, [...ATTACH_KEYS, ...ATTACHMENT_KINDS]);
  if (kinds.length !== 1) return [...errors, `an attach entry is exactly one of ${ATTACHMENT_KINDS.join(", ")}`];
  const kind = kinds[0] as AttachmentKind;
  if ("each" in entry) errors.push(...exprProblems(entry.each, "each"));
  if ("when" in entry) errors.push(...exprProblems(entry.when, "when"));
  if ("key" in entry) errors.push(...(typeof entry.key === "string" ? templateErrors(entry.key) : ["key must be a string"]));
  const body = entry[kind];
  const spec = ATTACH_FIELDS[kind];
  if (typeof body === "string" && spec.required.length === 1 && spec.required[0] === "text") {
    errors.push(...templateErrors(body));
  } else if (isMap(body)) {
    errors.push(...unknownKeys(body, [...spec.required, ...spec.optional]));
    errors.push(...spec.required.filter((f) => !(f in body)).map((f) => `${kind} needs ${f}`));
    errors.push(...templateErrors(body));
  } else errors.push(`${kind} must be a map of ${[...spec.required, ...spec.optional].join(", ")}`);
  if (kind === "request" && !(plugin.capabilities as string[] | undefined)?.includes("post-request")) {
    errors.push("request needs the post-request capability");
  }
  return errors;
}

function settingErrors(key: string, s: unknown): string[] {
  if (!isMap(s)) return [`settings.${key} must be a map`];
  const errors = unknownKeys(s, SETTING_KEYS);
  if (typeof s.label !== "string") errors.push("needs a label");
  if (!SETTING_TYPES.includes(s.type as string)) errors.push(`type must be one of ${SETTING_TYPES.join(", ")}`);
  if ("options" in s && !isStrings(s.options)) errors.push("options must be a list of strings");
  if ("options_from" in s && !(isMap(s.options_from) && typeof s.options_from.tool === "string")) errors.push("options_from needs a tool");
  if ("scope" in s && s.scope !== "plugin" && s.scope !== "instance") errors.push("scope is plugin or instance");
  errors.push(...templateErrors(s.default));
  return errors.map((e) => `settings.${key}: ${e}`);
}

/** Everything wrong with one plugin definition, each line naming the plugin. */
export function pluginErrors(name: string, def: unknown): string[] {
  if (!isMap(def)) return [`plugin ${name}: must be a map`];
  const errors = unknownKeys(def, PLUGIN_KEYS);
  if ("use" in def) {
    if (typeof def.use !== "string") errors.push("use names where the plugin comes from, e.g. shipped");
    return errors.map((e) => `plugin ${name}: ${e}`);
  }
  const connections = def.connections ?? [];
  if (!isStrings(connections)) errors.push("connections must be a list of names");
  if ("on" in def) errors.push(...triggerErrors(def.on));
  if ("every" in def) {
    try { parseDuration(def.every as string); } catch (e) { errors.push(`every: ${(e as Error).message}`); }
  }
  if ("exclusive" in def && typeof def.exclusive !== "boolean") errors.push("exclusive is true or false");
  if ("capabilities" in def) {
    if (!isStrings(def.capabilities)) errors.push("capabilities must be a list");
    else errors.push(...def.capabilities.filter((c) => !CAPABILITIES.includes(c)).map((c) => `unknown capability "${c}"`));
  }
  if ("settings" in def) {
    if (!isMap(def.settings)) errors.push("settings must be a map");
    else errors.push(...Object.entries(def.settings).flatMap(([k, s]) => settingErrors(k, s)));
  }
  if ("when" in def) errors.push(...exprProblems(def.when, "when"));
  if ("code" in def) {
    if (typeof def.code !== "string" || !CODE_FILE.test(def.code)) errors.push("code names a .js file in .todo-plugins/");
    if (YAML_BODY.some((k) => k in def)) errors.push("a code plugin has no per, steps or attach");
  } else {
    if ("per" in def && def.per !== "branch" && def.per !== "jira") errors.push("per is branch or jira");
    const conns = isStrings(connections) ? connections : [];
    if ("steps" in def) {
      if (!Array.isArray(def.steps)) errors.push("steps must be a list");
      else {
        const names = new Set<string>();
        def.steps.forEach((s, i) => {
          errors.push(...stepErrors(s, conns).map((e) => `steps[${i}]: ${e}`));
          const n = isMap(s) ? s.name : undefined;
          if (typeof n === "string") {
            if (names.has(n)) errors.push(`steps[${i}]: a second step named "${n}"`);
            names.add(n);
          }
        });
      }
    }
    if ("attach" in def) {
      if (!Array.isArray(def.attach)) errors.push("attach must be a list");
      else def.attach.forEach((a, i) => errors.push(...attachErrors(a, def).map((e) => `attach[${i}]: ${e}`)));
    }
  }
  return errors.map((e) => `plugin ${name}: ${e}`);
}

function connectionErrors(name: string, c: unknown): string[] {
  const fail = (e: string) => [`connection ${name}: ${e}`];
  if (!isMap(c) || Object.keys(c).length !== 1) return fail("is {http: {url, auth?}} or {mcp: {url} | {command, args?}}");
  if (isMap(c.http)) {
    const bad = unknownKeys(c.http, ["url", "auth"]);
    if (typeof c.http.url !== "string") bad.push("http needs a url");
    const auth = c.http.auth;
    if (auth !== undefined && !(auth === "bearer" || auth === "basic" || (typeof auth === "string" && /^header:[\w-]+$/.test(auth)))) {
      bad.push("auth is bearer, basic or header:<Name>");
    }
    return bad.flatMap(fail);
  }
  if (isMap(c.mcp)) {
    const bad = unknownKeys(c.mcp, ["url", "command", "args"]);
    const url = typeof c.mcp.url === "string", command = typeof c.mcp.command === "string";
    if (url === command) bad.push("mcp needs a url or a command");
    if ("args" in c.mcp && !isStrings(c.mcp.args)) bad.push("args must be a list of strings");
    return bad.flatMap(fail);
  }
  return fail("is http or mcp");
}

function instanceErrors(plugin: string, list: unknown, known: boolean): string[] {
  const fail = (e: string) => `instances.${plugin}: ${e}`;
  if (!known) return [fail("no plugin by that name")];
  if (!Array.isArray(list)) return [fail("must be a list")];
  const ids = new Set<string>();
  return list.flatMap((inst, i) => {
    if (!isMap(inst)) return [fail(`[${i}] must be a map`)];
    const errors = unknownKeys(inst, INSTANCE_KEYS);
    if (typeof inst.id !== "string" || !inst.id) errors.push("needs an id");
    else if (ids.has(inst.id)) errors.push(`a second instance with id "${inst.id}"`);
    else ids.add(inst.id);
    if (typeof inst.name !== "string") errors.push("needs a name");
    if ("on" in inst) errors.push(...triggerErrors(inst.on));
    if ("settings" in inst && !isMap(inst.settings)) errors.push("settings must be a map");
    return errors.map((e) => fail(`[${i}] ${e}`));
  });
}

/** Every problem in a parsed plugins file. */
export function fileErrors(file: unknown): string[] {
  if (!isMap(file)) return ["plugins.yaml must be a map"];
  const errors = unknownKeys(file, FILE_KEYS);
  if ("track" in file && !isStrings(file.track)) errors.push("track must be a list of branch names");
  for (const [k, kind] of [["connections", "map"], ["plugins", "map"], ["instances", "map"]] as const) {
    if (k in file && !isMap(file[k])) errors.push(`${k} must be a ${kind}`);
  }
  const connections = isMap(file.connections) ? file.connections : {};
  const plugins = isMap(file.plugins) ? file.plugins : {};
  const instances = isMap(file.instances) ? file.instances : {};
  errors.push(...Object.entries(connections).flatMap(([n, c]) => connectionErrors(n, c)));
  errors.push(...Object.entries(plugins).flatMap(([n, p]) => pluginErrors(n, p)));
  errors.push(...Object.entries(instances).flatMap(([n, l]) => instanceErrors(n, l, n in plugins)));
  return errors;
}

/** Parse and check a plugins.yaml; throws PluginsFileError listing every problem. */
export function loadPlugins(text: string): PluginsFile {
  let file: unknown;
  try {
    file = parse(text) ?? {};
  } catch (e) {
    throw new PluginsFileError([`plugins.yaml isn't YAML: ${(e as Error).message}`]);
  }
  const errors = fileErrors(file);
  if (errors.length) throw new PluginsFileError(errors);
  return file as PluginsFile;
}

