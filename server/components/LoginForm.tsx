"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, { ok: true });
  return (
    <form action={action} className="form panel" style={{ maxWidth: 340 }}>
      <input type="hidden" name="next" value={next} />
      <input name="handle" autoComplete="username" required aria-label="handle" placeholder="handle" />
      <input name="token" type="password" autoComplete="current-password" required aria-label="token" placeholder="token" />
      <button className="btn primary" disabled={pending}>Sign in</button>
      {!state.ok && <div className="toast" role="alert">{state.message}</div>}
    </form>
  );
}
