"use client";
import { useMemo, useState, useTransition } from "react";
import { saveActionsAction } from "@/app/settings-actions";
import { ANY_STATUS, cleanAction, DEFAULT_PROMPT, METHODS, TEMPLATE_NAMES, validateActions, type ActionDef } from "@/lib/actions/model";
import type { Problem } from "@/lib/jira/rules";

const headerText = (h: Record<string, string> = {}) => Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\n");
function parseHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

type Draft = ActionDef & { headerText: string };
const draft = (a: ActionDef): Draft => ({ ...a, headerText: headerText(a.headers) });
const blank = (n: number): Draft => draft(cleanAction({ id: `action-${n}`, name: "", kind: "rest", runner: "server", method: "POST", url: "", auto: [] }));
const stored = (d: Draft): ActionDef => cleanAction({ ...d, headers: parseHeaders(d.headerText) });

export function ActionsSettingsForm({ projectKey, actions, statuses }: { projectKey: string; actions: ActionDef[]; statuses: readonly string[] }) {
  const [list, setList] = useState<Draft[]>(actions.map(draft));
  const [saved, setSaved] = useState<{ ok: boolean; problems: Problem[] } | null>(null);
  const [pending, start] = useTransition();
  const problems = useMemo(() => validateActions(list.map(stored), statuses), [list, statuses]);
  const errors = problems.filter((p) => p.level === "error");

  const edit = (i: number, patch: Partial<Draft>) => { setList(list.map((a, j) => (j === i ? { ...a, ...patch } : a))); setSaved(null); };
  const save = () => start(async () => setSaved(await saveActionsAction(projectKey, list.map(stored))));

  return (
    <div className="actions-settings">
      <p className="hint">
        An Action calls a URL for an item, by hand from the item page or <code>todo action</code>, or on its own when an item makes
        one of its status moves. Templates take <code>{"{{name}}"}</code>, or <code>{"{{name | json}}"}</code> and <code>{"{{name | url}}"}</code>:{" "}
        {TEMPLATE_NAMES.join(", ")}.
      </p>
      {list.map((a, i) => (
        <section className="action-card" key={i} data-action={a.id}>
          <div className="rule-row">
            <input aria-label="name" placeholder="name" value={a.name} onChange={(e) => edit(i, { name: e.target.value })} />
            <input aria-label="id" placeholder="id" value={a.id} onChange={(e) => edit(i, { id: e.target.value })} />
            <select aria-label="kind" value={a.kind} onChange={(e) => edit(i, { kind: e.target.value as Draft["kind"], ...(e.target.value === "watchtower" && !a.prompt ? { prompt: DEFAULT_PROMPT } : {}) })}>
              <option value="rest">REST call</option>
              <option value="watchtower">Watchtower session</option>
            </select>
            <select aria-label="runner" value={a.runner} onChange={(e) => edit(i, { runner: e.target.value as Draft["runner"] })}>
              <option value="server">sent by the server</option>
              <option value="cli">sent by the todo CLI</option>
            </select>
            <button type="button" className="x" aria-label={`remove ${a.name || a.id}`} onClick={() => { setList(list.filter((_, j) => j !== i)); setSaved(null); }}>✕</button>
          </div>
          {a.kind === "rest" ? (
            <>
              <div className="rule-row">
                <select aria-label="method" value={a.method} onChange={(e) => edit(i, { method: e.target.value })}>
                  {METHODS.map((m) => <option key={m}>{m}</option>)}
                </select>
                <input aria-label="url" className="grow" placeholder="https://…" value={a.url ?? ""} onChange={(e) => edit(i, { url: e.target.value })} />
              </div>
              <textarea aria-label="headers" rows={2} placeholder="Header: value, one per line" value={a.headerText} onChange={(e) => edit(i, { headerText: e.target.value })} />
              {a.method !== "GET" && a.method !== "DELETE" && (
                <textarea aria-label="body" rows={3} placeholder='{"item": {{item.id | json}}}' value={a.body ?? ""} onChange={(e) => edit(i, { body: e.target.value })} />
              )}
            </>
          ) : (
            <>
              <div className="rule-row">
                <input aria-label="watchtower address" placeholder="http://leaf-rain:10011" value={a.base ?? ""} onChange={(e) => edit(i, { base: e.target.value })} />
                <input aria-label="folder" className="grow" placeholder="/mnt/rain/git/{{item.repo_name}}" value={a.dir ?? ""} onChange={(e) => edit(i, { dir: e.target.value })} />
                <select aria-label="model" value={a.model ?? ""} onChange={(e) => edit(i, { model: e.target.value || undefined })}>
                  <option value="">default model</option>
                  {["opus", "sonnet", "haiku"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <textarea aria-label="prompt" rows={2} value={a.prompt ?? ""} onChange={(e) => edit(i, { prompt: e.target.value })} />
              <p className="hint">Reuses the live session named <code>todo: &lt;item id&gt;</code>, or starts one in the folder.</p>
            </>
          )}
          <div className="label sub">Fires on its own when an item moves</div>
          <div className="rule-table">
            {a.auto.map((r, k) => (
              <div className="rule-row" key={k}>
                <select aria-label="from status" value={r.from} onChange={(e) => edit(i, { auto: a.auto.map((x, j) => (j === k ? { ...x, from: e.target.value } : x)) })}>
                  <option value={ANY_STATUS}>any status</option>
                  {statuses.map((s) => <option key={s}>{s}</option>)}
                </select>
                <span className="arrow">→</span>
                <select aria-label="to status" value={r.to} onChange={(e) => edit(i, { auto: a.auto.map((x, j) => (j === k ? { ...x, to: e.target.value } : x)) })}>
                  {!r.to && <option value="">—</option>}
                  {statuses.map((s) => <option key={s}>{s}</option>)}
                </select>
                <button type="button" className="x" aria-label="remove move" onClick={() => edit(i, { auto: a.auto.filter((_, j) => j !== k) })}>✕</button>
              </div>
            ))}
          </div>
          <button type="button" className="add" onClick={() => edit(i, { auto: [...a.auto, { from: ANY_STATUS, to: "" }] })}><span className="pl">+</span>status move</button>
        </section>
      ))}
      <button type="button" className="add" onClick={() => { setList([...list, blank(list.length + 1)]); setSaved(null); }}><span className="pl">+</span>action</button>
      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => <li key={p.message} className={p.level}>{p.message}</li>)}
        </ul>
      )}
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || errors.length > 0} onClick={save}>{pending ? "saving…" : "save actions"}</button>
        {saved?.ok && <span className="hint">Saved.</span>}
        {saved && !saved.ok && <span className="hot">Not saved: {saved.problems.filter((p) => p.level === "error").map((p) => p.message).join(" ")}</span>}
      </div>
    </div>
  );
}
