import Link from "next/link";
import { notFound } from "next/navigation";
import { checkAction, deployAllAction } from "@/app/actions";
import { ActionForm } from "@/components/ActionForm";
import { db } from "@/lib/db";
import { project, deployPlan } from "@/lib/views";
import { DeployButton } from "../i/[id]/page";
import type { Row } from "@/lib/db";

function CheckRow({ c, keyName }: { c: Row; keyName: string }) {
  return (
    <div className="check" data-uid={c.uid}>
      <ActionForm action={checkAction} fields={{ project: keyName, uid: c.uid, item_uid: c.item_uid, action: "toggle", status: c.status === "done" ? "pending" : "done" }} versions={c.versions}>
        <button className="link" aria-label={c.status === "done" ? "mark pending" : "mark done"}>{c.status === "done" ? "☑" : "☐"}</button>
      </ActionForm>
      <div>
        <Link href={`/p/${keyName}/i/${c.item_id}`} className="mono">{c.item_id}</Link> <span className="mono">[{c.n}]</span> {c.title}
        {c.payload && <> <code>{c.payload}</code></>}
        {c.warning && <span className="rejected-tag"> ⚠ {c.warning}</span>}
      </div>
    </div>
  );
}

export default async function Deploy({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const plan = await deployPlan(d, key);
  return (
    <>
      <h1>Deploy</h1>
      {plan.ready.length === 0 && plan.afterDeploy.length === 0 && <p className="muted">Nothing is ready to deploy.</p>}
      {(["pre", "post"] as const).map((t) => plan[t].length > 0 && (
        <section key={t} className="panel" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0 }}>{t === "pre" ? "Pre-deploy" : "Post-deploy"}</h2>
          {plan[t].map((g) => (
            <div key={g.kind}>
              <div className="muted">{g.kind}</div>
              {g.checks.map((c) => <CheckRow key={c.uid} c={c} keyName={key} />)}
            </div>
          ))}
        </section>
      ))}
      {plan.ready.length > 0 && (
        <section>
          <h2>Ready to deploy</h2>
          {plan.ready.map((it) => (
            <div key={it.uid} className="list-row" data-uid={it.uid}>
              <div className="grow"><Link href={`/p/${key}/i/${it.id}`}>{it.title}</Link> <span className="mono muted">{it.id}</span>
                {it.pending_pre > 0 && <span className="muted"> · {it.pending_pre} pending</span>}</div>
              <DeployButton it={it} keyName={key} />
            </div>
          ))}
          <ActionForm action={deployAllAction} fields={{ project: key, items: JSON.stringify(plan.ready.map((it) => ({ uid: it.uid, item_uid: it.uid, versions: it.versions }))) }}>
            <button className="primary" style={{ marginTop: 8 }}>Mark all deployed</button>
          </ActionForm>
        </section>
      )}
      {plan.afterDeploy.length > 0 && (
        <section className="panel" style={{ marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>Deployed — post-deploy pending</h2>
          {plan.afterDeploy.map((c) => <CheckRow key={c.uid} c={c} keyName={key} />)}
        </section>
      )}
    </>
  );
}
