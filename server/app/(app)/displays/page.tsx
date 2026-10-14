import { redirect } from "next/navigation";
import { removeDisplayAction, startDisplayAction } from "@/app/display-actions";
import { TopBar } from "@/components/TopBar";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { displays } from "@/lib/display";
import { currentUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

/** Turn this browser into a wall display, and see or remove the ones already set up. */
export default async function Displays() {
  const user = await currentUser();
  if (!user) redirect("/login?next=/displays");
  const d = await db();
  const all = await projects(d);
  const active = await displays(d);
  return (
    <>
      <TopBar handle={user.handle} all={all} />
      <main className="displays">
        <h1>Show a board on this device</h1>
        <p className="hint">The board stays up without signing in again, refreshing every minute. Nothing on it can be changed, and this device is signed out of todo and the sign-in gate.</p>
        <div className="display-picks">
          {all.map((p) => (
            <form key={p.key} action={startDisplayAction}>
              <input type="hidden" name="project" value={p.key} />
              <button className="add">{p.name || p.key}</button>
            </form>
          ))}
        </div>
        {active.length > 0 && <>
          <h1>Displays set up</h1>
          {active.map((x) => (
            <form key={`${x.project} ${x.label}`} action={removeDisplayAction} className="display-row">
              <input type="hidden" name="project" value={x.project} />
              <input type="hidden" name="label" value={x.label} />
              <span>{x.project}</span><span className="hint">{x.label}</span>
              <span className="hint">{x.last_seen ? <>seen <Ago ts={new Date(x.last_seen).toISOString()} /></> : "never opened"}</span>
              <button className="add">remove</button>
            </form>
          ))}
        </>}
      </main>
    </>
  );
}
