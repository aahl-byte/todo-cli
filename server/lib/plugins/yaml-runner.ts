// The YAML interpreter: per fans the run out, when gates, steps call or compute
// in order, and attach turns the results into attachments.
import { AttachError, makeAttachment } from "./attachments";
import { withQuery, type Calls } from "./connections";
import { search, test } from "./expr";
import { fillJson, fillString, fillUrl, type Scope } from "./template";
import { ATTACHMENT_KINDS, type Attachment, type Call, type PluginDef, type PluginItem, type PluginEvent, type RunResult, type StepDef } from "./types";

export interface YamlRun {
  plugin: PluginDef;
  item: PluginItem;
  event: PluginEvent;
  settings: Record<string, unknown>;
  calls: Calls;
  result: RunResult;
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

function callFor(step: StepDef, plugin: PluginDef, scope: Scope): Call {
  const connection = step.connection ?? plugin.connections![0];
  if (step.tool) return { connection, tool: step.tool, input: fillJson(step.input ?? {}, scope) };
  const http = step.http!;
  const query = http.query ? (fillJson(http.query, scope) as Record<string, unknown>) : undefined;
  const call: Call = { connection, method: http.method.toUpperCase(), path: withQuery(fillUrl(http.path, scope), query) };
  if (http.body !== undefined) call.input = fillJson(http.body, scope);
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
  for (const entry of run.plugin.attach ?? []) {
    const kind = ATTACHMENT_KINDS.find((k) => k in entry)!;
    const each = entry.each === undefined ? [undefined] : asList(search(entry.each, scope));
    for (const one of each) {
      const s = entry.each === undefined ? scope : { ...scope, each: one };
      if (entry.when !== undefined && !test(entry.when, s)) continue;
      try {
        out.push(makeAttachment(kind, fillJson(entry[kind], s), entry.key === undefined ? undefined : fillString(entry.key, s)));
      } catch (e) {
        if (!(e instanceof AttachError)) throw e;
        run.result.log.push(`${label ? `${label}: ` : ""}skipped a ${kind}: ${e.message}`);
      }
    }
  }
}

/** Run every pass; any error ends the run and nothing it gathered is kept. */
export async function runYaml(run: YamlRun): Promise<{ attached: Attachment[]; skipped?: string }> {
  const { plugin, item } = run;
  const all = passes(plugin, item);
  if (!all.length) return { attached: [], skipped: plugin.per === "branch" ? "the item has no branches" : "the item has no Jira issues" };
  const attached: Attachment[] = [];
  let gated = 0;
  for (const { label, extra } of all) {
    const scope: Scope = { item, event: run.event, settings: run.settings, ...extra };
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
      attachAll(run, scope, label, attached);
    } catch (e) {
      throw withLabel(label, e);
    }
  }
  if (gated === all.length) return { attached: [], skipped: `when is false: ${plugin.when}` };
  return { attached };
}
