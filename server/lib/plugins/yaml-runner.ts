// The YAML interpreter: per fans the run out, when gates, steps call or compute
// in order, and attach turns the results into attachments.
import { AttachError, makeAttachment } from "./attachments";
import { withQuery, type Calls } from "./connections";
import { search, test } from "./expr";
import { addLog, type Attached } from "./limits";
import { METHODS, settingRef } from "./load";
import { fillJson, fillString, fillUrl, templateErrors, TemplateError, type Scope } from "./template";
import { ATTACHMENT_KINDS, type Attachment, type Call, type PluginDef, type PluginItem, type PluginEvent, type RunResult, type StepDef } from "./types";

export interface YamlRun {
  name: string;
  plugin: PluginDef;
  item: PluginItem;
  event: PluginEvent;
  settings: Record<string, unknown>;
  /** The branches the repo's plugins file tracks. */
  track: string[];
  calls: Calls;
  result: RunResult;
  attached: Attached;
  /** The plugin declares post-request and the host granted it. */
  mayRequest: boolean;
}

/** The item's Jira keys, whether it holds one or a list. */
export function jiraKeys(item: PluginItem): string[] {
  const j = item.jira;
  if (Array.isArray(j)) return j.filter((k) => typeof k === "string" && k);
  return typeof j === "string" && j ? [j] : [];
}

function passes(plugin: PluginDef, item: PluginItem): { label: string; extra: Scope }[] {
  if (plugin.per === "branch") return item.branches.map((b) => ({ label: `branch ${b}`, extra: { branch: b } }));
  if (plugin.per === "jira") return jiraKeys(item).map((k) => ({ label: `issue ${k}`, extra: { issue: k } }));
  return [{ label: "", extra: {} }];
}

/** A field that is exactly {{settings.<key>}} for a template setting takes that setting's value as its own template. */
function splice(field: unknown, plugin: PluginDef, scope: Scope): unknown {
  const key = settingRef(field);
  if (!key || !plugin.settings?.[key]?.template) return field;
  const raw = (scope.settings as Record<string, unknown>)[key];
  const bad = templateErrors(raw);
  if (bad.length) throw new TemplateError(`setting ${key}: ${bad.join("; ")}`);
  return raw ?? undefined;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
/** Headers that would change where or how a request goes, rather than what it says. */
const FIXED_HEADERS = ["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer", "keep-alive"];

/** A step's headers as a map of lowercase names to filled values. */
function headersOf(raw: unknown, scope: Scope): Record<string, string> | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  let pairs: [string, string][];
  if (typeof raw === "string") {
    pairs = raw.split(/\r?\n/).filter((l) => l.trim()).map((line) => {
      const at = line.indexOf(":");
      if (at <= 0) throw new TemplateError(`headers: ${JSON.stringify(line)} isn't Name: value`);
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    });
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    pairs = Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
  } else throw new TemplateError("headers must be a map or Name: value lines");
  const out: Record<string, string> = {};
  for (const [name, template] of pairs) {
    if (!HEADER_NAME.test(name)) throw new TemplateError(`${JSON.stringify(name)} isn't a header name`);
    if (FIXED_HEADERS.includes(name.toLowerCase())) throw new TemplateError(`header ${name} can't be set by a plugin`);
    const value = fillString(template, scope);
    if (/[\r\n\0]/.test(value)) throw new TemplateError(`header ${name} would hold a line break`);
    out[name.toLowerCase()] = value;
  }
  return out;
}

