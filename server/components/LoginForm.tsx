"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, { ok: true });
  return (
    <form action={action} className="form-grid panel" style={{ maxWidth: 380 }}>
      <input type="hidden" name="next" value={next} />
      <label>Handle<input name="handle" autoComplete="username" required /></label>
      <label>Token<input name="token" type="password" autoComplete="current-password" required /></label>
      <button className="primary" disabled={pending}>Sign in</button>
      {!state.ok && <div className="banner" role="alert">{state.message}</div>}
      <p className="muted">Use the same token as the CLI (<code>todo login</code>). An admin creates one with <code>npm run user:add</code>.</p>
    </form>
  );
}
