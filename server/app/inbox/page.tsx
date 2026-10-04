import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { ClearItem, MarkAllRead } from "@/components/InboxActions";
import { Markdown } from "@/components/Markdown";
import { Ago, Led } from "@/components/ui";
import { db } from "@/lib/db";
import { groupInbox, inbox, type InboxGroup } from "@/lib/inbox";
import { requireUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

const KIND: Record<string, { icon: string; verb: string; tone: string }> = {
  mention: { icon: "@", verb: "mentioned you", tone: "cyan" },
  "qa-rejection": { icon: "✕", verb: "sent it back from QA", tone: "hot" },
  clarification: { icon: "?", verb: "asked a question", tone: "amber" },
  answer: { icon: "↩", verb: "answered your question", tone: "cyan" },
  "ready-for-qa": { icon: "→", verb: "handed you QA", tone: "amber" },
  "request-changed": { icon: "✎", verb: "changed the request", tone: "amber" },
  deployed: { icon: "▲", verb: "deployed your request", tone: "ok" },
};
const SHOWN = 3;

function Group({ g, multi }: { g: InboxGroup; multi: boolean }) {
  const unread = g.notices.filter((n) => !n.read_at).length;
  const row = (n: Record<string, any>) => {
    const k = KIND[n.kind] ?? { icon: "•", verb: n.kind, tone: "" };
    return (
      <a key={n.id} href={`/inbox/open/${n.id}`} className={`notice ${n.read_at ? "read" : "unread"} ${n.settled ? "settled" : ""}`}>
        <span className={`kind ${k.tone}`} aria-hidden="true">{k.icon}</span>
        <span className="what">
          <span className="who">{n.actor ?? n.note_author ?? "someone"}</span> {k.verb}
          {n.settled && <span className="tag">settled</span>}
          {n.note_text && <span className="excerpt"><Markdown text={String(n.note_text).split("\n")[0]} oneLine /></span>}
        </span>
        <Ago ts={new Date(n.created).toISOString()} />
      </a>
    );
  };
  return (
    <section className={`ibox s-${g.status}`} data-uid={g.item_uid}>
      <header>
        <Led status={g.status} />
        <Link href={`/p/${g.project}/i/${g.item_id}`} className="grow title">{g.title}</Link>
        {multi && <span className="faint">{g.project}</span>}
        {unread > 0 && <ClearItem project={g.project} itemUid={g.item_uid} title={g.title} />}
      </header>
      {g.notices.slice(0, SHOWN).map(row)}
      {g.notices.length > SHOWN && (
        <details className="more-n">
          <summary>+{g.notices.length - SHOWN} more</summary>
          {g.notices.slice(SHOWN).map(row)}
        </details>
      )}
    </section>
  );
}

export default async function Inbox({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const d = await db();
  const all = (await searchParams).all === "1";
  const box = await inbox(d, user.handle, { all });
  const { needs, fyi } = groupInbox(box.notifications);
  const multi = new Set(box.notifications.map((n: any) => n.project)).size > 1;
  return (
    <>
      <TopBar handle={user.handle} all={await projects(d)} />
      <main className="inbox">
        <div className="filters">
          <Link href="/inbox" className={`btn ${all ? "" : "on"}`}>Unread<span className="n">{box.unread}</span></Link>
          <Link href="/inbox?all=1" className={`btn ${all ? "on" : ""}`}>All<span className="n">{box.total}</span></Link>
          <span className="grow" />
          {box.unread > 0 && <MarkAllRead count={box.unread} />}
        </div>
        {!needs.length && !fyi.length && (
          <div className="empty-inbox">
            <p>Nothing needs you.</p>
            <Link href="/">Back to the board</Link>
          </div>
        )}
        {needs.length > 0 && (
          <>
            <div className="label">Needs you<span>{needs.length}</span></div>
            <div className="iboxes">{needs.map((g) => <Group key={g.key} g={g} multi={multi} />)}</div>
          </>
        )}
        {fyi.length > 0 && (
          <>
            <div className="label">For your information<span>{fyi.length}</span></div>
            <div className="iboxes fyi">{fyi.map((g) => <Group key={g.key} g={g} multi={multi} />)}</div>
          </>
        )}
      </main>
    </>
  );
}
