// JMESPath conditions and values over a run's scope, with templates filled as literals.
import jmespath from "jmespath";
import { fillExpr, type Scope } from "./template";

/** jmespath ships compile, which its types leave out. */
const { compile } = jmespath as typeof jmespath & { compile(expr: string): unknown };

/** JMESPath's truthiness: empty lists, empty objects, "", false and null are false. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function search(expr: string, scope: Scope): unknown {
  return jmespath.search(scope, fillExpr(expr, scope));
}

export function test(expr: string, scope: Scope): boolean {
  return truthy(search(expr, scope));
}

/** A syntax error in an expression, found without running it; null when it parses. */
export function exprError(expr: string): string | null {
  try {
    compile(fillExpr(expr, {}));
    return null;
  } catch (e) {
    return `bad expression ${JSON.stringify(expr)}: ${(e as Error).message}`;
  }
}
