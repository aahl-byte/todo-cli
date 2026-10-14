import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { BoardCard, columnWho } from "@/components/BoardCard";
import { GateSignOut } from "@/components/GateSignOut";
import { db } from "@/lib/db";
import { DISPLAY_COOKIE, displayAllowed } from "@/lib/display";
import { board, project } from "@/lib/views";

export const dynamic = "force-dynamic";

const REFRESH_MS = 60_000;

/** One project's board for a wall display: no controls, signed in with a display key. */
export default async function Display({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<{ setup?: string }>;
}) {
  const { key } = await params;
  const { setup } = await searchParams;
  const d = await db();
  if (!(await displayAllowed(d, key, (await cookies()).get(DISPLAY_COOKIE)?.value)))
    return <main className="display"><p className="updated">This display isn't signed in. Set it up again from <Link href="/displays">displays</Link>.</p></main>;
  const p = await project(d, key);
  if (!p) notFound();
  const { columns } = await board(d, p, {}, "");
  return (
    <main className="display">
      {setup && <GateSignOut />}
      <div className="display-head">
        <h1 className="brand">{p.name}</h1>
        <span className="tag display-badge">read-only display</span>
        <AutoRefresh everyMs={REFRESH_MS} at={Date.now()} />
      </div>
      <div className="board">
        {columns.map((col) => (
          <section key={col.key} className={`column ${col.items.length ? "" : "empty-col"}`} aria-label={col.label}>
            <div className="label">{col.label}{col.items.length > 0 && <span>{col.items.length}</span>}</div>
            {col.items.map((c) => (
              <BoardCard key={c.uid} c={c} project={key} who={columnWho(col.key, c)} led={col.statuses.length > 1} linked={false} />
            ))}
          </section>
        ))}
      </div>
    </main>
  );
}
