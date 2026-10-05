"use client";
import { useMemo, useState, useTransition } from "react";
import { saveJiraSettingsAction } from "@/app/settings-actions";
import { describeMove, validateRules, type InboundRules, type OutboundRules, type Problem, type Trigger } from "@/lib/jira/rules";

type StatusSet = { jira: string; statuses: string[] };
type Rule = { from: string; to: string; status: string };

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

export function JiraSettingsForm({ projectKey, inbound, outbound, statuses, jiraStatuses, serverReadOnly }: {
  projectKey: string; inbound: InboundRules; outbound: OutboundRules; statuses: readonly string[];
  jiraStatuses: string[] | null; serverReadOnly: boolean;
}) {
  const [sets, setSets] = useState<StatusSet[]>(Object.entries(inbound.statuses).map(([jira, s]) => ({ jira, statuses: [...s] })));
  const [rules, setRules] = useState<Rule[]>(inbound.transitions ?? []);
  const [out, setOut] = useState<OutboundRules>(outbound);
  const [neverDraft, setNeverDraft] = useState("");
  const [test, setTest] = useState({ from: "review", to: "ready-for-qa" });
  const [saved, setSaved] = useState<{ ok: boolean; problems: Problem[] } | null>(null);
  const [pending, start] = useTransition();

  const inboundNow: InboundRules = useMemo(
    () => ({ statuses: Object.fromEntries(sets.map((s) => [s.jira, s.statuses])), transitions: rules }), [sets, rules]);
  const problems = useMemo(() => validateRules(inboundNow, out, statuses, jiraStatuses), [inboundNow, out, statuses, jiraStatuses]);
  const errors = problems.filter((p) => p.level === "error");
  const used = new Set(sets.flatMap((s) => s.statuses));
  const unmirrored = (jiraStatuses ?? []).filter((j) => !sets.some((s) => s.jira.toLowerCase() === j.toLowerCase()));
  const setNames = sets.map((s) => s.jira).filter(Boolean);

  const editSet = (i: number, f: (s: StatusSet) => StatusSet) => { setSets(sets.map((s, j) => (j === i ? f(s) : s))); setSaved(null); };
  const editRule = (i: number, patch: Partial<Rule>) => { setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r))); setSaved(null); };
  const editOut = (patch: Partial<OutboundRules>) => { setOut({ ...out, ...patch }); setSaved(null); };
  const editTrigger = (i: number, patch: Partial<Trigger>) =>
    editOut({ triggers: out.triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const save = () => start(async () => setSaved(await saveJiraSettingsAction(projectKey, inboundNow, out)));

  return (
    <div className="jira-settings">
      <section>
        <div className="label section">Jira → todo</div>
        <p className="hint">Each Jira status covers a set of todo statuses. An item moved in Jira lands on the first, unless it already sits in the set.</p>
        <div className="rule-table">
          {sets.map((s, i) => (
            <div className="rule-row" key={i} data-set={s.jira}>
              <JiraPick label="Jira status" value={s.jira} options={jiraStatuses} onChange={(v) => editSet(i, (x) => ({ ...x, jira: v }))} />
              <span className="arrow">→</span>
              <span className="chips">
                {s.statuses.map((st, k) => (
                  <span key={st} className={`chip${k === 0 ? " first" : ""}`} data-tip={k === 0 ? "lands here" : undefined}>
                    {st}
                    {k > 0 && <button type="button" className="x" aria-label={`make ${st} first`}
                                      onClick={() => editSet(i, (x) => ({ ...x, statuses: [st, ...x.statuses.filter((y) => y !== st)] }))}>↑</button>}
                    <button type="button" className="x" aria-label={`remove ${st}`}
                            onClick={() => editSet(i, (x) => ({ ...x, statuses: x.statuses.filter((y) => y !== st) }))}>✕</button>
                  </span>
                ))}
                <select aria-label="add todo status" value="" onChange={(e) => e.target.value && editSet(i, (x) => ({ ...x, statuses: [...x.statuses, e.target.value] }))}>
                  <option value="">+ status</option>
                  {statuses.filter((st) => !used.has(st)).map((st) => <option key={st} value={st}>{st}</option>)}
                </select>
              </span>
              <button type="button" className="x" aria-label={`remove ${s.jira || "set"}`} onClick={() => { setSets(sets.filter((_, j) => j !== i)); setSaved(null); }}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="add" onClick={() => setSets([...sets, { jira: "", statuses: [] }])}><span className="pl">+</span>status set</button>
        {unmirrored.length > 0 && <p className="hint">Not mirrored: {unmirrored.join(", ")}</p>}

        <div className="label sub">Specific Jira moves</div>
        <div className="rule-table">
          {rules.map((r, i) => (
            <div className="rule-row" key={i}>
              <Pick label="from Jira status" value={r.from} options={setNames} onChange={(v) => editRule(i, { from: v })} />
              <span className="arrow">→</span>
              <Pick label="to Jira status" value={r.to} options={setNames} onChange={(v) => editRule(i, { to: v })} />
              <span className="arrow">means</span>
              <Pick label="todo status" value={r.status} options={statuses} onChange={(v) => editRule(i, { status: v })} />
              <button type="button" className="x" aria-label="remove rule" onClick={() => { setRules(rules.filter((_, j) => j !== i)); setSaved(null); }}>✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="add" onClick={() => setRules([...rules, { from: "", to: "", status: "" }])}><span className="pl">+</span>move rule</button>
      </section>

      <section>
        <div className="label section">todo → Jira</div>
        <label className="switch">
          <input type="checkbox" checked={out.writes && !serverReadOnly} disabled={serverReadOnly} onChange={(e) => editOut({ writes: e.target.checked })} />
          Send to Jira
          <span className="hint">{serverReadOnly ? "Locked off: this server is read-only (JIRA_READ_ONLY)." : out.writes ? "On: triggered calls are sent." : "Off: triggered calls are only recorded below."}</span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={out.comments} onChange={(e) => editOut({ comments: e.target.checked })} />
          Post comments
        </label>
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
          <span className="result">{describeMove(sets.length ? inboundNow : null, out, test.from, test.to)}</span>
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
