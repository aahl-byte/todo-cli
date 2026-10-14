import { redirect } from "next/navigation";
import { revokeTokenAction } from "@/app/device-actions";
import { TopBar } from "@/components/TopBar";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/devices";
import { currentUser } from "@/lib/session";
import { projects } from "@/lib/views";

export const dynamic = "force-dynamic";

/** The command lines signed in as this user, each revocable. */
export default async function Devices({ searchParams }: { searchParams: Promise<{ approved?: string; expired?: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login?next=/devices");
  const d = await db();
  const [all, tokens, flags] = [await projects(d), await apiTokens(d, user.handle), await searchParams];
  return (
    <>
      <TopBar handle={user.handle} all={all} />
      <main className="displays">
        {flags.approved && <div className="toast" role="status">Approved. Your terminal signs in within a few seconds.</div>}
        {flags.expired && <div className="toast" role="alert">That request expired. Run <code>todo login</code> again.</div>}
        <h1>Command lines signed in</h1>
        <p className="hint">Run <code>todo login &lt;url&gt;</code> in a terminal to add one. Revoking signs that device out.</p>
        {tokens.length === 0 && <p className="hint">None yet.</p>}
        {tokens.map((t) => (
          <form key={t.id} action={revokeTokenAction} className="display-row">
            <input type="hidden" name="id" value={t.id} />
            <span>{t.label}</span>
            <span className="hint">added <Ago ts={new Date(t.created).toISOString()} /></span>
            <span className="hint">{t.last_used ? <>used <Ago ts={new Date(t.last_used).toISOString()} /></> : "never used"}</span>
            <button className="add">revoke</button>
          </form>
        ))}
      </main>
    </>
  );
}
