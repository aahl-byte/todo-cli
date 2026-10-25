"use client";
import { useMemo, useState, useTransition } from "react";
import { saveJiraSettingsAction } from "@/app/settings-actions";
import { describeMove, validateRules, type OutboundRules, type Problem, type Trigger } from "@/lib/jira/rules";

function JiraPick({ value, options, onChange, label }: { value: string; options: string[] | null; onChange: (v: string) => void; label: string }) {
  if (!options) return <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Jira status" />;
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">—</option>}
      {all.map((s) => <option key={s} value={s}>{s}{options.includes(s) ? "" : " (not in Jira)"}</option>)}
    </select>
  );
}

function Pick({ value, options, onChange, label }: { value: string; options: readonly string[]; onChange: (v: string) => void; label: string }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">—</option>}
      {options.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

export function JiraSettingsForm({ projectKey, outbound, statuses, jiraStatuses, serverReadOnly }: {
  projectKey: string; outbound: OutboundRules; statuses: readonly string[]; jiraStatuses: string[] | null; serverReadOnly: boolean;
}) {
  const [out, setOut] = useState<OutboundRules>(outbound);
  const [neverDraft, setNeverDraft] = useState("");
  const [test, setTest] = useState({ from: "review", to: "ready-for-qa" });
  const [saved, setSaved] = useState<{ ok: boolean; problems: Problem[] } | null>(null);
  const [pending, start] = useTransition();

  const problems = useMemo(() => validateRules(out, statuses, jiraStatuses), [out, statuses, jiraStatuses]);
  const errors = problems.filter((p) => p.level === "error");

  const editOut = (patch: Partial<OutboundRules>) => { setOut({ ...out, ...patch }); setSaved(null); };
  const editTrigger = (i: number, patch: Partial<Trigger>) =>
    editOut({ triggers: out.triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const save = () => start(async () => setSaved(await saveJiraSettingsAction(projectKey, out)));

  return (
    <div className="jira-settings">
      <section>
        <div className="label section">Jira → todo</div>
        <p className="hint">A linked issue's status shows next to its key and never moves the item.</p>
      </section>

      <section>
        <div className="label section">todo → Jira</div>
        <label className="switch">
          <input type="checkbox" checked={out.writes && !serverReadOnly} disabled={serverReadOnly} onChange={(e) => editOut({ writes: e.target.checked })} />
          Send to Jira
          <span className="hint">{serverReadOnly ? "Locked off: this server is read-only (JIRA_READ_ONLY)." : out.writes ? "On: triggered calls are sent." : "Off: triggered calls are only recorded below."}</span>
        </label>
        <p className="hint">A trigger moves every Jira issue the item links. Comments stay in todo.</p>
        <div className="rule-row">
          <span className="hint">Never move Jira to</span>
          <span className="chips">
            {out.never.map((n) => (
              <span key={n} className="chip">{n}<button type="button" className="x" aria-label={`allow ${n}`} onClick={() => editOut({ never: out.never.filter((x) => x !== n) })}>✕</button></span>
            ))}
            <JiraPick label="never move to" value={neverDraft} options={jiraStatuses} onChange={setNeverDraft} />
            <button type="button" className="btn" disabled={!neverDraft.trim()} onClick={() => { editOut({ never: [...out.never, neverDraft.trim()] }); setNeverDraft(""); }}>add</button>
          </span>
        </div>
        <div className="label sub">Triggers</div>
        <div className="rule-table">
          {out.triggers.map((t, i) => (
            <div className="rule-row" key={i} data-trigger={`${t.from}>${t.to}`}>
              <Pick label="from todo status" value={t.from} options={statuses} onChange={(v) => editTrigger(i, { from: v })} />
              <span className="arrow">→</span>
              <Pick label="to todo status" value={t.to} options={statuses} onChange={(v) => editTrigger(i, { to: v })} />
              <span className="arrow">moves Jira to</span>
              <JiraPick label="Jira status" value={t.jira} options={jiraStatuses} onChange={(v) => editTrigger(i, { jira: v })} />
              <button type="button" className="x" aria-label="remove trigger" onClick={() => editOut({ triggers: out.triggers.filter((_, j) => j !== i) })}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="add" onClick={() => editOut({ triggers: [...out.triggers, { from: "", to: "", jira: "" }] })}><span className="pl">+</span>trigger</button>

        <div className="label sub">Try a move</div>
        <div className="rule-row tester">
          <Pick label="test from" value={test.from} options={statuses} onChange={(v) => setTest({ ...test, from: v })} />
          <span className="arrow">→</span>
          <Pick label="test to" value={test.to} options={statuses} onChange={(v) => setTest({ ...test, to: v })} />
          <span className="result">{describeMove(out, test.from, test.to)}</span>
        </div>
      </section>

      {problems.length > 0 && (
        <ul className="problems">
          {problems.map((p) => <li key={p.message} className={p.level}>{p.message}</li>)}
        </ul>
      )}
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || errors.length > 0} onClick={save}>{pending ? "saving…" : "save"}</button>
        {saved?.ok && <span className="hint">Saved. The sync uses it from its next pass.</span>}
        {saved && !saved.ok && <span className="hot">Not saved: {saved.problems.filter((p) => p.level === "error").map((p) => p.message).join(" ")}</span>}
      </div>
    </div>
  );
}
