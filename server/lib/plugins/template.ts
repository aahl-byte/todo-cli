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

/** A dotted path's value, reading only the data's own properties. */
export function lookup(scope: unknown, path: string): unknown {
  let at: unknown = scope;
  for (const part of path.trim().split(".")) {
    if (at === null || typeof at !== "object" || !Object.hasOwn(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** The quoting forms of a JMESPath expression; inside each, a backslash escapes only the closing quote and itself, as jmespath lexes them. */
const QUOTES = ["'", '"', "`"];

/** Every template sitting inside a '…', "…" or `…` token of an expression, where it could change the expression. */
export function quotedTemplates(expr: string): string[] {
  const found: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quote) {
      if (c === "\\" && (expr[i + 1] === quote || expr[i + 1] === "\\")) i++;
      else if (c === quote) quote = null;
      else if (expr.startsWith("{{", i)) {
        const end = expr.indexOf("}}", i);
        found.push(expr.slice(i, end < 0 ? undefined : end + 2));
        if (end >= 0) i = end + 1;
      }
    } else if (QUOTES.includes(c)) quote = c;
    else if (expr.startsWith("{{", i)) {
      const end = expr.indexOf("}}", i);
      if (end >= 0) i = end + 1;
    }
  }
  return found;
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

export class TemplateError extends Error {}

const MAX_DECODES = 8;

function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** A filled path segment that, decoded, has a . or .. part, which would move the request elsewhere. */
function leavesSegment(segment: string): boolean {
  // Every decoding a server might apply, until it stops changing.
  for (let plain = segment, i = 0; i < MAX_DECODES; i++) {
    const next = decoded(plain);
    if (next.split(/[/\\]/).some((p) => p === "." || p === "..")) return true;
    if (next === plain) return false;
    plain = next;
  }
  return true;
}

/** For HTTP paths: each value URL-encoded, a slash in it included; a value that makes a . or .. part is refused. */
export function fillUrl(s: string, scope: Scope): string {
  const q = s.indexOf("?");
  const [path, query] = q < 0 ? [s, ""] : [s.slice(0, q), s.slice(q)];
  const fill = (part: string) => part.replace(TEMPLATE, (_, p) => encodeURIComponent(text(lookup(scope, p))));
  const segments = path.split("/").map((seg) => {
    const filled = fill(seg);
    if (filled !== seg && leavesSegment(filled)) throw new TemplateError(`${seg} fills as ${JSON.stringify(decoded(filled))}, which would change the path`);
    return filled;
  });
  return segments.join("/") + fill(query);
}

/** A JMESPath literal that is always the string itself; backticks are escaped so it can't end early. */
function literal(v: unknown): string {
  return "`" + JSON.stringify(text(v)).replace(/`/g, "\\u0060") + "`";
}

/** For `when`, `value` and `match`: each value becomes a quoted string literal. */
export function fillExpr(s: string, scope: Scope): string {
  return s.replace(TEMPLATE, (_, path) => literal(lookup(scope, path)));
}
