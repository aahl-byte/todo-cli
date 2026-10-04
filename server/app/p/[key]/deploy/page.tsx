import Link from "next/link";
import { notFound } from "next/navigation";
import { deployAllAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { CheckBox, MoveButtons } from "@/components/QueueActions";
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
  const check = (c: Row) => (
    <div key={c.uid} className="rrow" data-uid={c.uid}>
      <CheckBox check={c} project={key} />
      <span className="grow" data-tip={c.payload ?? undefined}>
        {c.title} <Link href={`/p/${key}/i/${c.item_id}`} className="faint">{c.item_title ?? c.item_id}</Link>
        {c.warning && <span className="hot"> · {c.warning}</span>}
      </span>
    </div>
  );
  const section = (label: string, groups: { kind: string; checks: Row[] }[]) => {
    const open = groups.map((g) => ({ ...g, checks: g.checks.filter((c) => c.status !== "done") })).filter((g) => g.checks.length);
    if (!open.length) return null;
    return (
      <section className="deploy-sec">
        <div className="label">{label}</div>
        {open.map((g) => (
          <div key={g.kind}>
            <div className="faint kind">{g.kind}</div>
            {g.checks.map(check)}
          </div>
        ))}
      </section>
    );
  };
  if (!plan.ready.length && !plan.afterDeploy.length) return <p className="empty">Nothing to deploy.</p>;
  return (
    <div className="rows">
      {section("Before deploy", plan.pre)}
      {section("After deploy", plan.post)}
      {plan.ready.length > 0 && (
        <section className="deploy-sec">
          <div className="label">Ready</div>
          {plan.ready.map((it: Row) => (
            <div key={it.uid} className="lrow" data-uid={it.uid}>
              <div className="grow"><Link href={`/p/${key}/i/${it.id}`}>{it.title}</Link></div>
              <MoveButtons item={it} project={key} to={[{ status: "deployed", label: "Deployed", primary: true }]} />
            </div>
          ))}
          {plan.ready.length > 1 && (
            <ActionForm action={deployAllAction} fields={{ project: key, items: JSON.stringify(plan.ready.map((it: Row) => ({ uid: it.uid, versions: it.versions }))) }}>
              <button className="btn">Deploy all</button>
            </ActionForm>
          )}
        </section>
      )}
      {plan.afterDeploy.length > 0 && (
        <section className="deploy-sec">
          <div className="label">Deployed · still to do</div>
          {plan.afterDeploy.map(check)}
        </section>
      )}
    </div>
  );
}
