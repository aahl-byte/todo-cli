"use client";
import { useMemo, useState, useTransition } from "react";
import { saveJiraSettingsAction } from "@/app/settings-actions";
import { ANY, describeMove, validateRules, type OutboundRules, type Problem, type Trigger } from "@/lib/jira/rules";

export function JiraPick({ value, options, onChange, label }: { value: string; options: string[] | null; onChange: (v: string) => void; label: string }) {
  if (!options) return <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} placeholder="Jira status" />;
  const all = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">—</option>}
      {all.map((s) => <option key={s} value={s}>{s}{options.includes(s) ? "" : " (not in Jira)"}</option>)}
    </select>
  );
}

/** A todo status; with `any`, `*` first, for any status. */
export function Pick({ value, options, onChange, label, any = false }: {
  value: string; options: readonly string[]; onChange: (v: string) => void; label: string; any?: boolean;
}) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {!value && <option value="">—</option>}
      {any && <option value={ANY}>any status</option>}
      {options.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}

/** Triggers as the editor holds them: whether they send (null while some do and some don't), what's never moved to, and each row. */
export interface TriggerSet<T extends Trigger> { writes: boolean | null; never: string[]; triggers: T[] }

/** The rules a set stands for, to check and try; rows the editor only keeps don't move anything. */
export const asRules = <T extends Trigger>(set: TriggerSet<T>, moves: (t: T) => boolean = () => true): OutboundRules =>
  ({ writes: !!set.writes, never: set.never, triggers: set.triggers.filter(moves) });

/** The todo → Jira triggers: the send switch, what's never moved to, a row per trigger and a move to try. The Jira bridge's form
 * and jira-transition's share it; `ordered` shows the order, which decides when `*` lets two triggers fit one move. */
export function JiraTriggers<T extends Trigger>({ value, onChange, statuses, jiraStatuses, sendLock, blank, ordered = false, any = false, kept }: {
  value: TriggerSet<T>; onChange: (v: TriggerSet<T>) => void; statuses: readonly string[]; jiraStatuses: string[] | null;
  /** Why sending is locked off, or null when it can be switched. */
  sendLock: string | null;
  blank: () => T; ordered?: boolean; any?: boolean;
  /** How to show a row the editor keeps as it is, rather than as a trigger; null for a trigger row. */
  kept?: (t: T) => string | null;
}) {
  const [neverDraft, setNeverDraft] = useState("");
  const [test, setTest] = useState({ from: "review", to: "ready-for-qa" });
  const edit = (patch: Partial<TriggerSet<T>>) => onChange({ ...value, ...patch });
  const editTrigger = (i: number, patch: Partial<T>) => edit({ triggers: value.triggers.map((t, j) => (j === i ? { ...t, ...patch } : t)) });
  const swap = (i: number, j: number) => {
    const list = [...value.triggers];
    [list[i], list[j]] = [list[j], list[i]];
    edit({ triggers: list });
  };
  const rules = asRules(value, (t) => !kept?.(t));
  const on = value.writes === true && !sendLock;
  return (
    <>
      <label className="switch">
        <input type="checkbox" checked={on} disabled={!!sendLock} ref={(el) => { if (el) el.indeterminate = value.writes === null && !sendLock; }}
               onChange={(e) => edit({ writes: e.target.checked })} />
        Send to Jira
        <span className="hint">{sendLock ?? (value.writes === null ? "Some triggers send and some only record; switching sets them all."
          : value.writes ? "On: triggered calls are sent." : "Off: triggered calls are only recorded below.")}</span>
      </label>
      <p className="hint">A trigger moves every Jira issue the item links. Comments stay in todo.</p>
      <div className="rule-row">
        <span className="hint">Never move Jira to</span>
        <span className="chips">
          {value.never.map((n) => (
            <span key={n} className="chip">{n}<button type="button" className="x" aria-label={`allow ${n}`} onClick={() => edit({ never: value.never.filter((x) => x !== n) })}>✕</button></span>
          ))}
          <JiraPick label="never move to" value={neverDraft} options={jiraStatuses} onChange={setNeverDraft} />
          <button type="button" className="btn" disabled={!neverDraft.trim()} onClick={() => { edit({ never: [...value.never, neverDraft.trim()] }); setNeverDraft(""); }}>add</button>
        </span>
      </div>
      <div className="label sub">Triggers</div>
      {ordered && value.triggers.length > 1 && <p className="hint">Only the first trigger that fits a move runs, in this order.</p>}
      <div className="rule-table">
        {value.triggers.map((t, i) => {
          const keptAs = kept?.(t) ?? null;
          return (
            <div className={`rule-row${keptAs ? " kept" : ""}`} key={i} data-trigger={`${t.from}>${t.to}`}>
              {ordered && <span className="faint order-n">{i + 1}.</span>}
              {keptAs ? <span className="grow hint">{keptAs}</span> : (
                <>
                  <Pick label="from todo status" value={t.from} options={statuses} any={any} onChange={(v) => editTrigger(i, { from: v } as Partial<T>)} />
                  <span className="arrow">→</span>
                  <Pick label="to todo status" value={t.to} options={statuses} any={any} onChange={(v) => editTrigger(i, { to: v } as Partial<T>)} />
                  <span className="arrow">moves Jira to</span>
                  <JiraPick label="Jira status" value={t.jira} options={jiraStatuses} onChange={(v) => editTrigger(i, { jira: v } as Partial<T>)} />
                </>
              )}
              {ordered && (
                <span className="order">
                  <button type="button" className="x" aria-label={`move trigger ${i + 1} up`} disabled={i === 0} onClick={() => swap(i, i - 1)}>▲</button>
                  <button type="button" className="x" aria-label={`move trigger ${i + 1} down`} disabled={i === value.triggers.length - 1} onClick={() => swap(i, i + 1)}>▼</button>
                </span>
              )}
              <button type="button" className="x" aria-label="remove trigger" onClick={() => edit({ triggers: value.triggers.filter((_, j) => j !== i) })}>✕</button>
            </div>
          );
        })}
      </div>
      <button type="button" className="add" onClick={() => edit({ triggers: [...value.triggers, blank()] })}><span className="pl">+</span>trigger</button>

      <div className="label sub">Try a move</div>
      <div className="rule-row tester">
        <Pick label="test from" value={test.from} options={statuses} onChange={(v) => setTest({ ...test, from: v })} />
        <span className="arrow">→</span>
        <Pick label="test to" value={test.to} options={statuses} onChange={(v) => setTest({ ...test, to: v })} />
        <span className="result">{describeMove(rules, test.from, test.to)}</span>
      </div>
    </>
  );
}

