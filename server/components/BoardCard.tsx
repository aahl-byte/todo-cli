import Link from "next/link";
import type { CSSProperties } from "react";
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

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const flagCount = (c: Card) => Number(!!c.unseen_comments) + Number(!!c.unseen_answers) + Number(c.open_questions > 0 || !!c.my_open_questions);
const hasFlags = (c: Card) => flagCount(c) > 0;

function CommentIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H7l-3 2.5v-2.5H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" />
    </svg>
  );
}

/** Top-right flags: unseen comments, unseen answers to my questions, then open questions. */
function Flags({ c }: { c: Card }) {
  if (!hasFlags(c)) return null;
  return (
    <span className="flags">
      {!!c.unseen_comments && <span className="flag comments" data-tip={`${plural(c.unseen_comments, "comment")} since you last looked`}><CommentIcon /></span>}
      {!!c.unseen_answers && <span className="flag answers" data-tip={`${plural(c.unseen_answers, "answer")} to your questions since you last looked`}>↩</span>}
      {c.open_questions > 0
        ? <span className="flag asks" data-tip={plural(c.open_questions, "open question")}>?</span>
        : !!c.my_open_questions && <span className="flag asks mine" data-tip={`${plural(c.my_open_questions, "question")} of yours, waiting on an answer`}>?</span>}
    </span>
  );
}

/** Whose initials a card shows in a board column: QA's in the QA column, else the developer's, else a request's author. */
export function columnWho(column: string, c: Card): string | null {
  return column === "qa" ? c.qa_assignee : c.developer ?? (c.status === "requested" ? c.creator : null);
}

/** A board card: status, title, where it lives, and its badges. */
export function BoardCard({ c, project, who, led, current, base = `/p/${project}` }: {
  c: Card; project: string; who: string | null; led: boolean; current?: boolean;
  /** Where item links start; a wall display keeps them inside its own pages. */
  base?: string;
}) {
  const props = { className: `card s-${c.status} ${hasFlags(c) ? "flagged" : ""}`, "data-uid": c.uid,
                  style: hasFlags(c) ? ({ "--flags": flagCount(c) } as CSSProperties) : undefined };
  return (
    <Link href={`${base}/i/${c.id}`} {...props} aria-current={current ? "page" : undefined}>
      <Flags c={c} />
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
