"use client";
// The right rail: people, details, links, checks, history. Labels are small;
// values are click-to-pick; adds open a popup.
import { useRef, useState } from "react";
import * as act from "@/app/item-actions";
import { CHECK_KINDS, LINK_TYPES } from "@/lib/model";
import type { ItemView as Data } from "@/lib/views";
import { safeUrl } from "@/lib/url";
import { Ago, Led, Menu, Popup } from "../ui";
import { report, Remove, type Ctx } from "./ItemView";
import { CheckBox } from "../QueueActions";

type Row = Record<string, any>;
const PRIORITIES = ["low", "medium", "high", "urgent"];
const TYPES = ["feature", "bug", "refactor", "question"];
const LINK_TAG: Record<string, string> = { pr: "PR", preview: "preview", "qa-handoff": "QA" };


export function Rail({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const pinned = useRef(it.versions);
  const edit = (field: string, value: unknown) =>
    void act.editItem({ project: ctx.project, uid: it.uid, versions: pinned.current, data: { [field]: value } }).then(report);
  const person = (field: "developer" | "qa_assignee") => {
    const value: string | null = it[field];
    const names = value && !ctx.users.includes(value) ? [...ctx.users, value] : ctx.users;
    return (
      <Menu label={field === "developer" ? "developer" : "QA"} current={value ?? ""} onOpen={() => { pinned.current = it.versions; }}
            trigger={<span className={value ? "" : "faint"}>{value ?? "—"}</span>}
            options={[{ value: "", label: "—" }, ...names.map((h) => ({ value: h }))]}
            onPick={(v) => { if ((v || null) !== value) edit(field, v || null); }} />
    );
  };
  return (
    <>
      <section>
        <div className="label">People</div>
        <div className="kv">
          <span className="k">dev</span>{person("developer")}
          <span className="k">qa</span>{person("qa_assignee")}
          {it.creator && <><span className="k">by</span><span className="faint">{it.creator}</span></>}
        </div>
      </section>
      <section>
        <div className="label">Details</div>
        <div className="kv">
          <span className="k">type</span>
          <Menu label="type" current={it.type} onOpen={() => { pinned.current = it.versions; }} trigger={it.type}
                options={TYPES.map((v) => ({ value: v }))} onPick={(v) => { if (v !== it.type) edit("type", v); }} />
          <span className="k">priority</span>
          <Menu label="priority" current={it.priority} onOpen={() => { pinned.current = it.versions; }}
                trigger={<span className={it.priority === "high" || it.priority === "urgent" ? "hot" : ""}>{it.priority ?? "—"}</span>}
                options={PRIORITIES.map((v) => ({ value: v }))} onPick={(v) => { if (v !== it.priority) edit("priority", v); }} />
          {it.super_phase != null && <><span className="k">phase</span><span>P{it.super_phase}</span></>}
          <span className="k">id</span>
          <button type="button" className="edit-text mono-id" data-tip="copy"
                  onClick={() => void navigator.clipboard?.writeText(it.id)}>{it.id}</button>
          {it.jira_key && (
            <>
              <span className="k">jira</span>
              {ctx.jiraBase
                ? <a href={`${ctx.jiraBase}/browse/${it.jira_key}`} target="_blank" rel="noreferrer">{it.jira_key}</a>
                : <span>{it.jira_key}</span>}
            </>
          )}
        </div>
      </section>
      <Links rows={data.links} ctx={ctx} />
      {ctx.deployStep && <Checks rows={data.checks} ctx={ctx} />}
      <History rows={data.history} current={it.status} created={it.created} />
    </>
  );
}

function Links({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ url: "", label: "", type: "pr" });
  const save = async () => {
    if (report(await act.addLink({ project: ctx.project, itemUid: ctx.itemUid, ...form }))) {
      setAdding(false);
      setForm({ url: "", label: "", type: "pr" });
    }
  };
  return (
    <section>
      <div className="label">Links<button type="button" className="plus" aria-label="add link" onClick={() => setAdding(true)}>+</button></div>
      {rows.map((l) => {
        const url = safeUrl(l.meta?.url);
        const tag = LINK_TAG[l.meta?.type];
        return (
          <div key={l.uid} className="rrow" data-uid={l.uid}>
            {tag && <span className="tag">{tag}</span>}
            {url ? <a className="grow" href={url} target="_blank" rel="noreferrer" data-tip={url}>{l.meta?.label || l.text}</a>
                 : <span className="grow">{l.meta?.label || l.text}</span>}
            <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: "note", uid: l.uid, versions: l.versions })} />
          </div>
        );
      })}
      {adding && (
        <Popup title="Add link" onClose={() => setAdding(false)}>
          <input value={form.url} placeholder="https://…" aria-label="URL" onChange={(e) => setForm({ ...form, url: e.target.value })}
                 onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          <div className="row">
            <input value={form.label} placeholder="label" aria-label="label" onChange={(e) => setForm({ ...form, label: e.target.value })}
                   onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
            <select value={form.type} aria-label="type" onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {LINK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!/^https?:\/\//.test(form.url.trim())} onClick={() => void save()}>Add</button>
          </div>
        </Popup>
      )}
    </section>
  );
}

