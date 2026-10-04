import Link from "next/link";
import { notFound } from "next/navigation";
import { deployAllAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { CheckBox, MoveButtons } from "@/components/QueueActions";
import { Led } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { deployPlan, project } from "@/lib/views";
import type { Row } from "@/lib/db";

export default async function Deploy({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p || !p.deploy_step) notFound();
  const plan = JSON.parse(JSON.stringify(await deployPlan(d, key)));
  if (!plan.ready.length && !plan.afterDeploy.length) return <p className="empty">Empty.</p>;

  const check = (c: Row) => (
    <div key={c.uid} className="rrow check-row" data-uid={c.uid}>
      <CheckBox check={c} project={key} />
      <span className="tag">{c.kind}</span>
      <span className="grow" data-tip={c.payload ?? undefined}>{c.title}{c.payload && <code className="payload">{c.payload}</code>}</span>
      {c.timing === "post-deploy" && <span className="tag">post</span>}
      {c.warning && <span className="hot">{c.warning}</span>}
    </div>
  );
  const ticket = (t: { item: Row; checks: Row[] }, actions: boolean) => (
    <section key={t.item.uid} className="ticket" data-uid={t.item.uid}>
      <header className="ticket-head">
        <Led status={t.item.status} />
        <Link href={`/p/${key}/i/${t.item.id}`} className="grow">{t.item.title}</Link>
        {t.item.developer && <span className="faint">{t.item.developer}</span>}
        {actions && <MoveButtons item={t.item} project={key} to={[{ status: "deployed", label: "Mark deployed", primary: true }]} />}
      </header>
      {t.checks.filter((c) => c.status !== "done").map(check)}
      {t.checks.some((c) => c.status === "done") && <div className="faint done-n">{t.checks.filter((c) => c.status === "done").length} done</div>}
    </section>
  );

  return (
    <div className="rows">
      <div className="filters">
        {plan.ready.length > 1 && (
          <ActionForm action={deployAllAction} fields={{ project: key, items: JSON.stringify(plan.ready.map((it: Row) => ({ uid: it.uid, versions: it.versions }))) }}>
            <button className="btn">Deploy all</button>
          </ActionForm>
        )}
      </div>
      {plan.byTicket.map((t: any) => ticket(t, true))}
      {plan.afterByTicket.length > 0 && (
        <>
          <div className="label" style={{ marginTop: 16 }}>Deployed · still to do</div>
          {plan.afterByTicket.map((t: any) => ticket(t, false))}
        </>
      )}
    </div>
  );
}
