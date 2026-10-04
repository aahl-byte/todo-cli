import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { RoleFilter } from "@/components/RoleFilter";
import { cookies } from "next/headers";
import { filterCookie, legacyQuery, parseEntries, restoreFilter } from "@/lib/filters";
import { MoveButtons } from "@/components/QueueActions";
import { safeUrl } from "@/lib/url";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { project, qaQueue, users } from "@/lib/views";


export default async function QaQueue({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { key } = await params;
  const q = await searchParams;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const legacy = legacyQuery(q, user.handle);
  if (legacy !== null) redirect(`/p/${key}/qa${legacy ? `?${legacy}` : ""}`);
  const restored = restoreFilter(q, (await cookies()).get(filterCookie(key))?.value);
  if (restored) redirect(`/p/${key}/qa?${restored}`);
  const { ready, inQa, awaitingFix, counts } = await qaQueue(d, key, user.handle, {
    entries: parseEntries(q.f), view: q.view === "merged" ? "merged" : "tabs", tab: Math.trunc(Number(q.tab ?? 0)) || 0, type: q.type });
  const filters = <RoleFilter users={(await users(d)).map((u) => u.handle)} me={user.handle} counts={counts} />;
  const card = (c: any, to: { status: string; label: string; primary?: boolean }[]) => {
    const link = c.links.map((l: any) => ({ url: safeUrl(l.meta?.url), label: l.meta?.label || l.text })).find((l: any) => l.url);
    return (
      <article key={c.uid} className={`card qa-card s-${c.status}`} data-uid={c.uid}>
        <Link href={`/p/${key}/i/${c.id}`} className="title">{c.title}</Link>
        {c.extra?.app && <div className="where">{c.extra.app}{c.extra.section && ` · ${c.extra.section}`}</div>}
        <div className="meta">
          <span className="faint">{c.developer ?? "—"} · <Ago ts={c.entered} /></span>
          {c.bounces > 0 && <span className="tag hot" data-tip="sent back by QA before">returned ×{c.bounces}</span>}
          {c.request_meta && !c.request_meta.triaged && <span className="tag hot" data-tip="the request being tested never went through triage">v{c.request_meta.version} untriaged</span>}
          {link && <a className="tag link" href={link.url} target="_blank" rel="noreferrer" data-tip={link.url}>{link.label} ↗</a>}
        </div>
        <footer><MoveButtons item={JSON.parse(JSON.stringify(c))} project={key} deployStep={p.deploy_step} to={to} /></footer>
      </article>
    );
  };
  if (!ready.length && !inQa.length && !awaitingFix.length) return <>{filters}<p className="empty">Empty.</p></>;
  return (
    <div className="qa-page">
      {filters}
      {inQa.length > 0 && <div className="label">In QA<span>{inQa.length}</span></div>}
      <div className="cards">{inQa.map((c) => card(c, [
        { status: p.deploy_step ? "ready-to-deploy" : "done", label: "Approve", primary: true },
        { status: "qa-rejected", label: "Reject" },
      ]))}</div>
      {ready.length > 0 && <div className="label">Ready for QA<span>{ready.length}</span></div>}
      <div className="cards">{ready.map((c) => card(c, [{ status: "in-qa", label: "Pick up", primary: true }]))}</div>
      {awaitingFix.length > 0 && (
        <details className="awaiting">
          <summary className="label">Awaiting fix<span>{awaitingFix.length}</span></summary>
          <div className="cards">{awaitingFix.map((c) => card(c, []))}</div>
        </details>
      )}
    </div>
  );
}
