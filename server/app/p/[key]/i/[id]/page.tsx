import { notFound } from "next/navigation";
import { checkAction, itemAction, noteAction, taskAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { AutoSelect } from "@/components/AutoSelect";
import { AiBadge, Dot, StatusPill, when } from "@/components/bits";
import { Composer } from "@/components/Composer";
import { Markdown } from "@/components/Markdown";
import { db } from "@/lib/db";
import { CHECK_KINDS, LINK_TYPES, STATUSES } from "@/lib/model";
import { requireUser } from "@/lib/session";
import { item as loadItem, project, users } from "@/lib/views";
import type { Row } from "@/lib/db";

const uploads = !!process.env.BLOB_READ_WRITE_TOKEN;
const opts = (xs: readonly string[]) => xs.map((x) => ({ value: x, label: x }));

export default async function ItemPage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  const view = p && (await loadItem(d, key, id));
  if (!p || !view) notFound();
  const { item: it } = view;
  const people = (await users(d)).map((u) => u.handle);
  const ref = { project: key, uid: it.uid, item_uid: it.uid };
  const child = (r: Row) => ({ project: key, uid: r.uid, item_uid: it.uid });

  return (
    <div data-uid={it.uid}>
      <header style={{ marginBottom: 12 }}>
        <div className="row muted">
          <span className="mono">{it.id}</span>
          {it.jira_key && <span className="mono">{it.jira_key}</span>}
          <span>{it.type}</span>
          <span>priority {it.priority}</span>
        </div>
        <ActionForm action={itemAction} fields={{ ...ref, action: "edit" }} versions={it.versions} resetOnOk={false}>
          <div className="row">
            <input name="title" defaultValue={it.title} aria-label="title" style={{ fontSize: 18, fontWeight: 600, flex: 1, minWidth: 240 }} />
            <select name="type" defaultValue={it.type} aria-label="type"><option>feature</option><option>bug</option></select>
            <select name="priority" defaultValue={it.priority ?? "medium"} aria-label="priority">
              {["low", "medium", "high", "urgent"].map((x) => <option key={x}>{x}</option>)}
            </select>
            <button>Save</button>
          </div>
        </ActionForm>
        <div className="row" style={{ marginTop: 8 }}>
          <StatusPill status={it.status} />
          {it.calc_status && <span className="muted">tasks: <StatusPill status={it.calc_status} /></span>}
          <NextSteps it={it} keyName={key} deployStep={p.deploy_step} />
        </div>
        <SetStatus it={it} keyName={key} />
        <ActionForm action={itemAction} fields={{ ...ref, action: "people" }} versions={it.versions} resetOnOk={false}>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="muted">creator</span> <span className="mono">{it.creator ?? "—"}</span>
            <label>developer <select name="developer" defaultValue={it.developer ?? ""}><option value="">—</option>{people.map((h) => <option key={h}>{h}</option>)}{it.developer && !people.includes(it.developer) && <option>{it.developer}</option>}</select></label>
            <label>QA <select name="qa" defaultValue={it.qa_assignee ?? ""}><option value="">—</option>{people.map((h) => <option key={h}>{h}</option>)}{it.qa_assignee && !people.includes(it.qa_assignee) && <option>{it.qa_assignee}</option>}</select></label>
            <button>Save people</button>
          </div>
        </ActionForm>
      </header>

      <div className="item-grid">
        <div>
          {view.requests.map((n) => (
            <details key={n.uid} className="request" open={String(n.text).split("\n").length <= 6}>
              <summary>Original request — external context ({n.author ?? "unknown"})</summary>
              <Markdown text={n.text} />
            </details>
          ))}

          <h2>Open questions</h2>
          {view.openQuestions.length === 0 && <p className="muted">None open.</p>}
          {view.openQuestions.map((n) => (
            <div key={n.uid} className="question" id={`n-${n.n}`} data-uid={n.uid}>
              <div className="who">[{n.n}] {n.author} <AiBadge via={n.via} /> · {when(n.ts)}</div>
              <Markdown text={n.text} />
              <ActionForm action={noteAction} fields={{ ...child(n), action: "answer" }} versions={n.versions}>
                <Composer users={people} placeholder="Answer…" required uploads={uploads} rows={2} />
                <button className="primary">Answer</button>
              </ActionForm>
            </div>
          ))}
          <ActionForm action={noteAction} fields={{ ...ref, action: "add", kind: "clarification" }}>
            <Composer users={people} placeholder="Ask a question (notifies the creator)…" required uploads={uploads} rows={2} />
            <button>Ask</button>
          </ActionForm>
          {view.answered.length > 0 && (
            <details>
              <summary className="muted">Resolved questions ({view.answered.length})</summary>
              {view.answered.map((n) => (
                <div key={n.uid} className="note" id={`n-${n.n}`}>
                  <Markdown text={n.text} />
                  <div className="who">→ {n.meta?.answered_by}: </div>
                  <Markdown text={n.meta?.answer ?? ""} />
                </div>
              ))}
            </details>
          )}

          <h2>Tasks</h2>
          {view.phases.length === 0 && <p className="muted">No tasks yet.</p>}
          {view.phases.map((ph) => (
            <section key={String(ph.phase)} className="phase">
              <header>
                <strong>{ph.phase === null ? "Unphased" : `Phase ${ph.phase}`}</strong>
                <div className="progress" title={`${ph.done}/${ph.tasks.length}`}><span style={{ width: `${(100 * ph.done) / ph.tasks.length}%` }} /></div>
                <span className="muted">{ph.done}/{ph.tasks.length}</span>
              </header>
              {ph.tasks.map((t) => (
                <div key={t.uid} className="task" data-uid={t.uid}>
                  <Dot status={t.status} />
                  <span className="mono">[{t.n}]</span>
                  <span style={{ flex: 1, minWidth: 160 }}>{t.title}</span>
                  <ActionForm action={taskAction} fields={{ ...child(t), action: "status" }} versions={t.versions}>
                    <AutoSelect name="status" value={t.status} options={opts(STATUSES)} label="task status" />
                  </ActionForm>
                  <ActionForm action={taskAction} fields={{ ...child(t), action: "phase" }} versions={t.versions}>
                    <AutoSelect name="phase" value={t.phase === null ? "" : String(t.phase)} label="task phase"
                      options={[{ value: "", label: "no phase" }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: `phase ${n}` }))]} />
                  </ActionForm>
                  <ActionForm action={taskAction} fields={{ ...child(t), action: "remove" }} versions={t.versions}>
                    <button className="link" aria-label={`remove task ${t.n}`}>remove</button>
                  </ActionForm>
                </div>
              ))}
              <AddTask ref_={ref} phase={ph.phase} />
            </section>
          ))}
          {!view.phases.some((ph) => ph.phase === null) && <AddTask ref_={ref} phase={null} label="Add a task" />}

          <h2>Context notes</h2>
          {view.context.map((n) => (
            <div key={n.uid} className="note" id={`n-${n.n}`} data-uid={n.uid}>
              <div className="who">[{n.n}] {n.author} <AiBadge via={n.via} /> · {when(n.ts)}</div>
              <Markdown text={n.text} />
            </div>
          ))}
          <ActionForm action={noteAction} fields={{ ...ref, action: "add", kind: "context" }}>
            <Composer users={people} placeholder="Add context — the why, a decision, a gotcha…" required uploads={uploads} />
            <button>Add note</button>
          </ActionForm>

          <h2>Dev log</h2>
          <DevLog logs={view.logs} />

          <h2>Comments</h2>
          {view.comments.map((n) => (
            <div key={n.uid} className="note" id={`n-${n.n}`} data-uid={n.uid}>
              <div className="who">
                {n.kind === "qa-rejection" && <span className="rejected-tag">QA rejected · </span>}
                {n.author} <AiBadge via={n.via} /> · {when(n.ts)}{n.source === "jira" && " · from Jira"}
              </div>
              <Markdown text={n.text} />
            </div>
          ))}
          <ActionForm action={noteAction} fields={{ ...ref, action: "add", kind: "comment" }}>
            <Composer users={people} placeholder="Comment — @handle to notify someone" required uploads={uploads} />
            <button className="primary">Comment</button>
          </ActionForm>
        </div>

        <aside>
          <div className="panel">
            <h2 style={{ marginTop: 0 }}>Links</h2>
            {LINK_TYPES.map((type) => {
              const rows = view.links.filter((l) => (l.meta?.type ?? "other") === type);
              return rows.length ? (
                <div key={type}>
                  <div className="muted">{type}</div>
                  {rows.map((l) => (
                    <div key={l.uid} className="row" data-uid={l.uid}>
                      <a href={l.meta?.url} target="_blank" rel="noreferrer">{l.meta?.label || l.text}</a>
                      <ActionForm action={noteAction} fields={{ ...child(l), action: "remove" }} versions={l.versions}>
                        <button className="link" aria-label="remove link">×</button>
                      </ActionForm>
                    </div>
                  ))}
                </div>
              ) : null;
            })}
            <ActionForm action={noteAction} fields={{ ...ref, action: "link" }}>
              <div className="row">
                <input name="url" placeholder="https://…" required style={{ flex: 1, minWidth: 140 }} />
                <select name="type" defaultValue="pr">{LINK_TYPES.map((x) => <option key={x}>{x}</option>)}</select>
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <input name="label" placeholder="label (optional)" style={{ flex: 1 }} />
                <button>Add link</button>
              </div>
            </ActionForm>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h2 style={{ marginTop: 0 }}>Deployment checks</h2>
            {["pre-deploy", "post-deploy"].map((timing) => (
              <div key={timing}>
                <div className="muted">{timing}</div>
                {view.checks.filter((c) => c.timing === timing).map((c) => (
                  <div key={c.uid} className="check" data-uid={c.uid}>
                    <ActionForm action={checkAction} fields={{ ...child(c), action: "toggle", status: c.status === "done" ? "pending" : "done" }} versions={c.versions}>
                      <button className="link" aria-label={c.status === "done" ? "mark pending" : "mark done"}>{c.status === "done" ? "☑" : "☐"}</button>
                    </ActionForm>
                    <div style={{ flex: 1 }}>
                      <span className="mono">[{c.n}] {c.kind}</span> {c.title}
                      {c.payload && <div><code>{c.payload}</code></div>}
                    </div>
                    <ActionForm action={checkAction} fields={{ ...child(c), action: "remove" }} versions={c.versions}>
                      <button className="link" aria-label="remove check">×</button>
                    </ActionForm>
                  </div>
                ))}
              </div>
            ))}
            <ActionForm action={checkAction} fields={{ ...ref, action: "add" }}>
              <div className="row">
                <select name="kind" defaultValue="db-script">{CHECK_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
                <select name="timing" defaultValue="pre-deploy"><option>pre-deploy</option><option>post-deploy</option></select>
              </div>
              <input name="title" placeholder="what has to happen" required style={{ width: "100%", marginTop: 4 }} />
              <div className="row" style={{ marginTop: 4 }}>
                <input name="payload" placeholder="script, variable, branch or item id" style={{ flex: 1 }} />
                <button>Add check</button>
              </div>
            </ActionForm>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <h2 style={{ marginTop: 0 }}>History {view.bounces > 0 && <span className="rejected-tag">returned from QA ×{view.bounces}</span>}</h2>
            <ol className="history" style={{ paddingLeft: 18 }}>
              {view.history.map((h) => (
                <li key={h.uid}>
                  <StatusPill status={h.from_status ?? "todo"} /> → <StatusPill status={h.to_status} />{" "}
                  <span className="muted">{h.by} <AiBadge via={h.via} /> · {when(h.ts)}{h.forced && " · forced"}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}

function AddTask({ ref_, phase, label }: { ref_: Record<string, string>; phase: number | null; label?: string }) {
  return (
    <ActionForm action={taskAction} fields={{ ...ref_, action: "add", phase: phase === null ? "" : String(phase) }}>
      <div className="row">
        <input name="title" placeholder={label ?? (phase === null ? "add an unphased task" : `add to phase ${phase}`)} required style={{ flex: 1, minWidth: 180 }} />
        <button>Add</button>
      </div>
    </ActionForm>
  );
}

function DevLog({ logs }: { logs: Row[] }) {
  const recent = logs.slice(-5);
  const line = (e: Row) => (
    <div key={e.uid} className="note" data-uid={e.uid}>
      <div className="who">[{e.n}] {when(e.ts)} · {e.author} <AiBadge via={e.via} /></div>
      <Markdown text={e.text} />
    </div>
  );
  if (!logs.length) return <p className="muted">No entries.</p>;
  return (
    <>
      {logs.length > recent.length && (
        <details><summary className="muted">show all {logs.length}</summary>{logs.slice(0, -5).map(line)}</details>
      )}
      {recent.map(line)}
    </>
  );
}

const NEXT: Record<string, { to: string; label: string }[]> = {
  requested: [{ to: "in-triage", label: "Start triage" }],
  "in-triage": [{ to: "todo", label: "Mark refined" }],
  todo: [{ to: "in-progress", label: "Start" }],
  "in-progress": [{ to: "review", label: "Send to review" }],
  review: [{ to: "ready-for-qa", label: "Ready for QA" }],
};

function NextSteps({ it, keyName, deployStep }: { it: Row; keyName: string; deployStep: boolean }) {
  const ref = { project: keyName, uid: it.uid, item_uid: it.uid, qa_assignee: it.qa_assignee ?? "" };
  const status = (to: string, label: string, extra: Record<string, string> = {}) => (
    <ActionForm key={to + label} action={itemAction} fields={{ ...ref, action: "status", to, ...extra }} versions={it.versions}>
      <button className="primary">{label}</button>
    </ActionForm>
  );
  const buttons = (NEXT[it.status] ?? []).map((n) => status(n.to, n.label));
  if (it.status === "review") {
    buttons.unshift(
      <details key="back"><summary><span className="muted">Back to work…</span></summary>
        <ActionForm action={itemAction} fields={{ ...ref, action: "back" }} versions={it.versions}>
          <textarea name="text" placeholder="Optional: what to change (posted as a comment)" rows={2} />
          <button>Back to work</button>
        </ActionForm>
      </details>);
  }
  if (it.status === "ready-for-qa") {
    buttons.push(
      <ActionForm key="pickup" action={itemAction} fields={{ ...ref, action: "pickup" }} versions={it.versions}>
        <button className="primary">Pick up</button>
      </ActionForm>);
  }
  if (it.status === "in-qa") {
    buttons.push(
      <ActionForm key="approve" action={itemAction} fields={{ ...ref, action: "approve", deploy_step: deployStep ? "1" : "0" }} versions={it.versions}>
        <button className="primary">Approve</button>
      </ActionForm>,
      <details key="reject"><summary><span className="rejected-tag">Reject…</span></summary>
        <ActionForm action={itemAction} fields={{ ...ref, action: "reject" }} versions={it.versions}>
          <textarea name="text" placeholder="What failed? (required)" required rows={3} />
          <button className="danger">Reject</button>
        </ActionForm>
      </details>);
  }
  if (it.status === "ready-to-deploy") buttons.push(<DeployButton key="deploy" it={it} keyName={keyName} />);
  return <>{buttons}</>;
}

export function DeployButton({ it, keyName }: { it: Row; keyName: string }) {
  const ref = { project: keyName, uid: it.uid, item_uid: it.uid };
  return (
    <span className="row">
      <ActionForm action={itemAction} fields={{ ...ref, action: "status", to: "deployed" }} versions={it.versions}>
        <button className="primary" disabled={it.pending_pre > 0} title={it.pending_pre ? "pre-deploy checks are pending" : ""}>Mark deployed</button>
      </ActionForm>
      {it.pending_pre > 0 && (
        <ActionForm action={itemAction} fields={{ ...ref, action: "status", to: "deployed", force: "1" }} versions={it.versions}
                    confirmLabel={`Deploy ${it.id} with ${it.pending_pre} pre-deploy check(s) still pending?`}>
          <button className="link">deploy anyway</button>
        </ActionForm>
      )}
    </span>
  );
}

function SetStatus({ it, keyName }: { it: Row; keyName: string }) {
  const choices = STATUSES.filter((s) => s !== it.status && !(it.status === "in-qa" && s === "in-progress"));
  return (
    <details style={{ marginTop: 6 }}>
      <summary className="muted">Set status…</summary>
      <ActionForm action={itemAction} fields={{ project: keyName, uid: it.uid, item_uid: it.uid, action: "status" }} versions={it.versions}>
        <div className="row">
          <select name="to" aria-label="new status">{choices.map((s) => <option key={s}>{s}</option>)}</select>
          {it.pending_pre > 0 && <label><input type="checkbox" name="force" value="1" /> deploy past pending checks</label>}
          <button>Set</button>
        </div>
        {it.status === "in-qa" && <p className="muted">To send it back to work, use Reject — it needs a comment.</p>}
      </ActionForm>
    </details>
  );
}