function callFor(step: StepDef, plugin: PluginDef, scope: Scope): Call {
  const connection = step.connection ?? plugin.connections![0];
  if (step.tool) return { connection, tool: step.tool, input: fillJson(splice(step.input ?? {}, plugin, scope), scope) };
  const http = step.http!;
  const method = fillString(String(splice(http.method, plugin, scope) ?? ""), scope).trim().toUpperCase();
  if (!METHODS.includes(method)) throw new TemplateError(`http method ${JSON.stringify(method)} isn't one of ${METHODS.join(", ")}`);
  const path = String(splice(http.path, plugin, scope) ?? "");
  if (!path.startsWith("/")) throw new TemplateError(`setting ${settingRef(http.path)} must start with /`);
  const rawQuery = splice(http.query, plugin, scope);
  const query = rawQuery ? (fillJson(rawQuery, scope) as Record<string, unknown>) : undefined;
  const call: Call = { connection, method, path: withQuery(fillUrl(path, scope), query) };
  const headers = headersOf(splice(http.headers, plugin, scope), scope);
  if (headers && Object.keys(headers).length) call.headers = headers;
  const text = splice(http.text, plugin, scope);
  let body = splice(http.body, plugin, scope);
  if (text !== undefined && text !== null && text !== "") call.text = fillString(String(text), scope);
  else if (typeof body === "string" && body !== "" && body !== http.body) {
    // A body setting typed as text: JSON is filled value by value, so no item field can change its shape; other text goes as text.
    try {
      body = JSON.parse(body);
    } catch {
      call.text = fillString(body as string, scope);
      return call;
    }
    call.input = fillJson(body, scope);
  } else if (body !== undefined && body !== null && body !== "") call.input = fillJson(body, scope);
  return call;
}

/** A value to iterate: a list as itself, nothing as nothing, anything else once. */
function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  return v === null || v === undefined ? [] : [v];
}

function withLabel(label: string, e: unknown): Error {
  const err = e instanceof Error ? e : new Error(String(e));
  if (label) err.message = `${label}: ${err.message}`;
  return err;
}

function attachAll(run: YamlRun, scope: Scope, label: string, out: Attachment[]) {
  const where = label ? `${label}: ` : "";
  for (const entry of run.plugin.attach ?? []) {
    const kind = ATTACHMENT_KINDS.find((k) => k in entry)!;
    if (kind === "request" && !run.mayRequest) {
      addLog(run.result, `${where}dropped a request: ${run.name} hasn't been granted post-request`);
      continue;
    }
    const each = entry.each === undefined ? [undefined] : asList(search(entry.each, scope));
    for (const one of each) {
      const s = entry.each === undefined ? scope : { ...scope, each: one };
      if (entry.when !== undefined && !test(entry.when, s)) continue;
      try {
        out.push(makeAttachment(kind, fillJson(entry[kind], s), entry.key === undefined ? undefined : fillString(entry.key, s)));
      } catch (e) {
        if (!(e instanceof AttachError)) throw e;
        addLog(run.result, `${where}skipped a ${kind}: ${e.message}`);
      }
    }
  }
}

/** Run every pass into run.attached; any error ends the run. */
export async function runYaml(run: YamlRun): Promise<{ skipped?: string }> {
  const { plugin, item } = run;
  const all = passes(plugin, item);
  if (!all.length) return { skipped: plugin.per === "branch" ? "the item has no branches" : "the item has no Jira issues" };
  let gated = 0;
  for (const { label, extra } of all) {
    const scope: Scope = { item, event: run.event, settings: run.settings, track: run.track, ...extra };
    try {
      if (plugin.when !== undefined && !test(plugin.when, scope)) {
        gated++;
        continue;
      }
      for (const step of plugin.steps ?? []) {
        run.calls.checkDeadline();
        if (step.when !== undefined && !test(step.when, scope)) {
          if (step.name) scope[step.name] = null;
          continue;
        }
        const value = step.value !== undefined ? search(step.value, scope) : await run.calls.send(callFor(step, plugin, scope));
        if (step.name) scope[step.name] = value ?? null;
      }
      const attached: Attachment[] = [];
      attachAll(run, scope, label, attached);
      for (const a of attached) run.attached.add(a, run.result);
    } catch (e) {
      throw withLabel(label, e);
    }
  }
  if (gated === all.length) return { skipped: `when is false: ${plugin.when}` };
  return {};
}
