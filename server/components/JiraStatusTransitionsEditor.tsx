"use client";
// jira-status-transitions' settings laid out as jira-transition's: the move
// switch (test mode off), a row per Jira move and the item move it makes, and
// what test-mode runs would have moved. Each row saves as one instance; a save
// sends the instances the page showed, and the server refuses it once they've changed.
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/base";
import { statusRuleInstances, statusRules, validateStatusRules, type StatusRule, type StatusRules } from "@/lib/jira/status-rules";
import type { DashPlugin, RunRow } from "@/lib/plugin-views";
import { asStored } from "@/lib/plugin-summary";
import { JiraPick, Pick, Problems } from "./JiraSettingsForm";
import { Stamp } from "./ui";

/** The moves its runs in test mode would have made: newest first, each once. */
function wouldMove(plugin: DashPlugin): { id: number; at: string; key: string; move: string; title: string | null }[] {
  const out = new Map<string, { id: number; at: string; key: string; move: string; title: string | null }>();
  for (const i of plugin.instances) {
    for (const r of plugin.runs[i.id] ?? ([] as RunRow[])) {
      if (!r.dryRun) continue;
      for (const a of r.attached) {
        if (a.kind !== "status" || out.has(`${r.item?.id}:${a.key}`)) continue;
        out.set(`${r.item?.id}:${a.key}`, { id: r.id, at: r.at, key: a.key.replace(/^jira:([^:]+):.*$/, "$1"), move: `${a.from} → ${a.to}`,
                                           title: r.item?.title ?? null });
      }
    }
  }
  return [...out.values()].sort((a, b) => b.id - a.id).slice(0, 20);
}

const BLANK: StatusRule = { jiraFrom: "", jiraTo: "", from: "", to: "", note: "" };

export function JiraStatusTransitionsEditor({ projectKey, repo, plugin, statuses }: {
  projectKey: string; repo: string; plugin: DashPlugin; statuses: readonly string[];
}) {
  const router = useRouter();
  const seen = useMemo(() => plugin.instances.map(asStored), [plugin.instances]);
  const [value, setValue] = useState<StatusRules>(() => statusRules(seen));
  const [dirty, setDirty] = useState(false);
  const [jira, setJira] = useState<{ statuses: string[] | null; error: string | null } | null>(null);
  const [saved, setSaved] = useState<{ ok: boolean; message: string; stale?: boolean } | null>(null);
  const [pending, start] = useTransition();
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins/jira?repo=${encodeURIComponent(repo)}`))
      .then((r) => (r.ok ? r.json() : { statuses: null, error: `the server answered ${r.status}` }))
      .catch(() => ({ statuses: null, error: "the server couldn't be reached" }))
      .then((j) => { if (live) setJira(j); });
    return () => { live = false; };
  }, [projectKey, repo]);
  const problems = useMemo(() => validateStatusRules(value, statuses, jira?.statuses), [value, statuses, jira]);
  const errors = problems.filter((p) => p.level === "error");
  const edit = (patch: Partial<StatusRules>) => { setValue({ ...value, ...patch }); setDirty(true); setSaved(null); };
  const editRule = (i: number, patch: Partial<StatusRule>) => edit({ rules: value.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const save = () => start(async () => {
    const res = await fetch(withBase(`/api/projects/${encodeURIComponent(projectKey)}/plugins`), {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo, plugin: plugin.name, instances: statusRuleInstances(value), base: seen }),
    }).catch(() => null);
    if (res?.ok) {
      setSaved({ ok: true, message: "Saved." });
      setDirty(false);
      setRefreshing(true);
      router.refresh();
      return;
    }
    const err = res ? await res.json().catch(() => null) : null;
    setSaved({ ok: false, message: err?.error ?? (res ? `the server answered ${res.status}` : "the server couldn't be reached"), stale: res?.status === 409 });
  });
  const moved = wouldMove(plugin);
  const jiraStatuses = jira?.statuses ?? null;
  return (
    <fieldset className="jira-settings plugin-jira" data-plugin-editor="jira-status-transitions" disabled={pending || refreshing}>
      {jira && !jira.statuses && <p className="hot">Jira couldn&apos;t be reached, so its statuses aren&apos;t listed: {jira.error}.</p>}
      <label className="switch">
        <input type="checkbox" checked={value.moves === true} ref={(el) => { if (el) el.indeterminate = value.moves === null; }}
               onChange={(e) => edit({ moves: e.target.checked })} />
        Move items
        <span className="hint">{value.moves === null ? "Some rules move items and some only record; switching sets them all."
          : value.moves ? "On: a matching Jira move moves the item." : "Off: moves are only recorded below."}</span>
      </label>
      <p className="hint">A rule runs while the item is in its todo status, on any Jira issue the item links. The note is posted with the move,
        as a QA rejection when the item moves to qa-rejected.</p>
      <div className="label sub">Rules</div>
      <div className="rule-table">
        {value.rules.map((r, i) => (
          <div className="rule-row" key={i} data-rule={`${r.jiraFrom}>${r.jiraTo}`}>
            <span className="arrow">Jira</span>
            <JiraPick label="Jira moves from" value={r.jiraFrom} options={jiraStatuses} onChange={(v) => editRule(i, { jiraFrom: v })} />
            <span className="arrow">→</span>
            <JiraPick label="Jira moves to" value={r.jiraTo} options={jiraStatuses} onChange={(v) => editRule(i, { jiraTo: v })} />
            <span className="arrow">moves the item</span>
            <Pick label="item moves from" value={r.from} options={statuses} onChange={(v) => editRule(i, { from: v })} />
            <span className="arrow">→</span>
            <Pick label="item moves to" value={r.to} options={statuses} onChange={(v) => editRule(i, { to: v })} />
            <input aria-label="note" className="grow" value={r.note} placeholder="note" onChange={(e) => editRule(i, { note: e.target.value })} />
            <button type="button" className="x" aria-label="remove rule" onClick={() => edit({ rules: value.rules.filter((_, j) => j !== i) })}>✕</button>
          </div>
        ))}
      </div>
      <button type="button" className="add" onClick={() => edit({ rules: [...value.rules, { ...BLANK }] })}><span className="pl">+</span>rule</button>
      <Problems problems={problems} />
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || !dirty || errors.length > 0} onClick={save}>{pending ? "Saving…" : "Save"}</button>
        {saved?.ok && <span className="hint">{saved.message}</span>}
        {saved && !saved.ok && (
          <span className="hot">
            Not saved: {saved.message}.{saved.stale && <> <button type="button" className="link-btn" onClick={() => router.refresh()}>Reload ›</button></>}
          </span>
        )}
      </div>
      <div className="label sub">Would move</div>
      {!moved.length ? <p className="empty">Nothing yet. Moves a rule would make show here while moving is off.</p> : (
        <div className="dry-runs">
          {moved.map((m) => (
            <div className="rrow" key={`${m.id}-${m.key}-${m.move}`}>
              <span className="hint"><Stamp ts={m.at} /></span>
              <span className="tag">move</span>
              <span className="grow">{m.key}: {m.move}{m.title && <span className="hint"> · {m.title}</span>}</span>
            </div>
          ))}
        </div>
      )}
    </fieldset>
  );
}
