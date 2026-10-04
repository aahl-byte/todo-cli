import Link from "next/link";
import { TopBar } from "@/components/TopBar";
import { MarkAllRead } from "@/components/QueueActions";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { inbox } from "@/lib/inbox";
import { requireUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

const WHAT: Record<string, string> = {
  mention: "mentioned you", "qa-rejection": "sent it back from QA", clarification: "asked a question",
  answer: "answered your question", "ready-for-qa": "handed you QA", deployed: "deployed your request",
};

export default async function Inbox({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const user = await requireUser();
  const d = await db();
  const all = (await searchParams).all === "1";
  const box = await inbox(d, user.handle, { all });
  return (
    <>
      <TopBar handle={user.handle} all={await projects(d)} />
      <main>
        <div className="filters">
          <Link href={all ? "/inbox" : "/inbox?all=1"} className={`btn ${all ? "on" : ""}`}>Include read</Link>
          {box.unread > 0 && <MarkAllRead />}
        </div>
        {box.notifications.length === 0 && <p className="empty">Nothing new.</p>}
        <div className="rows">
          {box.notifications.map((n: any) => (
            <a key={n.id} href={`/inbox/open/${n.id}`} className={`lrow ${n.read_at ? "read" : "unread"}`}>
              <span className="grow">
                <span className="dim">{n.actor ?? n.note_author ?? "someone"} {WHAT[n.kind] ?? n.kind}</span> {n.item_title}
                {n.note_text && <span className="faint"> — {String(n.note_text).split("\n")[0].slice(0, 140)}</span>}
              </span>
              <Ago ts={new Date(n.created).toISOString()} />
            </a>
          ))}
        </div>
      </main>
    </>
  );
}
