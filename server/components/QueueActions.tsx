"use client";
// Compact actions for the QA queue and deploy board, through the same moves
// and popups as the item page.
import { useEffect, useRef, useState } from "react";
import * as act from "@/app/item-actions";
import { useReadOnly } from "./ReadOnly";
import { ENVIRONMENTS, moves, ticked, type Move } from "@/lib/model";
import type { WaitLine } from "@/lib/waits";
import { MovePopup, report } from "./item/ItemView";

type Row = Record<string, any>;

export function MoveButtons({ item, project, to, deployStep = true }: {
  item: Row; project: string; to: { status: string; label: string; primary?: boolean }[]; deployStep?: boolean;
}) {
  const pinned = useRef(item.versions);
  const [popup, setPopup] = useState<{ move: Move; waits: WaitLine[] } | null>(null);
  const available = moves(item.status, { deployStep, hasQa: !!item.qa_assignee });
  const go = async (move: Move, comment?: string, force?: boolean) => {
    const r = await act.moveItem({ project, uid: item.uid, versions: pinned.current, to: move.status, comment, force });
    // A stage the dependency guard refused opens the dialog with what it waits on, to stage anyway.
    if (r.waits?.length) setPopup({ move, waits: r.waits });
    else if (report(r)) setPopup(null);
  };
  return (
    <span className="row-acts" onMouseEnter={() => { if (!popup) pinned.current = item.versions; }}>
      {to.map((t) => {
        const move = available.find((m) => m.status === t.status);
        if (!move) return null;
        const needsPopup = !!move.comment || (t.status === "deployed" && item.pending_pre > 0);
        return (
          <button key={t.status} type="button" className={`btn ${t.primary ? "primary" : ""} ${move.rejection ? "danger" : ""}`}
                  onClick={() => (needsPopup ? setPopup({ move, waits: [] }) : void go(move))}>{t.label}</button>
        );
      })}
      {popup && (
        <MovePopup move={popup.move} from={item.status} pendingPre={item.pending_pre ?? 0} waits={popup.waits} project={project} itemId={item.id}
                   onClose={() => setPopup(null)} onSubmit={(comment, force) => go(popup.move, comment, force)} />
      )}
    </span>
  );
}

/** A check's D S P checkboxes: each ticks at once, and unticks if the server refuses. */
export function CheckBox({ check, project }: { check: Row; project: string }) {
  const readOnly = useReadOnly();
  const saved = ticked(check);
  const key = saved.join(",");
  const [shown, setShown] = useState<string[] | null>(null);
  useEffect(() => { setShown(null); }, [key]);
  const on = shown ?? saved;
  return (
    <span className="env-checks">
      {Object.entries(ENVIRONMENTS).map(([env, label]) => (
        <label key={env} className={`env-box env-${env}`} data-tip={env}>
          <input type="checkbox" checked={on.includes(env)} disabled={!!readOnly} aria-label={`${check.title} done in ${env}`}
                 onChange={() => {
                   const next = !on.includes(env);
                   setShown(next ? [...on, env] : on.filter((e) => e !== env));
                   void act.setCheck({ project, itemUid: check.item_uid, uid: check.uid, versions: check.versions,
                                       envs: on.join(",") || null, status: on.includes("production") ? "done" : "pending", env, on: next })
                     .then((r) => { if (!report(r)) setShown(null); });
                 }} />
          <span aria-hidden>{label}</span>
        </label>
      ))}
    </span>
  );
}

