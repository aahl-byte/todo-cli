import Link from "next/link";
import { Led } from "@/components/ui";
import { deriveCalcStatus, PAST_TRIAGE } from "@/lib/model";
import type { Card } from "@/lib/views";

const untriaged = (c: Card) => !!c.request_meta && !c.request_meta.triaged && PAST_TRIAGE.includes(c.status);

export function initials(h?: string | null) {
  return h ? h.replace(/^jira:/, "").split(/[\s._-]+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase() : "";
}

/** Watchtower's progress glance: one capsule per phase over one dot per task. */
function Glance({ c }: { c: Card }) {
  if (!c.task_statuses?.length) return null;
  const phases: { key: number; statuses: string[] }[] = [];
  c.task_statuses.forEach((s, i) => {
    const k = c.task_phases[i];
    const last = phases[phases.length - 1];
    if (last && last.key === k) last.statuses.push(s); else phases.push({ key: k, statuses: [s] });
  });
  return (
    <span className="glance" data-tip={`${c.task_statuses.filter((s) => s === "done" || s === "deployed").length}/${c.task_statuses.length} tasks`}>
      <span className="layer">{phases.map((p, i) => <span key={i} className={`cap s-${deriveCalcStatus(p.statuses) ?? "todo"}`} />)}</span>
      <span className="layer">{c.task_statuses.map((s, i) => <span key={i} className={`dot s-${s}`} />)}</span>
    </span>
  );
}

/** A board card: status, title, where it lives, and its badges. */
export function BoardCard({ c, project, who, led, current }: {
  c: Card; project: string; who: string | null; led: boolean; current?: boolean;
}) {
  return (
    <Link href={`/p/${project}/i/${c.id}`} className={`card s-${c.status} ${c.open_questions > 0 ? "asking" : ""}`} data-uid={c.uid}
          aria-current={current ? "page" : undefined}>
      {c.open_questions > 0 && <span className="asks" data-tip={`${c.open_questions} open question${c.open_questions > 1 ? "s" : ""}`}>?</span>}
      {led && <Led status={c.status} label />}
      <div className="title">{c.title}</div>
      {c.extra?.app ? <div className="where">{c.extra.app}{c.extra.section && ` · ${c.extra.section}`}</div>
        : c.extra?.epic && <div className="where" data-tip="epic">{c.extra.epic}</div>}
      <div className="meta">
        {who && <span className="av" data-tip={[c.developer && `dev ${c.developer}`, c.qa_assignee && `qa ${c.qa_assignee}`].filter(Boolean).join(" · ")}>{initials(who)}</span>}
        {c.jira.map((j) => <span key={j.key} className="tag key" data-tip={j.status ?? undefined}>{j.key}</span>)}
        {c.type !== "feature" && <span className={`tag type ${c.type}`}>{c.type}</span>}
        {(c.priority === "high" || c.priority === "urgent") && <span className="tag hot">{c.priority}</span>}
        {untriaged(c) && <span className="tag hot" data-tip="the request being worked on never went through triage">v{c.request_meta!.version} untriaged</span>}
        {c.pending_pre > 0 && <span className="tag" data-tip="pending pre-deploy checks">checks {c.pending_pre}</span>}
        {c.last_via === "agent" && <span className="ai" data-tip="last moved by an agent">AI</span>}
        <Glance c={c} />
      </div>
    </Link>
  );
}
