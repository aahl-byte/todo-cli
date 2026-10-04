"use client";
// Tasks in the watchtower drawer's idiom: grouped by phase, finished work folded
// away, a status light that opens a picker (shift-click: todo, ctrl/cmd-click:
// done), click-to-edit titles, and a phase chip that shows on hover.
import { useRef, useState } from "react";
import * as act from "@/app/item-actions";
import { COMPLETE, PARKED } from "@/lib/model";
import { EditableText, Led, Menu } from "../ui";
import { AddBox, report, Remove, type Ctx } from "./ItemView";

type Row = Record<string, any>;
const finished = (s: string) => COMPLETE.includes(s) || PARKED.includes(s);
const keyOf = (phase: number | null) => (phase === null ? "none" : String(phase));
// The statuses a task moves through; the QA and deploy ones belong to items.
const TASK_STATUSES = ["todo", "in-triage", "in-progress", "review", "blocked", "done", "deferred", "cancelled"];

export function Tasks({ tasks, ctx, focus }: { tasks: Row[]; ctx: Ctx; focus: string | null }) {
  const [showDone, setShowDone] = useState(false);
  const [pinnedPhase, setPinnedPhase] = useState<Record<string, boolean>>({});
  const groups: { phase: number | null; rows: Row[] }[] = [];
  for (const t of tasks) {
    const last = groups[groups.length - 1];
    if (last && last.phase === t.phase) last.rows.push(t);
    else groups.push({ phase: t.phase, rows: [t] });
  }
  const anyFinished = tasks.some((t) => finished(t.status));
  const focusN = focus?.startsWith("t-") ? Number(focus.slice(2)) : null;

  return (
    <>
      <AddTask ctx={ctx} lastPhase={groups.length ? groups[groups.length - 1].phase : null} />
      {tasks.length > 0 && (
        <div className="list-head">
          {anyFinished && (
            <button type="button" className="more right" onClick={() => { setShowDone((s) => !s); setPinnedPhase({}); }}>
              {showDone ? "hide done" : "show done"}
            </button>
          )}
        </div>
      )}
      {groups.map((g) => {
        const k = keyOf(g.phase);
        const hidden = g.rows.filter((t) => finished(t.status) && t.n !== focusN);
        const allFinished = hidden.length === g.rows.length;
        const mode = k in pinnedPhase ? (pinnedPhase[k] ? "all" : "none") : showDone ? "all" : allFinished ? "none" : "open";
        const shown = mode === "all" ? g.rows : mode === "none" ? [] : g.rows.filter((t) => !finished(t.status) || t.n === focusN);
        const folded = g.rows.length - shown.length;
        return (
          <div key={k}>
            <button type="button" className="tgroup" aria-expanded={mode !== "none"}
                    onClick={() => setPinnedPhase((p) => ({ ...p, [k]: mode !== "all" }))}>
              <span className={`chev ${mode !== "none" ? "open" : ""}`}>›</span>
              {g.phase === null ? "no phase" : `phase ${g.phase}`}
              {folded > 0 && <span className="faint">· {folded} done</span>}
            </button>
            {shown.map((t) => <TaskRow key={t.uid} t={t} ctx={ctx} focus={t.n === focusN} />)}
          </div>
        );
      })}
    </>
  );
}

function TaskRow({ t, ctx, focus }: { t: Row; ctx: Ctx; focus: boolean }) {
  const pinned = useRef(t.versions);
  const latest = useRef(t.versions);
  latest.current = t.versions;
  const [phaseEdit, setPhaseEdit] = useState(false);
  const [phaseDraft, setPhaseDraft] = useState("");
  const save = async (data: { status?: string; title?: string; phase?: number | null }) => {
    const ok = report(await act.setTask({ project: ctx.project, itemUid: ctx.itemUid, uid: t.uid, versions: pinned.current, data }));
    if (!ok) pinned.current = latest.current;
    return ok;
  };
  const set = (data: { status?: string; title?: string; phase?: number | null }) => void save(data);
  const commitPhase = async () => {
    const v = phaseDraft.trim();
    const phase = v === "" ? null : Number(v);
    if ((phase !== null && !Number.isInteger(phase)) || phase === t.phase) { setPhaseEdit(false); return; }
    if (await save({ phase })) setPhaseEdit(false);
  };
  return (
    <div id={`t-${t.n}`} className={`trow s-${t.status} ${finished(t.status) ? "fin" : ""} ${focus ? "focus" : ""}`} data-uid={t.uid}>
      <span className="quick" onClickCapture={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          pinned.current = t.versions;
          set({ status: e.shiftKey ? "todo" : "done" });
        }
      }}>
        <Menu label={`task ${t.n} status`} tip={`${t.status} · shift: todo · ctrl: done`} className="dotbtn"
              onOpen={() => { pinned.current = t.versions; }}
              trigger={<Led status={t.status} />} current={t.status}
              options={(TASK_STATUSES.includes(t.status) ? TASK_STATUSES : [t.status, ...TASK_STATUSES]).map((s) => ({ value: s, label: <Led status={s} label /> }))}
              onPick={(status) => { if (status !== t.status) set({ status }); }} />
      </span>
      <span className="tid">{t.n}</span>
      <span className="ttitle">
        <EditableText value={t.title} label={`task ${t.n} title`} onStart={() => { pinned.current = t.versions; }}
                      onSave={(title) => save({ title })} />
      </span>
      {phaseEdit ? (
        <input className="tphase-in" autoFocus inputMode="numeric" aria-label="phase" value={phaseDraft}
               onChange={(e) => setPhaseDraft(e.target.value)} onBlur={() => void commitPhase()}
               onKeyDown={(e) => { if (e.key === "Enter") void commitPhase(); if (e.key === "Escape") setPhaseEdit(false); }} />
      ) : (
        <button type="button" className="tphase x" aria-label="set phase" data-tip="phase"
                onClick={() => { pinned.current = t.versions; setPhaseDraft(t.phase === null ? "" : String(t.phase)); setPhaseEdit(true); }}>
          {t.phase === null ? "P–" : `P${t.phase}`}
        </button>
      )}
      <Remove onConfirm={() => act.removeChild({ project: ctx.project, itemUid: ctx.itemUid, entity: "task", uid: t.uid, versions: t.versions })} />
    </div>
  );
}

function AddTask({ ctx, lastPhase }: { ctx: Ctx; lastPhase: number | null }) {
  const phase = useRef<HTMLInputElement>(null);
  return (
    <AddBox label="task" placeholder="Task"
            onAdd={async (title) => {
              const v = phase.current?.value.trim() ?? "";
              const p = v === "" ? null : Number(v);
              return report(await act.addTask({ project: ctx.project, itemUid: ctx.itemUid, title, phase: Number.isInteger(p) ? p : null }));
            }}>
      <input ref={phase} className="tphase-in" inputMode="numeric" aria-label="phase" placeholder="phase"
             defaultValue={lastPhase === null ? "" : String(lastPhase)} />
    </AddBox>
  );
}
