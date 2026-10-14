"use client";
// The right rail: people, details, links, checks, history. Labels are small;
// values are click-to-pick; adds open a popup.
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as act from "@/app/item-actions";
import { CHECK_KINDS, ITEM_TYPES, LINK_TYPES } from "@/lib/model";
import type { ItemView as Data } from "@/lib/views";
import type { ChecksState, PrStatus } from "@/lib/github";
import { safeUrl } from "@/lib/url";
import { Ago, Led, Menu, Popup, richTip } from "../ui";
import { report, Remove, type Ctx } from "./ItemView";
import { CheckBox } from "../QueueActions";
import { useReadOnly } from "../ReadOnly";
import { Glance } from "./Glance";
import { AppFields } from "../AppFields";
import { CopyButton } from "../Copy";
import { withBase } from "@/lib/base";
import type { SessionState, SessionStatus } from "@/lib/actions/sessions";

type Row = Record<string, any>;
const PRIORITIES = ["low", "medium", "high", "urgent"];
const LINK_TAG: Record<string, string> = { pr: "PR", "qa-handoff": "QA", "wt-file": "WT" };
const TIMING: Record<string, string> = { "pre-deploy": "before deploy", "post-deploy": "after deploy" };
const CHECKS_TIP: Record<ChecksState, string> = { pass: "passing", fail: "failing", pending: "running" };


