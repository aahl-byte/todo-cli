"use client";
import { useActionState } from "react";
import { requestAction } from "@/app/actions";
import { Composer } from "./Composer";

export function RequestForm({ project, users, uploads }: { project: string; users: string[]; uploads: boolean }) {
  const [state, action, pending] = useActionState(requestAction, { ok: true });
  return (
    <form action={action} className="form-grid">
      <input type="hidden" name="project" value={project} />
      <label>Title<input name="title" required placeholder="What should change?" /></label>
      <div className="row">
        <label>Type <select name="type" defaultValue="feature"><option>feature</option><option>bug</option></select></label>
        <label>Priority <select name="priority" defaultValue="medium">{["low", "medium", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select></label>
      </div>
      <label>Description (Markdown — becomes the original request)
        <Composer name="description" users={users} rows={8} uploads={uploads} placeholder="Background, steps to reproduce, what done looks like…" />
      </label>
      <div className="row">
        <label>Developer <select name="developer" defaultValue=""><option value="">—</option>{users.map((u) => <option key={u}>{u}</option>)}</select></label>
        <label>QA <select name="qa" defaultValue=""><option value="">—</option>{users.map((u) => <option key={u}>{u}</option>)}</select></label>
      </div>
      <div><button className="primary" disabled={pending}>Submit request</button></div>
      {!state.ok && <div className="banner" role="alert">{state.message}</div>}
    </form>
  );
}
