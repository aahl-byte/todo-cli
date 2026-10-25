"use client";
// The item page: status and title, the request, tabbed details, and the right
// rail. Values read as text until clicked; inputs open only on demand. Every
// editor pins the versions it acts on when it opens.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as act from "@/app/item-actions";
import type { ActionState } from "@/lib/action-helpers";
import { docPath } from "@/lib/doc-view";
import { COMPLETE, isAgentParty, moves, PARKED, REASONED, SEEN, STATUSES, type Move } from "@/lib/model";
import type { ItemView as Data } from "@/lib/views";
import { Markdown } from "../Markdown";
import { ReadOnly, useReadOnly, type ReadOnlyView } from "../ReadOnly";
import { Composer } from "../Composer";
import { notify } from "../Toaster";
import { Ago, EditableText, Led, Menu, Popup, Stamp } from "../ui";
import { Docs } from "./Docs";
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
  pinned: boolean;
  actions: { id: string; name: string; runner: string }[];
  /** Set on a wall display: everything shows, nothing writes. */
  readOnly?: ReadOnlyView | null;
  /** The viewer's last visit, given up front by a page that doesn't record one. */
  lastSeen?: string | null;
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

/** Whether something I didn't write myself (another person, or my agent) arrived at `ts`, since my last visit. */
type IsNew = (ts: string | null | undefined, by: string | null | undefined, via?: string | null) => boolean;
const Fresh = createContext<IsNew>(() => false);
export const useIsNew = () => useContext(Fresh);
const NewTag = () => <span className="tag new">new</span>;

/** Where `doc:` references in this item's text point; none on a read-only page. */
const DocsBase = createContext<string | undefined>(undefined);

/** Markdown whose stored images load through a read-only page's own path. */
export function Md(props: { text: string; oneLine?: boolean }) {
  const readOnly = useReadOnly();
  const docs = useContext(DocsBase);
  return <Markdown {...props} files={readOnly ? `${readOnly.base}/files` : undefined} docs={readOnly ? undefined : docs} />;
}

/** Who hasn't acknowledged an entry's latest content: any agent, and you. */
function Seen({ row, entity, ctx }: { row: Row; entity: "note" | "log"; ctx: Ctx }) {
  const seen = row.meta?.[SEEN];
  if (!Array.isArray(seen)) return null;
  const ack = async () => report(await act.acknowledge({ project: ctx.project, itemUid: ctx.itemUid, entries: [{ entity, uid: row.uid }] }));
  return (
    <>
      {!seen.some(isAgentParty) && <span className="tag unseen" data-tip="No agent has acknowledged this yet">AI unseen</span>}
      {!seen.includes(ctx.me) && !ctx.readOnly && <button type="button" className="ack" onClick={() => void ack()}>mark seen</button>}
    </>
  );
}

function defaultTab(openQuestions: number): Tab {
  return openQuestions ? "questions" : "comments";
}

/** A question waits on its reader unless they asked it themself. */
export const askedByMe = (q: Row, me: string) => q.author === me && q.via !== "agent";

