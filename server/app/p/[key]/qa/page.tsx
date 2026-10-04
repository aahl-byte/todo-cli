import Link from "next/link";
import { notFound } from "next/navigation";
import { MoveButtons } from "@/components/QueueActions";
import { safeUrl } from "@/lib/url";
import { Ago, Led } from "@/components/ui";
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
  const row = (c: any, to: { status: string; label: string; primary?: boolean }[]) => {
    const link = c.links.map((l: any) => ({ url: safeUrl(l.meta?.url), label: l.meta?.label || l.text })).find((l: any) => l.url);
    return (
      <div key={c.uid} className="lrow" data-uid={c.uid}>
        <Led status={c.status} />
        <div className="grow">
          {link
            ? <a className="qa-link" href={link.url} target="_blank" rel="noreferrer">{link.label} ↗</a>
            : null}
          <div><Link href={`/p/${key}/i/${c.id}`} className={link ? "dim" : ""}>{c.title}</Link></div>
          <div className="faint">
            {c.developer} · <Ago ts={c.entered} />{c.bounces > 0 && <span className="hot"> · returned ×{c.bounces}</span>}
          </div>
        </div>
        <MoveButtons item={JSON.parse(JSON.stringify(c))} project={key} deployStep={p.deploy_step} to={to} />
      </div>
    );
  };
  if (!ready.length && !inQa.length) return <p className="empty">Empty.</p>;
  return (
    <div className="rows">
      {ready.length > 0 && <div className="label">Ready for QA</div>}
      {ready.map((c) => row(c, [{ status: "in-qa", label: "Pick up", primary: true }]))}
      {inQa.length > 0 && <div className="label" style={{ marginTop: 16 }}>In QA</div>}
      {inQa.map((c) => row(c, [
        { status: p.deploy_step ? "ready-to-deploy" : "done", label: "Approve", primary: true },
        { status: "in-progress", label: "Reject" },
      ]))}
    </div>
  );
}
