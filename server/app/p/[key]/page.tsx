import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardFilters } from "@/components/BoardFilters";
import { Led } from "@/components/ui";
import { db } from "@/lib/db";
import { deriveCalcStatus, PAST_TRIAGE } from "@/lib/model";
import { requireUser } from "@/lib/session";
import { board, project, users, type BoardFilters as F, type Card } from "@/lib/views";

type Search = Record<string, string | undefined>;

const untriaged = (c: Card) => !!c.request_meta && !c.request_meta.triaged && PAST_TRIAGE.includes(c.status);

function initials(h?: string | null) {
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

export default async function Board({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Search> }) {
  const { key } = await params;
  const q = await searchParams;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const f: F = { mine: q.mine === "1", review: q.review === "1", developer: q.dev, qa: q.qa, type: q.type, parked: q.parked === "1" };
  const columns = await board(d, p, f, user.handle);
  return (
    <>
      <BoardFilters users={(await users(d)).map((u) => u.handle)} />
      <div className="board">
        {columns.map((col) => (
          <section key={col.key} className={`column ${col.items.length ? "" : "empty-col"}`} aria-label={col.label}>
            <div className="label">{col.label}{col.items.length > 0 && <span>{col.items.length}</span>}</div>
            {col.items.map((c) => {
              const who = col.key === "qa" ? c.qa_assignee : c.developer ?? (col.key === "requested" ? c.creator : null);
              return (
                <Link key={c.uid} href={`/p/${key}/i/${c.id}`} className={`card s-${c.status}`} data-uid={c.uid}>
                  {c.status !== col.statuses[0] && <Led status={c.status} label />}
                  <div className="title">{c.title}</div>
                  {c.extra?.app && <div className="where">{c.extra.app}{c.extra.section && ` · ${c.extra.section}`}</div>}
                  <div className="meta">
                    {who && <span className="av" data-tip={[c.developer && `dev ${c.developer}`, c.qa_assignee && `qa ${c.qa_assignee}`].filter(Boolean).join(" · ")}>{initials(who)}</span>}
                    {c.type === "bug" && <span className="tag bug">bug</span>}
                    {(c.priority === "high" || c.priority === "urgent") && <span className="tag hot">{c.priority}</span>}
                    {c.open_questions > 0 && <span className="tag hot" data-tip="open questions">?{c.open_questions}</span>}
                    {untriaged(c) && <span className="tag hot" data-tip="the request being worked on never went through triage">v{c.request_meta!.version} untriaged</span>}
                    {c.pending_pre > 0 && <span className="tag" data-tip="pending pre-deploy checks">checks {c.pending_pre}</span>}
                    {c.last_via === "agent" && <span className="ai" data-tip="last moved by an agent">AI</span>}
                    <Glance c={c} />
                  </div>
                </Link>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