function Checks({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [form, setForm] = useState({ kind: "db-script", title: "", payload: "", timing: "pre-deploy" });
  const open = rows.filter((c) => c.status !== "done");
  const done = rows.filter((c) => c.status === "done");
  const save = async () => {
    if (report(await act.addCheck({ project: ctx.project, itemUid: ctx.itemUid, ...form }))) {
      setAdding(false);
      setForm({ kind: "db-script", title: "", payload: "", timing: "pre-deploy" });
    }
  };
  const row = (c: Row) => (
    <div key={c.uid} className="rrow" data-uid={c.uid}>
      <CheckBox check={{ ...c, item_uid: ctx.itemUid }} project={ctx.project} />
      <span className="grow" data-tip={[c.kind, c.payload].filter(Boolean).join(" · ")}>{c.title}</span>
      {c.timing === "post-deploy" && <span className="tag">post</span>}
      <Remove onConfirm={() => act.removeChild({ project: ctx.project, itemUid: ctx.itemUid, entity: "check", uid: c.uid, versions: c.versions })} />
    </div>
  );
  return (
    <section>
      <div className="label">Checks<button type="button" className="plus" aria-label="add check" onClick={() => setAdding(true)}>+</button></div>
      {open.map(row)}
      {done.length > 0 && (
        <button type="button" className="tgroup" onClick={() => setShowDone((s) => !s)}>
          <span className={`chev ${showDone ? "open" : ""}`}>›</span> {done.length} done
        </button>
      )}
      {showDone && done.map(row)}
      {adding && (
        <Popup title="Add deployment check" onClose={() => setAdding(false)}>
          <input value={form.title} placeholder="What has to happen" aria-label="title" onChange={(e) => setForm({ ...form, title: e.target.value })}
                 onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          <div className="row">
            <select value={form.kind} aria-label="kind" onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {CHECK_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <select value={form.timing} aria-label="timing" onChange={(e) => setForm({ ...form, timing: e.target.value })}>
              <option value="pre-deploy">before deploy</option>
              <option value="post-deploy">after deploy</option>
            </select>
          </div>
          <input value={form.payload} placeholder="script, variable, branch or item id" aria-label="payload"
                 onChange={(e) => setForm({ ...form, payload: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!form.title.trim()} onClick={() => void save()}>Add</button>
          </div>
        </Popup>
      )}
    </section>
  );
}

const HISTORY_SHOWN = 5;

function History({ rows, current, created }: { rows: Row[]; current: string; created: string }) {
  const [all, setAll] = useState(false);
  const newest = [...rows].reverse();
  const shown = all ? newest : newest.slice(0, HISTORY_SHOWN);
  return (
    <section className="hist">
      <div className="label">History</div>
      {shown.map((h, i) => (
        <div key={h.uid} tabIndex={0} className={`rrow ${i === 0 && h.to_status === current ? "dimmed" : ""}`}
             data-tip={[h.by, h.via === "agent" ? "AI" : null, h.forced ? "forced" : null].filter(Boolean).join(" · ")}>
          <Led status={h.to_status} label />
          <Ago ts={h.ts} />
        </div>
      ))}
      {newest.length > HISTORY_SHOWN && (
        <button type="button" className="tgroup" onClick={() => setAll((a) => !a)}>
          <span className={`chev ${all ? "open" : ""}`}>›</span> {all ? "fewer" : `${newest.length - HISTORY_SHOWN} earlier`}
        </button>
      )}
      {(all || newest.length <= HISTORY_SHOWN) && (
        <div className="rrow created"><span className="stat"><span className="led" />created</span><Ago ts={created} /></div>
      )}
    </section>
  );
}
