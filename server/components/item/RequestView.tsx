"use client";
// The request: its current version, the frozen versions before it with a line
// diff each, the version triage covered, and editing that posts a new version
// once the current one is frozen.
import { useRef, useState } from "react";
import * as act from "@/app/item-actions";
import type { ItemView as Data } from "@/lib/views";
import { Markdown } from "../Markdown";
import { Ago, Popup } from "../ui";
import { report, type Ctx } from "./ItemView";

type Row = Record<string, any>;
const LONG_LINES = 6;

/** Line diff by longest common subsequence: [kind, line] with kind " ", "+" or "-". */
export function lineDiff(before: string, after: string): [string, string][] {
  const a = before.split("\n"), b = after.split("\n");
  const L = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const out: [string, string][] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push([" ", a[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push(["-", a[i++]]);
    else out.push(["+", b[j++]]);
  }
  while (i < a.length) out.push(["-", a[i++]]);
  while (j < b.length) out.push(["+", b[j++]]);
  return out;
}

function Diff({ before, after }: { before: string; after: string }) {
  return (
    <pre className="diff">
      {lineDiff(before, after).map(([k, line], i) => (
        <div key={i} className={k === "+" ? "add-l" : k === "-" ? "del-l" : "same-l"}>{k} {line}</div>
      ))}
    </pre>
  );
}

export function RequestView({ data, ctx, focus }: { data: Data; ctx: Ctx; focus?: boolean }) {
  const it = data.item;
  const req = data.request;
  const versions: Row[] = data.requestVersions;
  const version = Number(req?.meta?.version ?? 1);
  const editable = !!req && it.status === "requested" && !req.meta?.frozen;
  const [mode, setMode] = useState<null | "inline" | "new">(null);
  const [draft, setDraft] = useState("");
  const [refused, setRefused] = useState(false);
  const [open, setOpen] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const pinned = useRef(req?.versions ?? {});
  const long = (req?.text ?? "").split("\n").length > LONG_LINES || (req?.text ?? "").length > 600;

  const start = () => {
    pinned.current = req?.versions ?? {};
    setDraft(req?.text ?? "");
    setRefused(false);
    setMode(editable ? "inline" : "new");
  };
  const save = async (asNew: boolean) => {
    const r = await act.saveRequest({ project: ctx.project, itemUid: it.uid, noteUid: req?.uid ?? null,
                                      versions: pinned.current, text: draft, newVersion: asNew || !editable });
    if (report(r)) { setMode(null); return; }
    if (!asNew) setRefused(true);
  };

  return (
    <div id="request" className={`request ${long && !open && mode !== "inline" ? "clamp" : ""} ${focus ? "focus" : ""}`}>
      {mode === "inline" ? (
        <div className="composer" onKeyDown={(e) => { if (e.key === "Escape") setMode(null); if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save(false); }}>
          <textarea rows={6} autoFocus value={draft} aria-label="request" onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setMode(null)}>Esc</button>
            {refused && <button type="button" className="btn" onClick={() => void save(true)}>Save as v{versions.length + 1}</button>}
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={() => void save(false)}>Save</button>
          </div>
        </div>
      ) : req && <Markdown text={req.text} />}

      <div className="request-acts">
        {long && mode !== "inline" && <button type="button" className="more" onClick={() => setOpen((o) => !o)}>{open ? "less" : "more"}</button>}
        {mode !== "inline" && (
          <button type="button" className="add" onClick={start}>{!req ? <><span className="pl" aria-hidden="true">+</span>request</> : editable ? "✎ edit" : "✎ new version"}</button>
        )}
        {req && (
          <button type="button" className="more" aria-expanded={showVersions} onClick={() => setShowVersions((s) => !s)}>
            v{version}{versions.length > 1 && <> · versions <span className={`chev ${showVersions ? "open" : ""}`}>›</span></>}
          </button>
        )}
        {data.untriaged && (
          <span className="hot flag" data-tip="the version being worked on never went through triage">
            v{version} not triaged{data.triagedVersion ? ` · last triaged v${data.triagedVersion}` : ""}
          </span>
        )}
      </div>

      {showVersions && versions.length > 0 && (
        <ol className="versions">
          {versions.map((v, i) => <Version key={v.uid} v={v} previous={versions[i + 1]} current={i === 0} />)}
        </ol>
      )}

      {mode === "new" && (
        <Popup title={`Request v${versions.length + 1}`} onClose={() => setMode(null)}>
          <div className="faint">Saving sends it back to requested.</div>
          <textarea rows={8} value={draft} aria-label="request" onChange={(e) => setDraft(e.target.value)} />
          <div className="actions">
            <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
            <button type="button" className="btn primary" disabled={!draft.trim() || draft.trim() === (req?.text ?? "").trim()}
                    onClick={() => void save(true)}>Save v{versions.length + 1}</button>
          </div>
        </Popup>
      )}
    </div>
  );
}

function Version({ v, previous, current }: { v: Row; previous?: Row; current: boolean }) {
  const [open, setOpen] = useState(false);
  const meta = v.meta ?? {};
  return (
    <li className="version">
      <button type="button" className="tgroup" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`chev ${open ? "open" : ""}`}>›</span>v{meta.version ?? 1}
        {current && <span className="faint">current</span>}
        {meta.triaged ? <span className="tag ok">triaged{meta.triaged_by ? ` · ${meta.triaged_by}` : ""}</span>
          : meta.frozen ? <span className="tag">frozen</span> : <span className="tag">draft</span>}
        <Ago ts={meta.frozen_at ?? v.ts} />
      </button>
      {open && (previous ? <Diff before={previous.text} after={v.text} /> : <div className="md-box"><Markdown text={v.text} /></div>)}
    </li>
  );
}
