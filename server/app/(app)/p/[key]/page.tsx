import { BoardCard, columnWho } from "@/components/BoardCard";
import { notFound } from "next/navigation";
import { redirect } from "next/navigation";
import { RoleFilter } from "@/components/RoleFilter";
import { SessionWatch } from "@/components/SessionWatch";
import { cookies } from "next/headers";
import { filterCookie, legacyQuery, parseEntries, restoreFilter } from "@/lib/filters";
import { clearShippedAction } from "@/app/actions";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { board, choices, project, tagChoices, users, type BoardFilters as F } from "@/lib/views";

type Search = Record<string, string | undefined>;

export default async function Board({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<Search> }) {
  const { key } = await params;
  const q = await searchParams;
  const user = await requireUser();
  const d = await db();
  const p = await project(d, key);
  if (!p) notFound();
  const legacy = legacyQuery(q, user.handle);
  if (legacy !== null) redirect(`/p/${key}${legacy ? `?${legacy}` : ""}`);
  const restored = restoreFilter(q, (await cookies()).get(filterCookie(key))?.value);
  if (restored) redirect(`/p/${key}?${restored}`);
  const f: F = { review: q.review === "1", entries: parseEntries(q.f), view: q.view === "merged" ? "merged" : "tabs",
                 tab: Math.trunc(Number(q.tab ?? 0)) || 0, type: q.type, app: q.app, tag: q.tag, parked: q.parked === "1", search: q.search };
  const { columns, counts } = await board(d, p, f, user.handle);
  return (
    <>
      <RoleFilter users={(await users(d)).map((u) => u.handle)} apps={Object.keys(await choices(d, key))} tags={await tagChoices(d, key)} me={user.handle} counts={counts} review />
      <SessionWatch project={key} />
      <div className="board">
        {columns.map((col) => (
          <section key={col.key} className={`column ${col.items.length ? "" : "empty-col"}`} aria-label={col.label}>
            <div className="label">{col.label}{col.items.length > 0 && <span>{col.items.length}</span>}
              {col.key === "shipped" && col.items.length > 0 && (
                <form action={clearShippedAction} className="clear-col">
                  <input type="hidden" name="project" value={key} />
                  <button type="submit" className="plus" data-tip="archive every shipped and cancelled item">clear</button>
                </form>)}
            </div>
            {col.items.map((c) => (
              <BoardCard key={c.uid} c={c} project={key} who={columnWho(col.key, c)} led={col.statuses.length > 1} />
            ))}
          </section>
        ))}
      </div>
    </>
  );
}
