"use client";
// Watchtower's at-a-glance task view: the rolled-up status, one glowing capsule
// per phase, one glowing dot per task.
import { deriveCalcStatus } from "@/lib/model";
import { Led } from "../ui";

type Row = Record<string, any>;

export function Glance({ tasks, titles = {}, onOpen }: { tasks: Row[]; titles?: Record<string, string>; onOpen: () => void }) {
  if (!tasks.length) return null;
  const phases: { key: string; statuses: string[] }[] = [];
  for (const t of tasks) {
    const key = t.phase === null ? "none" : String(t.phase);
    const last = phases[phases.length - 1];
    if (last && last.key === key) last.statuses.push(t.status);
    else phases.push({ key, statuses: [t.status] });
  }
  const calc = deriveCalcStatus(tasks.map((t) => t.status)) ?? "todo";
  const done = tasks.filter((t) => t.status === "done" || t.status === "deployed").length;
  return (
    <button type="button" className="glance-block" aria-label={`tasks: ${calc}, ${done} of ${tasks.length} done`} onClick={onOpen}
            data-tip={`${done}/${tasks.length} tasks done`}>
      <Led status={calc} label />
      <span className="layer">{phases.map((p) => <span key={p.key} className={`cap s-${deriveCalcStatus(p.statuses) ?? "todo"}`} data-tip={`${p.key === "none" ? "no phase" : `phase ${p.key}${titles[p.key] ? ` · ${titles[p.key]}` : ""}`}: ${deriveCalcStatus(p.statuses)}`} />)}</span>
      <span className="layer">{tasks.map((t) => <span key={t.uid} className={`dot s-${t.status}`} />)}</span>
    </button>
  );
}
