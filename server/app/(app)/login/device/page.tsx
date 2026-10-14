import { redirect } from "next/navigation";
import { approveLoginAction, denyLoginAction } from "@/app/device-actions";
import { Ago } from "@/components/ui";
import { db } from "@/lib/db";
import { cleanCode, pendingLogin } from "@/lib/devices";
import { currentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Where a signed-in user confirms the code a CLI is showing. */
export default async function DeviceLogin({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = cleanCode((await searchParams).code ?? "");
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/login/device?code=${code}`)}`);
  const pending = code ? await pendingLogin(await db(), code) : null;
  return (
    <main className="displays">
      <h1>Sign in a command line</h1>
      {!pending || pending.handle ? (
        <p className="hint">This sign-in request has expired or was already used. Run <code>todo login</code> again.</p>
      ) : (
        <>
          <p className="hint">Only approve this if the code below is the one your terminal shows.</p>
          <h1 style={{ letterSpacing: "0.15em" }}>{pending.user_code}</h1>
          <p className="hint">{pending.label}, asked <Ago ts={new Date(pending.created).toISOString()} />. It will sign in as <b>{user.handle}</b>.</p>
          <div className="display-picks">
            <form action={approveLoginAction}><input type="hidden" name="code" value={pending.user_code} /><button className="add">Approve</button></form>
            <form action={denyLoginAction}><input type="hidden" name="code" value={pending.user_code} /><button className="add">Deny</button></form>
          </div>
        </>
      )}
    </main>
  );
}
