"use client";
// Compact actions for the QA queue and deploy board, through the same moves
// and popups as the item page.
import { useEffect, useRef, useState } from "react";
import * as act from "@/app/item-actions";
import { moves, type Move } from "@/lib/model";
import { Popup } from "./ui";
import { report } from "./item/ItemView";

type Row = Record<string, any>;

export function MoveButtons({ item, project, to, deployStep = true }: {
  item: Row; project: string; to: { status: string; label: string; primary?: boolean }[]; deployStep?: boolean;
}) {
  const pinned = useRef(item.versions);
  const [popup, setPopup] = useState<Move | null>(null);
  const [text, setText] = useState("");
  const available = moves(item.status, { deployStep, hasQa: !!item.qa_assignee });
  const go = async (move: Move, comment?: string, force?: boolean) => {
    const r = await act.moveItem({ project, uid: item.uid, versions: pinned.current, to: move.status, comment, force });
    if (report(r)) { setPopup(null); setText(""); }
  };
  return (
    <span className="row-acts" onMouseEnter={() => { if (!popup) pinned.current = item.versions; }}>
      {to.map((t) => {
        const move = available.find((m) => m.status === t.status);
        if (!move) return null;
        const needsPopup = !!move.comment || (t.status === "deployed" && item.pending_pre > 0);
        return (
          <button key={t.status} type="button" className={`btn ${t.primary ? "primary" : ""} ${move.rejection ? "danger" : ""}`}
                  onClick={() => (needsPopup ? setPopup(move) : void go(move))}>{t.label}</button>
        );
      })}
      {popup && (
        <Popup title={popup.rejection ? "Send back from QA" : popup.status === "deployed" ? `Deploy with ${item.pending_pre} checks pending?` : popup.status}
               onClose={() => setPopup(null)}>
          {popup.comment && (
            <textarea rows={3} autoFocus value={text} aria-label="comment" placeholder={popup.rejection ? "What failed?" : "Why?"}
                      onChange={(e) => setText(e.target.value)} />
          )}
          <div className="actions">
            <button type="button" className="btn" onClick={() => setPopup(null)}>Cancel</button>
            <button type="button" className={`btn ${popup.rejection || popup.status === "deployed" ? "danger" : "primary"}`}
                    disabled={popup.comment === "required" && !text.trim()}
                    onClick={() => void go(popup, text, popup.status === "deployed")}>
              {popup.rejection ? "Send back" : popup.status === "deployed" ? "Deploy anyway" : "Move"}
            </button>
          </div>
        </Popup>
      )}
    </span>
  );
}

/** A check's checkbox: ticks at once, and untick if the server refuses. */
export function CheckBox({ check, project }: { check: Row; project: string }) {
  const done = check.status === "done";
  const [shown, setShown] = useState<boolean | null>(null);
  useEffect(() => { setShown(null); }, [done]);
  const value = shown ?? done;
  return (
    <input type="checkbox" checked={value} aria-label={`${check.title} done`}
           onChange={() => {
             setShown(!value);
             void act.setCheck({ project, itemUid: check.item_uid, uid: check.uid, versions: check.versions,
                                 status: value ? "pending" : "done" })
               .then((r) => { if (!report(r)) setShown(null); });
           }} />
  );
}

export function MarkAllRead() {
  return <button type="button" className="btn" onClick={() => void act.markAllRead().then(report)}>Mark all read</button>;
}