export function Rail({ data, ctx, onTasks }: { data: Data; ctx: Ctx; onTasks?: () => void }) {
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
      <Glance tasks={data.tasks} titles={data.phaseTitles} onOpen={() => onTasks?.()} />
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
          <span className="k">app</span>
          <AppValue data={data} ctx={ctx} />
          <span className="k">branch</span>
          <BranchValue data={data} ctx={ctx} />
          <span className="k">type</span>
          <Menu label="type" current={it.type} onOpen={() => { pinned.current = it.versions; }} trigger={it.type}
                options={ITEM_TYPES.map((v) => ({ value: v }))} onPick={(v) => { if (v !== it.type) edit("type", v); }} />
          <span className="k">priority</span>
          <Menu label="priority" current={it.priority} onOpen={() => { pinned.current = it.versions; }}
                trigger={<span className={it.priority === "high" || it.priority === "urgent" ? "hot" : ""}>{it.priority ?? "—"}</span>}
                options={PRIORITIES.map((v) => ({ value: v }))} onPick={(v) => { if (v !== it.priority) edit("priority", v); }} />
          {it.super_phase != null && <><span className="k">phase</span><span>P{it.super_phase}</span></>}
          <span className="k">id</span>
          <CopyButton text={it.id} className="edit-text mono-id">{it.id}</CopyButton>
          {it.jira.length > 0 && (
            <>
              <span className="k">jira</span>
              <span className="jira-keys">
                {it.jira.map((j: { key: string; status: string | null }) => (
                  <span key={j.key}>
                    {ctx.jiraBase
                      ? <a href={`${ctx.jiraBase}/browse/${j.key}`} target="_blank" rel="noreferrer">{j.key} ↗</a>
                      : j.key}
                    {j.status && <span className="faint"> {j.status}</span>}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>
      </section>
      <Related rows={data.related} ctx={ctx} />
      <Links rows={data.links} prs={data.prs ?? {}} ctx={ctx} />
      {data.files?.length > 0 && <Files rows={data.files} jiraBase={ctx.jiraBase} />}
      {ctx.deployStep && <Checks rows={data.checks} ctx={ctx} />}
      {ctx.actions.length > 0 && <Actions ctx={ctx} itemId={it.id} />}
      <History rows={data.history} current={it.status} created={it.created} />
    </>
  );
}

const RUN_POLL_MS = 3_000;

const SESSION_POLL_MS = 5_000;
const SESSION_LABEL: Record<SessionStatus, string> = {
  busy: "working", idle: "idle", waiting: "waiting", stopped: "stopped", shell: "shell", unknown: "unreachable",
};

/** The Watchtower sessions this item's Actions started, kept fresh while the page is visible. */
function useSessions(ctx: Ctx, kick: number): SessionState[] {
  const [sessions, setSessions] = useState<SessionState[]>([]);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(withBase(`/api/projects/${encodeURIComponent(ctx.project)}/sessions?item=${encodeURIComponent(ctx.itemUid)}`), { cache: "no-store" });
        if (res.ok && live) setSessions((await res.json()).sessions ?? []);
      } catch { /* the next tick retries */ }
    };
    void tick();
    const id = setInterval(() => void tick(), SESSION_POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [ctx.project, ctx.itemUid, kick]);
  return sessions;
}

function SessionLine({ s }: { s: SessionState }) {
  const label = s.status === "waiting" && s.waitingFor ? `waiting on ${s.waitingFor}` : SESSION_LABEL[s.status];
  return (
    <span className={`wt-state wt-${s.status}`} data-tip={`Watchtower session ${s.session.slice(0, 8)}`}>
      <span className="led" />{label}
      <a href={s.url} target="_blank" rel="noreferrer">open ↗</a>
    </span>
  );
}

function Actions({ ctx, itemId }: { ctx: Ctx; itemId: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [kick, setKick] = useState(0);
  const sessions = useSessions(ctx, kick);
  // Spins until the run is sent or has given up; only giving up is worth a toast.
  const run = async (id: string) => {
    setBusy(id);
    let r = await act.runAction({ project: ctx.project, itemUid: ctx.itemUid, action: id });
    while (r.ok && !r.done && r.run) {
      await new Promise((ok) => setTimeout(ok, RUN_POLL_MS));
      r = await act.actionRun({ project: ctx.project, run: r.run });
    }
    setBusy(null);
    setKick((k) => k + 1);
    report(r);
  };
  return (
    <section>
      <div className="label">Actions</div>
      <div className="action-buttons">
        {ctx.actions.map((a) => {
          const s = sessions.find((x) => x.actionId === a.id);
          return (
            <div key={a.id} className="action-row">
              {a.runner === "server"
                ? <button type="button" className="btn" disabled={busy !== null} onClick={() => void run(a.id)}>{busy === a.id && <span className="spin" aria-label="running" />}{a.name}</button>
                : <CopyButton className="btn" text={`todo action ${itemId} ${a.id}`}
                              tip={`runs from the CLI: todo action ${itemId} ${a.id} (click to copy)`}>{a.name} ⧉</CopyButton>}
              {s && <SessionLine s={s} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** A value that opens its editor on click, or plain text where nothing can change. */
function Editable({ readOnly, onOpen, children }: { readOnly: boolean; onOpen: () => void; children: ReactNode }) {
  return readOnly
    ? <span className="edit-text">{children}</span>
    : <button type="button" className="edit-text" onClick={onOpen}>{children}</button>;
}

function AppValue({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const [open, setOpen] = useState(false);
  const pinned = useRef(it.versions);
  const app = it.extra?.app ?? "", section = it.extra?.section ?? "";
  const save = async (fd: FormData) => {
    const v = (k: string) => String(fd.get(k) ?? "").trim() || null;
    const r = await act.editItem({ project: ctx.project, uid: it.uid, versions: pinned.current,
                                   data: { "extra.app": v("app"), "extra.section": v("section") } });
    if (report(r)) setOpen(false);
  };
  return (
    <>
      <Editable readOnly={!!ctx.readOnly} onOpen={() => { pinned.current = it.versions; setOpen(true); }}>
        {app ? <>{app}{section && <span className="faint"> · {section}</span>}</> : <span className="faint">—</span>}
      </Editable>
      {open && (
        <Popup title="App and section" onClose={() => setOpen(false)}>
          <form className="row" action={(fd) => void save(fd)}>
            <AppFields apps={data.choices} app={app} section={section} />
            <div className="actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Popup>
      )}
    </>
  );
}

function BranchValue({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const [open, setOpen] = useState(false);
  const pinned = useRef(it.versions);
  const repo = it.extra?.repo ?? "", branch = it.extra?.branch ?? "";
  const save = async (fd: FormData) => {
    const v = (k: string) => String(fd.get(k) ?? "").trim() || null;
    const r = await act.editItem({ project: ctx.project, uid: it.uid, versions: pinned.current,
                                   data: { "extra.repo": v("repo"), "extra.branch": v("branch") } });
    if (report(r)) setOpen(false);
  };
  return (
    <>
      <Editable readOnly={!!ctx.readOnly} onOpen={() => { pinned.current = it.versions; setOpen(true); }}>
        {repo || branch ? <>{repo && <span className="faint">{repo} · </span>}{branch || "—"}</> : <span className="faint">—</span>}
      </Editable>
      {open && (
        <Popup title="Repo and branch" onClose={() => setOpen(false)}>
          <form className="row" action={(fd) => void save(fd)}>
            <input name="repo" defaultValue={repo} aria-label="repo" placeholder="repo" autoComplete="off" />
            <input name="branch" defaultValue={branch} aria-label="branch" placeholder="branch" autoComplete="off" />
            <div className="actions">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button className="btn primary">Save</button>
            </div>
          </form>
        </Popup>
      )}
    </>
  );
}

const size = (n: number | null) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** Every file attached in Jira: our copies of images, Jira links for the rest. */
function Files({ rows, jiraBase }: { rows: Row[]; jiraBase: string | null }) {
  const readOnly = useReadOnly();
  const url = (key: string) => withBase(`${readOnly ? `${readOnly.base}/files` : "/api/files"}/${key}`);
  return (
    <section className="files">
      <div className="label">Files<span>{rows.length}</span></div>
      <div className="thumbs">
        {rows.filter((f) => f.file_key).map((f) => (
          <a key={f.attachment_id} href={url(f.file_key)} target="_blank" rel="noreferrer" data-tip={f.filename}>
            <img src={url(f.file_key)} alt={f.filename} loading="lazy" />
          </a>
        ))}
      </div>
      {rows.filter((f) => !f.file_key).map((f) => (
        <div key={f.attachment_id} className="rrow file-row">
          <span className="tag">{String(f.filename).split(".").pop()?.slice(0, 5) || "file"}</span>
          {jiraBase
            ? <a className="grow" href={`${jiraBase}/secure/attachment/${f.attachment_id}/${encodeURIComponent(f.filename)}`} target="_blank" rel="noreferrer">{f.filename} ↗</a>
            : <span className="grow">{f.filename}</span>}
          <span className="faint">{size(f.size)}</span>
        </div>
      ))}
    </section>
  );
}

function Related({ rows, ctx }: { rows: Row[]; ctx: Ctx }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Row[]>([]);
  const search = async (text: string) => {
    setQ(text);
    setHits(text.trim() ? await act.findItems({ project: ctx.project, q: text, not: ctx.itemUid }) : []);
  };
  const pick = async (uid: string) => {
    if (report(await act.relate({ project: ctx.project, itemUid: ctx.itemUid, target: uid }))) {
      setAdding(false);
      setQ("");
      setHits([]);
    }
  };
  const taken = new Set(rows.map((r) => r.uid));
  return (
    <section>
      <div className="label">Related{!ctx.readOnly && <button type="button" className="plus" aria-label="relate an item" onClick={() => setAdding(true)}>+</button>}</div>
      {rows.map((r) => (
        <div key={r.uid} className="rrow" data-uid={r.uid}>
          <Led status={r.status} />
          <a className="grow" href={withBase(`${ctx.readOnly?.base ?? `/p/${ctx.project}`}/i/${r.id}`)}>{r.title}</a>
          {r.developer && <span className="faint">{r.developer}</span>}
          <Remove onConfirm={() => act.unrelate({ project: ctx.project, notes: r.notes })} />
        </div>
      ))}
      {adding && (
        <Popup title="Relate an item" onClose={() => setAdding(false)}>
          <input autoFocus value={q} placeholder="title or id" aria-label="find an item" onChange={(e) => void search(e.target.value)} />
          <div className="picklist">
            {hits.filter((h) => !taken.has(h.uid)).map((h) => (
              <button type="button" key={h.uid} className="rrow pick" onClick={() => void pick(h.uid)}>
                <Led status={h.status} /><span className="grow">{h.title}</span><span className="faint mono-id">{h.id}</span>
              </button>
            ))}
            {q.trim() && !hits.length && <div className="faint">No match.</div>}
          </div>
        </Popup>
      )}
    </section>
  );
}

function Links({ rows, prs, ctx }: { rows: Row[]; prs: Record<string, PrStatus>; ctx: Ctx }) {
  const [adding, setAdding] = useState(false);
  const blank = { url: "", label: "", type: "pr", repo: "", file: "", edit: false };
  const [form, setForm] = useState(blank);
  const [checkouts, setCheckouts] = useState<{ repo: string; dir: string }[]>([]);
  const wt = form.type === "wt-file";
  useEffect(() => { if (adding && wt && !checkouts.length) void act.checkoutChoices().then(setCheckouts); }, [adding, wt, checkouts.length]);
  const ready = wt ? !!form.repo.trim() && !!form.file.trim() : /^https?:\/\//.test(form.url.trim());
  const save = async () => {
    if (!ready) return;
    const r = wt
      ? await act.addWtFileLink({ project: ctx.project, itemUid: ctx.itemUid, repo: form.repo, file: form.file, edit: form.edit })
      : await act.addLink({ project: ctx.project, itemUid: ctx.itemUid, url: form.url, label: form.label, type: form.type });
    if (report(r)) {
      setAdding(false);
      setForm(blank);
    }
  };
  return (
    <section>
      <div className="label">Links{!ctx.readOnly && <button type="button" className="plus" aria-label="add link" onClick={() => setAdding(true)}>+</button>}</div>
      {rows.map((l) => {
        const url = safeUrl(l.meta?.url);
        const tag = LINK_TAG[l.meta?.type] ?? (l.meta?.type && l.meta.type !== "other" ? l.meta.type : null);
        const pr = prs[l.uid];
        return (
          <div key={l.uid} className="rrow" data-uid={l.uid}>
            {pr ? <span className={`tag pr-${pr.state}`}>{tag ?? "PR"} · {pr.state}</span> : tag && <span className="tag">{tag}</span>}
            {url ? <a className="grow" href={url} target="_blank" rel="noreferrer" data-tip={url}>{l.meta?.label || l.text}</a>
                 : <span className="grow">{l.meta?.label || l.text}</span>}
            {pr?.checks && <span className={`checks ck-${pr.checks}`} data-tip={`checks ${CHECKS_TIP[pr.checks]}`}><span className="led" /></span>}
            <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: "note", uid: l.uid, versions: l.versions })} />
          </div>
        );
      })}
      {adding && (
        <Popup title="Add link" onClose={() => setAdding(false)}>
          {wt ? (
            <>
              <input value={form.repo} placeholder="repo: name, owner/name or folder" aria-label="repo" list="wt-checkouts"
                     onChange={(e) => setForm({ ...form, repo: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
              <datalist id="wt-checkouts">
                {checkouts.map((c) => <option key={c.dir} value={c.dir}>{c.repo || c.dir}</option>)}
              </datalist>
              <input value={form.file} placeholder="file, e.g. src/App.svelte" aria-label="file"
                     onChange={(e) => setForm({ ...form, file: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
            </>
          ) : (
            <input value={form.url} placeholder="https://…" aria-label="URL" onChange={(e) => setForm({ ...form, url: e.target.value })}
                   onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />
          )}
          <div className="row">
            {wt
              ? <label className="check"><input type="checkbox" checked={form.edit} onChange={(e) => setForm({ ...form, edit: e.target.checked })} />open in the editor</label>
              : <input value={form.label} placeholder="label" aria-label="label" onChange={(e) => setForm({ ...form, label: e.target.value })}
                       onKeyDown={(e) => { if (e.key === "Enter") void save(); }} />}
            <select value={form.type} aria-label="type" onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {LINK_TYPES.map((t) => <option key={t} value={t}>{t === "wt-file" ? "Watchtower file" : t}</option>)}
            </select>
          </div>
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!ready} onClick={() => void save()}>Add</button>
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
    <div key={c.uid} className="rrow check" data-uid={c.uid}>
      <CheckBox check={{ ...c, item_uid: ctx.itemUid }} project={ctx.project} />
      <span className="grow wrap" data-tip-rich={richTip({
        title: c.title,
        rows: [["kind", c.kind], ["when", TIMING[c.timing] ?? c.timing], ["status", c.status, c.status === "done" ? "ok" : "pending"]],
        code: c.payload || undefined,
      })}>{c.title}</span>
      {c.timing === "post-deploy" && <span className="tag">post</span>}
      <Remove onConfirm={() => act.removeChild({ project: ctx.project, itemUid: ctx.itemUid, entity: "check", uid: c.uid, versions: c.versions })} />
    </div>
  );
  return (
    <section>
      <div className="label">Checks{!ctx.readOnly && <button type="button" className="plus" aria-label="add check" onClick={() => setAdding(true)}>+</button>}</div>
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
             data-tip={[h.by, h.via === "agent" ? "AI" : null, h.forced ? "forced" : null, h.override ? "override" : null, h.note].filter(Boolean).join(" · ")}>
          <Led status={h.to_status} label />{h.override && <span className="tag hot">override</span>}
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
