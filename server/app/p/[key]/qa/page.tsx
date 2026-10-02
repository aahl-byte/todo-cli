import Link from "next/link";
import { notFound } from "next/navigation";
import { itemAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { Initials, StatusPill, when } from "@/components/bits";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { project, qaQueue } from "@/lib/views";

export default async function QaQueue({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const { ready, inQa } = await qaQueue(d, key, user.handle);
  const row = (c: (typeof ready)[number], actions: React.ReactNode) => (
    <div key={c.uid} className="list-row" data-uid={c.uid}>
      <StatusPill status={c.status} />
      <div className="grow">
        <Link href={`/p/${key}/i/${c.id}`}><strong>{c.title}</strong></Link>{" "}
        <span className="mono muted">{c.id}</span>
        <div className="row muted">
          <Initials handle={c.developer} label="dev" />
          <Initials handle={c.qa_assignee} label="qa" />
          <span>since {when(c.entered)}</span>
          {c.bounces > 0 && <span className="rejected-tag">returned ×{c.bounces}</span>}
          {c.links.map((l: any) => <a key={l.uid} href={l.meta?.url} target="_blank" rel="noreferrer">{l.meta?.type}: {l.meta?.label || l.text}</a>)}
        </div>
      </div>
      {actions}
    </div>
  );
  const fields = (c: (typeof ready)[number]) => ({ project: key, uid: c.uid, item_uid: c.uid, qa_assignee: c.qa_assignee ?? "" });
  return (
    <>
      <h1>QA</h1>
      <h2>Ready for QA <span className="muted">{ready.length}</span></h2>
      {ready.length === 0 && <p className="muted">Nothing waiting.</p>}
      {ready.map((c) => row(c,
        <ActionForm action={itemAction} fields={{ ...fields(c), action: "pickup" }} versions={c.versions}>
          <button className="primary">Pick up</button>
        </ActionForm>))}
      <h2>In QA <span className="muted">{inQa.length}</span></h2>
      {inQa.length === 0 && <p className="muted">Nothing in QA.</p>}
      {inQa.map((c) => row(c,
        <div className="row">
          <ActionForm action={itemAction} fields={{ ...fields(c), action: "approve", deploy_step: p.deploy_step ? "1" : "0" }} versions={c.versions}>
            <button className="primary">Approve</button>
          </ActionForm>
          <details><summary><span className="rejected-tag">Reject…</span></summary>
            <ActionForm action={itemAction} fields={{ ...fields(c), action: "reject" }} versions={c.versions}>
              <textarea name="text" required rows={3} placeholder="What failed? (required)" />
              <button className="danger">Reject</button>
            </ActionForm>
          </details>
        </div>))}
    </>
  );
}
