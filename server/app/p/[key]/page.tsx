import Link from "next/link";
import { notFound } from "next/navigation";
import { Initials, StatusPill, TaskBar } from "@/components/bits";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { board, project, users, type BoardFilters } from "@/lib/views";

type Search = Record<string, string | undefined>;

function href(key: string, q: Search, patch: Search): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...q, ...patch })) if (v) next.set(k, v);
  const s = next.toString();
  return `/p/${key}${s ? `?${s}` : ""}`;
}

export default async function Board({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Search> }) {
  const { key } = await params;
  const q = await searchParams;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const f: BoardFilters = { mine: q.mine === "1", review: q.review === "1", developer: q.dev, qa: q.qa, type: q.type, parked: q.parked === "1" };
  const columns = await board(d, p, f, user.handle);
  const people = (await users(d)).map((u) => u.handle);
  const toggle = (k: string) => (q[k] === "1" ? undefined : "1");
  return (
    <>
      <form className="filters" action={`/p/${key}`}>
        <Link href={href(key, q, { mine: toggle("mine") })}><button type="button" className={f.mine ? "primary" : ""}>Mine</button></Link>
        <Link href={href(key, q, { review: toggle("review") })}><button type="button" className={f.review ? "primary" : ""}>Needs my review</button></Link>
        <label>Dev <select name="dev" defaultValue={q.dev ?? ""}><option value="">anyone</option>{people.map((h) => <option key={h}>{h}</option>)}</select></label>
        <label>QA <select name="qa" defaultValue={q.qa ?? ""}><option value="">anyone</option>{people.map((h) => <option key={h}>{h}</option>)}</select></label>
        <label>Type <select name="type" defaultValue={q.type ?? ""}><option value="">any</option><option>feature</option><option>bug</option></select></label>
        <label><input type="checkbox" name="parked" value="1" defaultChecked={f.parked} /> show parked</label>
        {f.mine && <input type="hidden" name="mine" value="1" />}
        {f.review && <input type="hidden" name="review" value="1" />}
        <button>Apply</button>
      </form>
      <div className="board">
        {columns.map((col) => (
          <section key={col.key} className="column" aria-label={col.label}>
            <h3>{col.label} <span className="muted">{col.items.length}</span></h3>
            {col.items.map((c) => (
              <Link key={c.uid} href={`/p/${key}/i/${c.id}`} className={`card${c.status === "blocked" ? " blocked" : ""}`} data-uid={c.uid}>
                <div className="meta">
                  <span className="mono">{c.id}</span>
                  <span title={c.type}>{c.type === "bug" ? "🐞" : "◆"}</span>
                  {c.jira_key && <span className="mono">{c.jira_key}</span>}
                </div>
                <div className="title">{c.title}</div>
                <div className="meta">
                  <StatusPill status={c.status} />
                  <span>{c.priority}</span>
                  <Initials handle={c.developer} label="dev" />
                  <Initials handle={c.qa_assignee} label="qa" />
                  {c.open_questions > 0 && <span title="open clarifications">? {c.open_questions}</span>}
                  {c.pending_pre > 0 && <span title="pending pre-deploy checks">⛔ {c.pending_pre}</span>}
                  {["deployed", "done"].includes(c.status) && c.pending_post > 0 && <span title="pending post-deploy checks">⛔ {c.pending_post} post</span>}
                </div>
                <TaskBar statuses={c.task_statuses} />
              </Link>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
