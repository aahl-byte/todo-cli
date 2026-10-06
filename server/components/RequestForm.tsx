"use client";
import { useActionState } from "react";
import { requestAction } from "@/app/actions";
import { AppFields, type Apps } from "./AppFields";
import { Composer } from "./Composer";
import { ITEM_TYPES } from "@/lib/model";

export function RequestForm({ project, users, uploads, apps }: {
  project: string; users: string[]; uploads: { project: string; scope: string } | null; apps: Apps;
}) {
  const [state, action, pending] = useActionState(requestAction, { ok: true });
  return (
    <form action={action} className="form">
      <input type="hidden" name="project" value={project} />
      <div className="row title-row">
        <input name="title" required aria-label="title" placeholder="What should change?" className="big" autoFocus />
        <select name="type" defaultValue="feature" aria-label="type">{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
        <select name="priority" defaultValue="medium" aria-label="priority">{["low", "medium", "high", "urgent"].map((p) => <option key={p}>{p}</option>)}</select>
      </div>
      <div className="row">
        <AppFields apps={apps} />
        <input name="url" type="url" aria-label="URL" placeholder="where it happens (URL)" className="grow" />
      </div>
      <Composer name="description" users={users} rows={8} uploads={uploads} placeholder="Background, steps to reproduce, what done looks like — paste screenshots" />
      <details>
        <summary className="add">assign</summary>
        <div className="row" style={{ marginTop: 6 }}>
          <select name="developer" defaultValue="" aria-label="developer"><option value="">developer —</option>{users.map((u) => <option key={u}>{u}</option>)}</select>
          <select name="qa" defaultValue="" aria-label="QA"><option value="">QA —</option>{users.map((u) => <option key={u}>{u}</option>)}</select>
        </div>
      </details>
      <div><button className="btn primary" disabled={pending}>Submit</button></div>
      {!state.ok && <div className="toast" role="alert">{state.message}</div>}
    </form>
  );
}