export function Problems({ problems }: { problems: Problem[] }) {
  if (!problems.length) return null;
  return (
    <ul className="problems">
      {problems.map((p) => <li key={p.message} className={p.level}>{p.message}</li>)}
    </ul>
  );
}

export function JiraSettingsForm({ projectKey, outbound, statuses, jiraStatuses, serverReadOnly, movedTo }: {
  projectKey: string; outbound: OutboundRules; statuses: readonly string[]; jiraStatuses: string[] | null; serverReadOnly: boolean;
  /** The repos where jira-transition sends this project's moves, which keeps the bridge from sending. */
  movedTo: string[];
}) {
  const [out, setOut] = useState<OutboundRules>(outbound);
  const [saved, setSaved] = useState<{ ok: boolean; problems: Problem[] } | null>(null);
  const [pending, start] = useTransition();

  const problems = useMemo(() => validateRules(out, statuses, jiraStatuses), [out, statuses, jiraStatuses]);
  const errors = problems.filter((p) => p.level === "error");
  const save = () => start(async () => setSaved(await saveJiraSettingsAction(projectKey, out)));
  const sendLock = serverReadOnly ? "Locked off: this server is read-only (JIRA_READ_ONLY)."
    : movedTo.length && !out.writes ? `Locked off: jira-transition moves this project's tickets in ${movedTo.join(", ")}.` : null;

  return (
    <div className="jira-settings">
      <section>
        <div className="label section">Jira → todo</div>
        <p className="hint">A linked issue's status shows next to its key and never moves the item.</p>
      </section>

      <section>
        <div className="label section">todo → Jira</div>
        {movedTo.length > 0 && (
          <p className="hint">jira-transition moves tickets in {movedTo.join(", ")}, on Settings → Automation; triggers added here only record.</p>
        )}
        <JiraTriggers value={out} onChange={(v) => { setOut({ ...v, writes: !!v.writes }); setSaved(null); }} statuses={statuses}
                      jiraStatuses={jiraStatuses} sendLock={sendLock} blank={() => ({ from: "", to: "", jira: "" })} />
      </section>

      <Problems problems={problems} />
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || errors.length > 0} onClick={save}>{pending ? "saving…" : "save"}</button>
        {saved?.ok && <span className="hint">Saved. The sync uses it from its next pass.</span>}
        {saved && !saved.ok && <span className="hot">Not saved: {saved.problems.filter((p) => p.level === "error").map((p) => p.message).join(" ")}</span>}
      </div>
    </div>
  );
}
