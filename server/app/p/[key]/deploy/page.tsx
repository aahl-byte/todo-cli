import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RoleFilter } from "@/components/RoleFilter";
import { cookies } from "next/headers";
import { filterCookie, legacyQuery, parseEntries, restoreFilter } from "@/lib/filters";
import { CheckBox, MoveButtons } from "@/components/QueueActions";
import { Led } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { deployPlan, project, users } from "@/lib/views";
import type { Row } from "@/lib/db";

export default async function Deploy({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { key } = await params;
  const q = await searchParams;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p || !p.deploy_step) notFound();
  const legacy = legacyQuery(q, user.handle);
  if (legacy !== null) redirect(`/p/${key}/deploy${legacy ? `?${legacy}` : ""}`);
  const restored = restoreFilter(q, (await cookies()).get(filterCookie(key))?.value);
  if (restored) redirect(`/p/${key}/deploy?${restored}`);
  const plan = JSON.parse(JSON.stringify(await deployPlan(d, key, user.handle, {
    entries: parseEntries(q.f), view: q.view === "merged" ? "merged" : "tabs", tab: Math.trunc(Number(q.tab ?? 0)) || 0, type: q.type })));
  const filters = <RoleFilter users={(await users(d)).map((u) => u.handle)} me={user.handle} counts={plan.counts} />;
  if (!plan.byTicket.length && !plan.afterByTicket.length) return <>{filters}<p className="empty">Empty.</p></>;

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
      {filters}
      {plan.byTicket.map((t: any) => ticket(t, true))}
      {plan.afterByTicket.length > 0 && (
        <>
          <div className="label section">Deployed · still to do</div>
          {plan.afterByTicket.map((t: any) => ticket(t, false))}
        </>
      )}
    </div>
  );
}
