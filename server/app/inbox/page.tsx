import { readAction } from "@/app/actions";
import { TopBar } from "@/components/TopBar";
import { when } from "@/components/bits";
import { db } from "@/lib/db";
import { inbox } from "@/lib/inbox";
import { requireUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

const WHAT: Record<string, string> = {
  mention: "mentioned you", "qa-rejection": "QA rejected your work", clarification: "asked a question",
  answer: "answered your question", "ready-for-qa": "handed you QA", deployed: "your request was deployed",
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
        <h1>Inbox <span className="muted">{box.unread} unread</span></h1>
        <p><a href={all ? "/inbox" : "/inbox?all=1"}>{all ? "unread only" : "include read"}</a></p>
        {box.notifications.length === 0 && <p className="muted">Nothing here.</p>}
        {box.notifications.map((n: any) => {
          const to = `/p/${n.project}/i/${n.item_id}${n.note_n ? `#n-${n.note_n}` : ""}`;
          return (
            <form key={n.id} action={readAction} className="list-row">
              <input type="hidden" name="id" value={n.id} />
              <input type="hidden" name="to" value={to} />
              <span>{n.read_at ? " " : "•"}</span>
              <div className="grow">
                <strong>{n.note_author ?? "someone"}</strong> {WHAT[n.kind] ?? n.kind} — {n.item_title}{" "}
                <span className="mono muted">{n.project}/{n.item_id}</span>
                {n.note_text && <div className="muted">{String(n.note_text).slice(0, 200)}</div>}
              </div>
              <span className="muted">{when(new Date(n.created).toISOString())}</span>
              <button>Open</button>
            </form>
          );
        })}
      </main>
    </>
  );
}
