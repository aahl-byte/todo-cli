import Link from "next/link";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireUser();
  const all = await projects(await db());
  if (all.length === 1) redirect(`/p/${all[0].key}`);
  return (
    <>
      <TopBar handle={user.handle} all={all} />
      <main>
        <h1>Projects</h1>
        {all.length === 0 && <p className="muted">No projects yet. Run <code>todo link --remote</code> in a repo, or <code>npm run project:add</code>.</p>}
        {all.map((p) => <div key={p.key} className="list-row"><Link href={`/p/${p.key}`}>{p.name || p.key}</Link></div>)}
      </main>
    </>
  );
}
