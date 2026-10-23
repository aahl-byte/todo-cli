// {{path}} templates: a dotted path into the run's scope, never an expression.
// Each place a template lands fills it its own way, so no value can change a
// query or a call.

const TEMPLATE = /\{\{(.*?)\}\}/g;
const LONE = /^\{\{([^{}]*)\}\}$/;
const PATH = /^[A-Za-z_$][\w$-]*(\.[\w$-]+)*$/;

export type Scope = Record<string, unknown>;

/** What's wrong with every template in a value (strings, lists and maps walked). */
export function templateErrors(value: unknown): string[] {
  if (typeof value === "string") {
    const errors: string[] = [];
    for (const m of value.matchAll(TEMPLATE)) if (!PATH.test(m[1].trim())) errors.push(`${m[0]} is not a path`);
    if (value.replace(TEMPLATE, "").includes("{{")) errors.push(`unclosed {{ in ${JSON.stringify(value)}`);
    return errors;
  }
  if (Array.isArray(value)) return value.flatMap(templateErrors);
  if (value && typeof value === "object") return Object.values(value).flatMap(templateErrors);
  return [];
}

export function lookup(scope: unknown, path: string): unknown {
  let at: unknown = scope;
  for (const part of path.trim().split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

function text(v: unknown): string {
  if (v === undefined || v === null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Every template in a string replaced by its value as text. */
export function fillString(s: string, scope: Scope): string {
  return s.replace(TEMPLATE, (_, path) => text(lookup(scope, path)));
}

/** For `input` and `body`: a string that is exactly one template keeps the value's type. */
export function fillJson(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const lone = value.match(LONE);
    if (lone) return lookup(scope, lone[1]) ?? null;
    return fillString(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => fillJson(v, scope));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillJson(v, scope)]));
  }
  return value;
}

/** For HTTP paths: each value URL-encoded. */
export function fillUrl(s: string, scope: Scope): string {
  return s.replace(TEMPLATE, (_, path) => encodeURIComponent(text(lookup(scope, path))));
}

/** A JMESPath literal that is always the string itself; backticks are escaped so it can't end early. */
function literal(v: unknown): string {
  return "`" + JSON.stringify(text(v)).replace(/`/g, "\\u0060") + "`";
}

/** For `when`, `value` and `match`: each value becomes a quoted string literal. */
export function fillExpr(s: string, scope: Scope): string {
  return s.replace(TEMPLATE, (_, path) => literal(lookup(scope, path)));
}
