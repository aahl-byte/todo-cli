"use client";
// The item page: status and title, the request, tabbed details, and the right
// rail. Values read as text until clicked; inputs open only on demand. Every
// editor pins the versions it acts on when it opens.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as act from "@/app/item-actions";
import type { ActionState } from "@/lib/action-helpers";
import { COMPLETE, moves, PARKED, STATUSES, type Move } from "@/lib/model";
import type { ItemView as Data } from "@/lib/views";
import { Markdown } from "../Markdown";
import { Composer } from "../Composer";
import { notify } from "../Toaster";
import { Ago, EditableText, Led, Menu, Popup, Stamp } from "../ui";
import { Tasks } from "./Tasks";
import { Rail } from "./Rail";
import { RequestView } from "./RequestView";

type Row = Record<string, any>;
export interface Ctx {
  project: string;
  deployStep: boolean;
  me: string;
  users: string[];
  uploads: boolean;
  jiraBase: string | null;
  itemUid: string;
}

/** Report a refused write in a toast, with the winning change's time local. */
export function report(state: ActionState): boolean {
  if (state.ok) return true;
  const when = state.when ? new Date(state.when) : null;
  const time = when && !Number.isNaN(when.getTime()) ? ` · ${when.toTimeString().slice(0, 5)}` : "";
  notify(`${state.message ?? "Not applied."}${time}`);
  return false;
}

type Tab = "comments" | "questions" | "tasks" | "notes" | "log";

// One visit per mount burst: an immediate remount (React's dev double effect)
// shares the first call's answer instead of recording a second visit.
const visits = new Map<string, { at: number; result: ReturnType<typeof act.seen> }>();
function seenOnce(project: string, itemUid: string) {
  const key = `${project}/${itemUid}`;
  const hit = visits.get(key);
  if (hit && Date.now() - hit.at < 1500) return hit.result;
  const result = act.seen({ project, itemUid });
  visits.set(key, { at: Date.now(), result });
  return result;
}

/** Whether something another person wrote at `ts` arrived since my last visit. */
type IsNew = (ts: string | null | undefined, by: string | null | undefined) => boolean;
const Fresh = createContext<IsNew>(() => false);
export const useIsNew = () => useContext(Fresh);
const NewTag = () => <span className="tag new">new</span>;

function defaultTab(openQuestions: number): Tab {
  return openQuestions ? "questions" : "comments";
}