export function ItemView({ data, ctx }: { data: Data; ctx: Ctx }) {
  const it = data.item;
  const openQs = data.questions.filter((q) => isOpenQ(q) && !askedByMe(q, ctx.me));
  const myOpenQs = data.questions.filter(isOpenQ).length - openQs.length;
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
        if (note) setTab(note.kind === "clarification" || note.meta?.thread ? "questions" : note.kind === "context" ? "notes" : "comments");
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
  const [lastSeen, setLastSeen] = useState<string | null>(ctx.lastSeen ?? null);
  useEffect(() => {
    if (ctx.readOnly) return;
    let live = true;
    void seenOnce(ctx.project, it.uid).then((r) => {
      if (!live) return;
      setLastSeen(r.lastSeen);
      window.dispatchEvent(new CustomEvent("todo:unread", { detail: r.unread }));
    });
    return () => { live = false; };
  }, [ctx.project, it.uid, ctx.readOnly]);
  const isNew: IsNew = (ts, by, via) => !!lastSeen && !!ts && !(by === ctx.me && via !== "agent") && Date.parse(ts) > Date.parse(lastSeen);
  const newComments = data.comments.some((c) => isNew(c.ts, c.author, c.via));
  const newQuestions = data.questions.some((q) => isNew(q.ts, q.author, q.via) || answerIsNew(isNew, q));
  const dot = <span className="new-dot" aria-label="new" />;
  const tabs: { key: Tab; label: string; n?: ReactNode }[] = [
    { key: "comments", label: "Comments", n: data.comments.length ? <>{newComments && dot}{data.comments.length}</> : null },
    { key: "questions", label: "Questions", n: openQs.length || myOpenQs || newQuestions ? <>{newQuestions && dot}
        {openQs.length ? <span className="q-n">{openQs.length}</span> : myOpenQs ? <span className="faint" data-tip="your questions, waiting on an answer">{myOpenQs}</span> : null}</> : null },
    { key: "tasks", label: "Tasks", n: data.tasks.length ? `${tasksDone}/${data.tasks.length}` : null },
    { key: "notes", label: "Notes", n: data.notes.length || null },
    { key: "log", label: "Log", n: data.logs.length || null },
  ];

  return (
    <ReadOnly.Provider value={ctx.readOnly ?? null}>
    <DocsBase.Provider value={docPath(ctx.project, it.id, "").replace(/\/$/, "")}>
    <Fresh.Provider value={isNew}>
    <div className="item" data-uid={it.uid}>
      <div className="item-main">
        <Header it={it} ctx={ctx} pendingPre={it.pending_pre} />
        <RequestView data={data} ctx={ctx} focus={focus === "request"} />
        <Docs rows={data.docs} ctx={ctx} itemId={it.id} />
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
    </DocsBase.Provider>
    </ReadOnly.Provider>
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
      {!ctx.readOnly && <button type="button" className={`btn ${ctx.pinned ? "on" : ""}`} aria-pressed={ctx.pinned}
              data-tip={ctx.pinned ? "unpin from the left bar" : "pin to the left bar"}
              onClick={() => void act.pin({ project: ctx.project, itemUid: it.uid, on: !ctx.pinned })}>
        {ctx.pinned ? "pinned" : "pin"}
      </button>}
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
    : move.status === "cancelled" ? "Cancel"
    : forcing ? `Deploy with ${pendingPre} pre-deploy check${pendingPre > 1 ? "s" : ""} pending?`
    : `${from} → ${move.status}`;
  const placeholder = move.rejection ? "What failed?" : move.status === "blocked" ? "Blocked on…"
    : move.status === "cancelled" ? "Why it won't be done" : "Why?";
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
          {forcing ? "Deploy anyway" : move.rejection ? "Send back" : move.status === "blocked" ? "Block" : move.status === "cancelled" ? "Cancel it" : "Move"}
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
  const readOnly = useReadOnly();
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
  if (readOnly) return null;
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
          <li key={c.uid} id={`n-${c.n}`} className={`entry ${focus === `n-${c.n}` ? "focus" : ""} ${isNew(c.ts, c.author, c.via) ? "is-new" : ""}`} data-uid={c.uid}>
            <div className="body">
              <div className="who">
                {isNew(c.ts, c.author, c.via) && <NewTag />}
                {c.kind === "qa-rejection" && <span className="tag rej">QA rejected</span>}
                {c.kind === "comment" && REASONED.includes(c.meta?.with_status) && <span className="tag rej">{c.meta.with_status}</span>} {c.author}
                {c.via === "agent" && <span className="ai">AI</span>}
                {c.source === "jira" && <span className="faint"> · jira</span>} <Ago ts={c.ts} />
                {c.meta?.edited_at && <span className="faint" data-tip={`edited ${new Date(c.meta.edited_at).toLocaleString()}`}> · edited</span>}
                <Seen row={c} entity="note" ctx={ctx} />
              </div>
              <Md text={c.text} />
            </div>
            {c.author === ctx.me && <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: "note", uid: c.uid, versions: c.versions })} />}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── questions ─────────────────────────────────────────────────────────────────
const isOpenQ = (q: Row) => q.kind === "clarification" && q.meta?.state !== "answered";

interface Thread { root: Row; entries: Row[]; open: boolean }

/** Each question with its follow-ups (questions and replies naming it in meta.thread), in order. */
function threads(rows: Row[]): Thread[] {
  const uids = new Set(rows.map((r) => r.uid));
  return rows.filter((r) => !r.meta?.thread || !uids.has(r.meta.thread)).map((root) => {
    const entries = [root, ...rows.filter((r) => r !== root && r.meta?.thread === root.uid).sort((a, b) => a.n - b.n)];
    return { root, entries, open: entries.some(isOpenQ) };
  });
}

