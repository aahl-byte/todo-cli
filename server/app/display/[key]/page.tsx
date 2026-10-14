import { notFound } from "next/navigation";
import { BoardCard, columnWho } from "@/components/BoardCard";
import { GateSignOut } from "@/components/GateSignOut";
import { db } from "@/lib/db";
import { currentDisplay } from "@/lib/display-session";
import { board, project } from "@/lib/views";

export const dynamic = "force-dynamic";

/** One project's board on a wall display. */
export default async function DisplayBoard({ params, searchParams }: {
  params: Promise<{ key: string }>; searchParams: Promise<{ setup?: string }>;
}) {
  const { key } = await params;
  const { setup } = await searchParams;
  if (!(await currentDisplay(key))) return null;
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const { columns } = await board(d, p, {}, "");
  return (
    <>
      {setup && <GateSignOut />}
      <div className="board">
        {columns.map((col) => (
          <section key={col.key} className={`column ${col.items.length ? "" : "empty-col"}`} aria-label={col.label}>
            <div className="label">{col.label}{col.items.length > 0 && <span>{col.items.length}</span>}</div>
            {col.items.map((c) => (
              <BoardCard key={c.uid} c={c} project={key} who={columnWho(col.key, c)} led={col.statuses.length > 1} base={`/display/${key}`} />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