export function ItemView({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const openQs = data.questions.filter((q) => q.meta?.state !== "answered");
  const [tab, setTab] = useState<Tab>(() => defaultTab(openQs.length));
  const [focus, setFocus] = useState<string | null>(null);

  // `#n-3`, `#t-2`, `#l-5`: open the owning tab, expand and scroll to the entry.
  useEffect(() => {
    const go = () => {
      const m = /^#([ntl])-(\d+)$/.exec(window.location.hash);
      if (!m) return;
      const n = Number(m[2]);
      let target = window.location.hash.slice(1);
      if (m[1] === "t") setTab("tasks");
      else if (m[1] === "l") setTab("log");
      else if (data.request?.n === n) target = "request";
      else {
        const note = [...data.comments, ...data.questions, ...data.notes].find((x) => x.n === n);
        if (note) setTab(note.kind === "clarification" ? "questions" : note.kind === "context" ? "notes" : "comments");
      }
      setFocus(target);
      setTimeout(() => document.getElementById(target)?.scrollIntoView({ block: "center" }), 200);
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tasksDone = data.tasks.filter((t) => COMPLETE.includes(t.status) || PARKED.includes(t.status)).length;
  // The previous visit, fixed for this page view so a live refresh can't clear the highlights.
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void seenOnce(ctx.project, it.uid).then((r) => {
      if (!live) return;
      setLastSeen(r.lastSeen);
      window.dispatchEvent(new CustomEvent("todo:unread", { detail: r.unread }));
    });
    return () => { live = false; };
  }, [ctx.project, it.uid]);
  const isNew: IsNew = (ts, by) => !!lastSeen && !!ts && by !== ctx.me && Date.parse(ts) > Date.parse(lastSeen);
  const newComments = data.comments.some((c) => isNew(c.ts, c.author));
  const newQuestions = data.questions.some((q) => isNew(q.ts, q.author) || isNew(q.meta?.answered_at, q.meta?.answered_by));
  const dot = <span className="new-dot" aria-label="new" />;
  const tabs: { key: Tab; label: string; n?: ReactNode }[] = [
    { key: "comments", label: "Comments", n: data.comments.length ? <>{newComments && dot}{data.comments.length}</> : null },
    { key: "questions", label: "Questions", n: openQs.length || newQuestions ? <>{newQuestions && dot}{openQs.length ? <span className="hot-n">{openQs.length}</span> : null}</> : null },
    { key: "tasks", label: "Tasks", n: data.tasks.length ? `${tasksDone}/${data.tasks.length}` : null },
    { key: "notes", label: "Notes", n: data.notes.length || null },
    { key: "log", label: "Log", n: data.logs.length || null },
  ];

  return (
    <Fresh.Provider value={isNew}>
    <div className="item" data-uid={it.uid}>
      <div className="item-main">
        <Header it={it} ctx={ctx} pendingPre={it.pending_pre} />
        <RequestView data={data} ctx={ctx} focus={focus === "request"} />
        <MobileSummary data={data} ctx={ctx} />
        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? "on" : ""}`}
                    onClick={() => setTab(t.key)}>
              {t.label}{t.n != null && <span className="n">{t.n}</span>}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          {tab === "comments" && <Comments data={data} ctx={ctx} focus={focus} />}
          {tab === "questions" && <Questions data={data} ctx={ctx} focus={focus} />}
          {tab === "tasks" && <Tasks tasks={data.tasks} ctx={ctx} focus={focus} titles={data.phaseTitles} item={data.item} />}
          {tab === "notes" && <Entries kind="context" rows={data.notes} ctx={ctx} focus={focus} />}
          {tab === "log" && <Entries kind="log" rows={data.logs} ctx={ctx} focus={focus} />}
        </div>
      </div>
      <aside className="rail wide-only"><Rail data={data} ctx={ctx} onTasks={() => setTab("tasks")} /></aside>
    </div>
    </Fresh.Provider>
  );
}

// ── header ────────────────────────────────────────────────────────────────────
function Header({ it, ctx, pendingPre }: { it: Row; ctx: Ctx; pendingPre: number }) {
  const pinned = useRef(it.versions);
  const latest = useRef(it.versions);
  latest.current = it.versions;
  const [popup, setPopup] = useState<{ move: Move; versions: Row } | null>(null);
  const [override, setOverride] = useState<{ versions: Row } | null>(null);
  const options = useMemo(() => moves(it.status, { deployStep: ctx.deployStep, hasQa: !!it.qa_assignee, previous: it.blocked_from }), [it, ctx.deployStep]);

  const pick = (to: string) => {
    if (to === OTHER) { setOverride({ versions: pinned.current }); return; }
    const move = options.find((m) => m.status === to)!;
    if (move.comment || (to === "deployed" && pendingPre > 0)) {
      setPopup({ move, versions: pinned.current });
      return;
    }
    void act.moveItem({ project: ctx.project, uid: it.uid, versions: pinned.current, to }).then(report);
  };

  return (
    <div className="head">
      <Menu label="status" tip="status" onOpen={() => { pinned.current = it.versions; }}
            trigger={<><Led status={it.status} label /><span className="caret">▾</span></>}
            options={[...options.map((m, i) => ({
              value: m.status,
              divider: i > 0 && options[i - 1].group !== m.group,
              label: <Led status={m.status} label />,
              hint: m.status === "deployed" && pendingPre > 0 ? `${pendingPre} checks pending`
                : it.status === "blocked" && m.group === "next" ? "unblock" : undefined,
            })), { value: OTHER, divider: true, label: <span className="faint">other…</span> }]}
            onPick={pick} />
      <h1 className="title">
        <EditableText value={it.title} label="title" onStart={() => { pinned.current = it.versions; }}
                      onSave={async (title) => {
                        const ok = report(await act.editItem({ project: ctx.project, uid: it.uid, versions: pinned.current, data: { title } }));
                        // After the notice, a retry is a deliberate overwrite of what the user now knows changed.
                        if (!ok) pinned.current = latest.current;
                        return ok;
                      }} />
      </h1>
      {override && (
        <OverridePopup from={it.status} offered={options.map((m) => m.status)} onClose={() => setOverride(null)}
                       onSubmit={async (to, reason) => {
                         const r = await act.moveItem({ project: ctx.project, uid: it.uid, versions: override.versions, to, comment: reason, override: true });
                         if (report(r)) setOverride(null);
                       }} />
      )}
      {popup && (
        <MovePopup move={popup.move} from={it.status} pendingPre={pendingPre} onClose={() => setPopup(null)}
                   onSubmit={async (comment, force) => {
                     const r = await act.moveItem({ project: ctx.project, uid: it.uid, versions: popup.versions, to: popup.move.status, comment, force });
                     if (report(r)) setPopup(null);
                   }} />
      )}
    </div>
  );
}

const OTHER = "__other";

/** Move anywhere outside the normal flow, with a reason that's kept. */
function OverridePopup({ from, offered, onClose, onSubmit }: {
  from: string; offered: string[]; onClose: () => void; onSubmit: (to: string, reason: string) => Promise<void>;
}) {
  const choices = STATUSES.filter((s) => s !== from && !offered.includes(s));
  const [to, setTo] = useState<string>(choices[0] ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = !busy && !!to && !!reason.trim();
  return (
    <Popup title="Move outside the usual flow" onClose={onClose}>
      <select value={to} aria-label="status" onChange={(e) => setTo(e.target.value)}>
        {choices.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <textarea rows={3} value={reason} aria-label="reason" placeholder="Why (kept in history)" onChange={(e) => setReason(e.target.value)} />
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className="btn danger" disabled={!ok}
                onClick={async () => { setBusy(true); await onSubmit(to, reason); setBusy(false); }}>Move</button>
      </div>
    </Popup>
  );
}

function MovePopup({ move, from, pendingPre, onClose, onSubmit }: {
  move: Move; from: string; pendingPre: number; onClose: () => void; onSubmit: (comment: string, force: boolean) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const forcing = move.status === "deployed" && pendingPre > 0;
  const title = move.rejection ? "Send back from QA"
    : move.status === "blocked" ? "Block"
    : forcing ? `Deploy with ${pendingPre} pre-deploy check${pendingPre > 1 ? "s" : ""} pending?`
    : `${from} → ${move.status}`;
  const placeholder = move.rejection ? "What failed?" : move.status === "blocked" ? "Blocked on…" : "Why?";
  const ok = !busy && (move.comment !== "required" || !!text.trim());
  const submit = async () => { if (!ok) return; setBusy(true); await onSubmit(text, forcing); setBusy(false); };
  return (
    <Popup title={title} onClose={onClose}>
      {move.comment && (
        <textarea rows={3} value={text} aria-label={placeholder} placeholder={move.comment === "optional" ? `${placeholder} (optional)` : placeholder}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} />
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="button" className={`btn ${forcing || move.rejection ? "danger" : "primary"}`} disabled={!ok} onClick={() => void submit()}>
          {forcing ? "Deploy anyway" : move.rejection ? "Send back" : move.status === "blocked" ? "Block" : "Move"}
        </button>
      </div>
    </Popup>
  );
}

// ── mobile summary ────────────────────────────────────────────────────────────
function MobileSummary({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const pending = data.checks.filter((c) => c.timing === "pre-deploy" && c.status !== "done").length;
  return (
    <details className="summary narrow-only">
      <summary>
        <span className="chev">›</span>
        <span className="av">{initials(it.developer)}</span>
        <span className="av">{initials(it.qa_assignee)}</span>
        <span className="dim">{it.type}</span>
        {data.links.length > 0 && <span className="dim">{data.links.length} links</span>}
        {pending > 0 && <span className="tag hot">checks {pending}</span>}
      </summary>
      <div className="rail"><Rail data={data} ctx={ctx} /></div>
    </details>
  );
}

export function initials(handle?: string | null): string {
  if (!handle) return "–";
  return handle.replace(/^jira:/, "").split(/[\s._-]+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}

// ── composer shared by every tab ──────────────────────────────────────────────
export const uploadsFor = (ctx: Ctx) => (ctx.uploads ? { project: ctx.project, scope: ctx.itemUid } : null);

export function AddBox({ label, placeholder, onAdd, users, uploads, children }: {
  label: string; placeholder: string; onAdd: (text: string) => Promise<boolean>; users?: string[];
  uploads?: { project: string; scope: string } | null; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const submit = async () => {
    const el = box.current?.querySelector("textarea");
    const text = el?.value ?? "";
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onAdd(text);
    setBusy(false);
    if (ok) { if (el) el.value = ""; setOpen(false); }
  };
  if (!open) return <button type="button" className="add" onClick={() => setOpen(true)}><span className="pl" aria-hidden="true">+</span>{label}</button>;
  return (
    <div ref={box} className="composer"
         onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}>
      {children}
      <Composer users={users ?? []} placeholder={placeholder} uploads={uploads} rows={2} autoFocus />
      <div className="actions">
        <button type="button" className="btn" onClick={() => setOpen(false)}>Esc</button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void submit()}>Add</button>
      </div>
    </div>
  );
}

// ── comments ──────────────────────────────────────────────────────────────────
function Comments({ data, ctx, focus }: { data: Data; ctx: Ctx; focus: string | null }) {
  const isNew = useIsNew();
  return (
    <>
      <AddBox label="comment" placeholder="Comment — @ to mention" users={ctx.users} uploads={uploadsFor(ctx)}
              onAdd={async (text) => report(await act.addEntry({ project: ctx.project, itemUid: ctx.itemUid, kind: "comment", text }))} />
      <ul className="entries">
        {[...data.comments].reverse().map((c) => (
          <li key={c.uid} id={`n-${c.n}`} className={`entry ${focus === `n-${c.n}` ? "focus" : ""} ${isNew(c.ts, c.author) ? "is-new" : ""}`} data-uid={c.uid}>
            <div className="body">
              <div className="who">
                {isNew(c.ts, c.author) && <NewTag />}
                {c.kind === "qa-rejection" && <span className="tag rej">QA rejected</span>} {c.author}
                {c.via === "agent" && <span className="ai">AI</span>}
                {c.source === "jira" && <span className="faint"> · jira</span>} <Ago ts={c.ts} />
                {c.meta?.edited_at && <span className="faint" data-tip={`edited ${new Date(c.meta.edited_at).toLocaleString()}`}> · edited</span>}
              </div>
              <Markdown text={c.text} />
            </div>
            {c.author === ctx.me && <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: "note", uid: c.uid, versions: c.versions })} />}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── questions ─────────────────────────────────────────────────────────────────
function Questions({ data, ctx, focus }: { data: Data; ctx: Ctx; focus: string | null }) {
  const isNew = useIsNew();
  const open = data.questions.filter((q) => q.meta?.state !== "answered");
  const answered = data.questions.filter((q) => q.meta?.state === "answered");
  const [showAnswered, setShowAnswered] = useState(() => answered.some((q) => focus === `n-${q.n}`));
  const newAnswer = answered.some((q) => isNew(q.meta?.answered_at, q.meta?.answered_by));
  useEffect(() => { if (newAnswer) setShowAnswered(true); }, [newAnswer]);
  useEffect(() => {
    if (answered.some((q) => focus === `n-${q.n}`)) setShowAnswered(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  return (
    <>
      <AddBox label="ask" placeholder="Ask a question" users={ctx.users}
              onAdd={async (text) => report(await act.addEntry({ project: ctx.project, itemUid: ctx.itemUid, kind: "clarification", text }))} />
      <ul className="entries">
        {open.map((q) => <OpenQuestion key={q.uid} q={q} ctx={ctx} focus={focus} />)}
      </ul>
      {answered.length > 0 && (
        <>
          <button type="button" className="tgroup" onClick={() => setShowAnswered((s) => !s)}>
            <span className={`chev ${showAnswered ? "open" : ""}`}>›</span> answered {answered.length}
          </button>
          {showAnswered && (
            <ul className="entries">
              {answered.map((q) => (
                <li key={q.uid} id={`n-${q.n}`} className={`entry ${focus === `n-${q.n}` ? "focus" : ""} ${isNew(q.meta?.answered_at, q.meta?.answered_by) ? "is-new" : ""}`} data-uid={q.uid}>
                  <div className="body">
                    <div className="dim"><Markdown text={q.text} /></div>
                    <Markdown text={q.meta?.answer ?? ""} />
                    <div className="who">{isNew(q.meta?.answered_at, q.meta?.answered_by) && <NewTag />}{q.meta?.answered_by} <Ago ts={q.meta?.answered_at} /></div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );
}

function OpenQuestion({ q, ctx, focus }: { q: Row; ctx: Ctx; focus: string | null }) {
  const fresh = useIsNew()(q.ts, q.author);
  const [answering, setAnswering] = useState(false);
  const pinned = useRef(q.versions);
  const [draft, setDraft] = useState("");
  const send = async () => {
    if (!draft.trim()) return;
    if (report(await act.answerQuestion({ project: ctx.project, itemUid: ctx.itemUid, uid: q.uid, versions: pinned.current, text: draft }))) {
      setAnswering(false);
      setDraft("");
    }
  };
  return (
    <li id={`n-${q.n}`} className={`entry question ${focus === `n-${q.n}` ? "focus" : ""} ${fresh ? "is-new" : ""}`} data-uid={q.uid}>
      <div className="body">
        <div className="who">{fresh && <NewTag />}{q.author}{q.via === "agent" && <span className="ai">AI</span>} <Ago ts={q.ts} /></div>
        <Markdown text={q.text} />
        {answering ? (
          <div className="composer" onKeyDown={(e) => { if (e.key === "Escape") setAnswering(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}>
            <textarea rows={2} autoFocus value={draft} aria-label="answer" placeholder="Answer" onChange={(e) => setDraft(e.target.value)} />
            <div className="actions">
              <button type="button" className="btn" onClick={() => setAnswering(false)}>Esc</button>
              <button type="button" className="btn primary" disabled={!draft.trim()} onClick={() => void send()}>Answer</button>
            </div>
          </div>
        ) : (
          <button type="button" className="add" onClick={() => { pinned.current = q.versions; setAnswering(true); }}>answer</button>
        )}
      </div>
    </li>
  );
}

// ── notes and dev log (watchtower: collapsed to the first line) ───────────────
function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i);
}

function Entries({ kind, rows, ctx, focus }: { kind: "context" | "log"; rows: Row[]; ctx: Ctx; focus: string | null }) {
  const prefix = kind === "log" ? "l" : "n";
  const [open, setOpen] = useState<Record<string, boolean>>(() => (focus ? { [focus]: true } : {}));
  useEffect(() => { if (focus) setOpen((o) => ({ ...o, [focus]: true })); }, [focus]);
  const allOpen = rows.length > 0 && rows.every((r) => open[`${prefix}-${r.n}`]);
  return (
    <>
      <AddBox label={kind === "log" ? "log" : "note"} placeholder={kind === "log" ? "What you did, what broke, what you swapped" : "Context — the why, a decision, a gotcha"}
              users={ctx.users} uploads={uploadsFor(ctx)}
              onAdd={async (text) => report(await act.addEntry({ project: ctx.project, itemUid: ctx.itemUid, kind: kind === "log" ? "log" : "context", text }))} />
      {rows.length > 1 && (
        <div className="list-head">
          <button type="button" className="more right" onClick={() => setOpen(Object.fromEntries(rows.map((r) => [`${prefix}-${r.n}`, !allOpen])))}>
            {allOpen ? "collapse all" : "expand all"}
          </button>
        </div>
      )}
      <ul className="entries">
        {[...rows].reverse().map((r) => <Entry key={r.uid} row={r} kind={kind} ctx={ctx} id={`${prefix}-${r.n}`}
                                open={!!open[`${prefix}-${r.n}`]} focus={focus === `${prefix}-${r.n}`}
                                toggle={() => setOpen((o) => ({ ...o, [`${prefix}-${r.n}`]: !o[`${prefix}-${r.n}`] }))} />)}
      </ul>
    </>
  );
}

function Entry({ row, kind, ctx, id, open, focus, toggle }: {
  row: Row; kind: "context" | "log"; ctx: Ctx; id: string; open: boolean; focus: boolean; toggle: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.text);
  const pinned = useRef(row.versions);
  const tip = [row.author, row.via === "agent" ? "AI" : null, row.ts ? new Date(row.ts).toLocaleString() : null].filter(Boolean).join(" · ");
  const save = async () => {
    if (report(await act.editNote({ project: ctx.project, itemUid: ctx.itemUid, uid: row.uid, versions: pinned.current, text: draft }))) setEditing(false);
  };
  return (
    <li id={id} className={`entry ${focus ? "focus" : ""}`} data-uid={row.uid}>
      <button type="button" className={`chev ${open ? "open" : ""}`} aria-expanded={open} aria-label={open ? "collapse" : "expand"} onClick={toggle}>›</button>
      {kind === "log" && <Stamp ts={row.ts} tip={tip} />}
      <div className="body" data-tip={kind === "context" ? tip : undefined}>
        {editing ? (
          <div className="composer" onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(); }}>
            <textarea rows={4} autoFocus value={draft} aria-label="note" onChange={(e) => setDraft(e.target.value)} />
            <div className="actions">
              <button type="button" className="btn" onClick={() => setEditing(false)}>Esc</button>
              <button type="button" className="btn primary" disabled={!draft.trim()} onClick={() => void save()}>Save</button>
            </div>
          </div>
        ) : open ? <Markdown text={row.text} /> : (
          <button type="button" className="first" onClick={toggle}>
            <Markdown text={firstLine(row.text)} oneLine />
          </button>
        )}
      </div>
      {!editing && (
        <span className="acts">
          {kind === "context" && <button type="button" className="x" aria-label="edit" onClick={() => { pinned.current = row.versions; setDraft(row.text); setEditing(true); }}>✎</button>}
          <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: kind === "log" ? "log" : "note", uid: row.uid, versions: row.versions })} />
        </span>
      )}
    </li>
  );
}

/** ✕, then a second click on "delete?" within a few seconds. */
export function Remove({ onConfirm }: { onConfirm: () => Promise<ActionState> }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return armed
    ? <button type="button" className="x armed" onClick={() => { setArmed(false); void onConfirm().then(report); }}>delete?</button>
    : <button type="button" className="x" aria-label="remove" onClick={() => setArmed(true)}>✕</button>;
}