/** When the thread last moved: its newest question, reply or answer. */
const lastActivity = (t: Thread) =>
  Math.max(...t.entries.flatMap((q) => [Date.parse(q.ts), Date.parse(q.meta?.answered_at ?? "")]).filter((n) => !Number.isNaN(n)));

const threadIsNew = (isNew: IsNew, t: Thread) => t.entries.some((q) => answerIsNew(isNew, q) || isNew(q.ts, q.author, q.via));

function Questions({ data, ctx, focus }: { data: Data; ctx: Ctx; focus: string | null }) {
  const isNew = useIsNew();
  const all = threads(data.questions);
  const unread = all.filter((t) => threadIsNew(isNew, t)).sort((a, b) => lastActivity(b) - lastActivity(a));
  const rest = all.filter((t) => !unread.includes(t));
  const answered = rest.filter((t) => !t.open).sort((a, b) => lastActivity(b) - lastActivity(a));
  return (
    <>
      <AddBox label="ask" placeholder="Ask a question" users={ctx.users}
              onAdd={async (text) => report(await act.addEntry({ project: ctx.project, itemUid: ctx.itemUid, kind: "clarification", text }))} />
      <ThreadGroup label="unread" list={unread} ctx={ctx} focus={focus} />
      <ThreadGroup label="questions" list={rest.filter((t) => t.open)} ctx={ctx} focus={focus} />
      <ThreadGroup label="answers" list={answered} ctx={ctx} focus={focus} />
    </>
  );
}

function ThreadGroup({ label, list, ctx, focus }: { label: string; list: Thread[]; ctx: Ctx; focus: string | null }) {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    if (list.some((t) => t.entries.some((q) => focus === `n-${q.n}`))) setShown(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  if (!list.length) return null;
  return (
    <>
      <button type="button" className="tgroup" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        <span className={`chev ${shown ? "open" : ""}`}>›</span> {label} {list.length}
      </button>
      {shown && <ul className="entries">{list.map((t) => <QuestionThread key={t.root.uid} t={t} ctx={ctx} focus={focus} />)}</ul>}
    </>
  );
}

function QuestionThread({ t, ctx, focus }: { t: Thread; ctx: Ctx; focus: string | null }) {
  const isNew = useIsNew();
  const [following, setFollowing] = useState(false);
  const focused = t.entries.some((q) => focus === `n-${q.n}`);
  return (
    <li className={`entry thread ${t.open ? "question" : ""} ${focused ? "focus" : ""} ${threadIsNew(isNew, t) ? "is-new" : ""}`} data-uid={t.root.uid}>
      <div className="body">
        {t.entries.map((q, i) => (
          <div key={q.uid} id={`n-${q.n}`} className={`turn ${i ? "follow" : ""}`} data-uid={q.uid}>
            {q.kind === "clarification" ? <Question q={q} ctx={ctx} /> : <Reply r={q} ctx={ctx} />}
          </div>
        ))}
        {ctx.readOnly ? null : following
          ? <FollowUp root={t.root} ctx={ctx} onDone={() => setFollowing(false)} />
          : <button type="button" className="add" onClick={() => setFollowing(true)}><span className="pl" aria-hidden="true">+</span>follow up</button>}
      </div>
    </li>
  );
}

function Who({ by, via, ts, fresh, children }: { by: string; via?: string | null; ts: string; fresh: boolean; children?: ReactNode }) {
  return <div className="who">{fresh && <NewTag />}{by}{via === "agent" && <span className="ai">AI</span>} <Ago ts={ts} />{children}</div>;
}

function Question({ q, ctx }: { q: Row; ctx: Ctx }) {
  const isNew = useIsNew();
  const mine = askedByMe(q, ctx.me);
  const open = isOpenQ(q);
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
    <>
      <Who by={q.author} via={q.via} ts={q.ts} fresh={isNew(q.ts, q.author, q.via)}>
        {open && mine && <span className="tag waiting" data-tip="you asked this; it waits on an answer">waiting for an answer</span>}
        <Seen row={q} entity="note" ctx={ctx} />
      </Who>
      <div className={`qa-q ${open ? (mine ? "mine" : "open") : ""}`}><span className="qa-tag">Q</span><div><Md text={q.text} /></div></div>
      {!open && (
        <>
          <div className="qa-a"><span className="qa-tag">A</span><div><Md text={q.meta?.answer ?? ""} /></div></div>
          <Who by={q.meta?.answered_by} via={q.meta?.answered_via} ts={q.meta?.answered_at} fresh={answerIsNew(isNew, q)} />
        </>
      )}
      {open && !ctx.readOnly && (answering ? (
        <div className="composer" onKeyDown={(e) => { if (e.key === "Escape") setAnswering(false); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(); }}>
          <textarea rows={2} autoFocus value={draft} aria-label="answer" placeholder="Answer" onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setAnswering(false)}>Esc</button>
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={() => void send()}>Answer</button>
          </div>
        </div>
      ) : (
        <button type="button" className="add" onClick={() => { pinned.current = q.versions; setAnswering(true); }}>answer</button>
      ))}
    </>
  );
}

function Reply({ r, ctx }: { r: Row; ctx: Ctx }) {
  const isNew = useIsNew();
  return (
    <>
      <Who by={r.author} via={r.via} ts={r.ts} fresh={isNew(r.ts, r.author, r.via)}><Seen row={r} entity="note" ctx={ctx} /></Who>
      <div className="qa-r"><span className="qa-tag">↳</span><div><Md text={r.text} /></div></div>
    </>
  );
}

/** Continue a thread: another question (stays open until answered), or a reply such as an instruction. */
function FollowUp({ root, ctx, onDone }: { root: Row; ctx: Ctx; onDone: () => void }) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const post = async (kind: "clarification" | "comment") => {
    if (!draft.trim() || busy) return;
    setBusy(true);
    const ok = report(await act.addEntry({ project: ctx.project, itemUid: ctx.itemUid, kind, text: draft, thread: root.uid }));
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <div className="composer" onKeyDown={(e) => { if (e.key === "Escape") onDone(); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void post("clarification"); }}>
      <textarea rows={2} autoFocus value={draft} aria-label="follow up" placeholder="Ask another question, or reply with an instruction"
                onChange={(e) => setDraft(e.target.value)} />
      <div className="actions">
        <button type="button" className="btn" onClick={onDone}>Esc</button>
        <button type="button" className="btn" disabled={busy || !draft.trim()} onClick={() => void post("comment")}
                data-tip="a reply in the thread; it doesn't wait on an answer">Reply</button>
        <button type="button" className="btn primary" disabled={busy || !draft.trim()} onClick={() => void post("clarification")}
                data-tip="a question that stays open until answered">Ask</button>
      </div>
    </div>
  );
}

const answerIsNew = (isNew: IsNew, q: Row) => isNew(q.meta?.answered_at, q.meta?.answered_by, q.meta?.answered_via);

// ── notes and dev log (watchtower: collapsed to the first line) ───────────────
function firstLine(text: string): string {
  const i = text.indexOf("\n");
  return i < 0 ? text : text.slice(0, i);
}

function Entries({ kind, rows, ctx, focus }: { kind: "context" | "log"; rows: Row[]; ctx: Ctx; focus: string | null }) {
  const prefix = kind === "log" ? "l" : "n";
  const latest = rows.length ? `${prefix}-${rows[rows.length - 1].n}` : null;
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries([latest, focus].filter(Boolean).map((k) => [k, true])));
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
        ) : open ? <Md text={row.text} /> : (
          <button type="button" className="first" onClick={toggle}>
            <Md text={firstLine(row.text)} oneLine />
          </button>
        )}
      </div>
      {!editing && (
        <span className="acts">
          <Seen row={row} entity={kind === "log" ? "log" : "note"} ctx={ctx} />
          {kind === "context" && !ctx.readOnly && <button type="button" className="x" aria-label="edit" onClick={() => { pinned.current = row.versions; setDraft(row.text); setEditing(true); }}>✎</button>}
          <Remove onConfirm={() => act.removeEntry({ project: ctx.project, itemUid: ctx.itemUid, entity: kind === "log" ? "log" : "note", uid: row.uid, versions: row.versions })} />
        </span>
      )}
    </li>
  );
}

/** ✕, then a second click on "delete?" within a few seconds. */
export function Remove({ onConfirm }: { onConfirm: () => Promise<ActionState> }) {
  const readOnly = useReadOnly();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  if (readOnly) return null;
  return armed
    ? <button type="button" className="x armed" onClick={() => { setArmed(false); void onConfirm().then(report); }}>delete?</button>
    : <button type="button" className="x" aria-label="remove" onClick={() => setArmed(true)}>✕</button>;
}
