"use client";
// A move of a job between the old code (the Jira bridge, the General tab's
// Actions) and the plugin that replaces it: what it will do, in the server's
// words, then the move itself, which the server refuses once what it saw has
// changed.
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/base";
import type { Direction, Move, MovePlan } from "@/lib/plugins/handover";

const path = (project: string) => withBase(`/api/projects/${encodeURIComponent(project)}/plugins/handover`);

export function Handover({ projectKey, repo, move, direction, label, onClose }: {
  projectKey: string; repo: string; move: Move; direction: Direction;
  /** The button that makes the move. */
  label: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    let live = true;
    const q = new URLSearchParams({ repo, move, direction });
    fetch(`${path(projectKey)}?${q}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? `the server answered ${r.status}`))))
      .then((p: MovePlan) => { if (live) setPlan(p); })
      .catch((e: Error) => { if (live) setError({ text: e.message, stale: false }); });
    return () => { live = false; };
  }, [projectKey, repo, move, direction]);
  const go = () => start(async () => {
    const res = await fetch(path(projectKey), {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo, move, direction, base: plan?.base }),
    }).catch(() => null);
    if (res?.ok) {
      router.refresh();
      onClose();
      return;
    }
    const err = res ? await res.json().catch(() => null) : null;
    setError({ text: err?.error ?? (res ? `the server answered ${res.status}` : "the server couldn't be reached"), stale: res?.status === 409 });
  });
  return (
    <div className="auto-panel handover" data-move={`${move}:${direction}`}>
      {!plan && !error && <p className="faint">Working out what moves…</p>}
      {plan && (
        <>
          <ul className="handover-lines">{plan.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          {plan.blockers.map((b) => <p key={b} className="hot">{b}</p>)}
        </>
      )}
      <div className="save-row">
        <button type="button" className="btn primary" disabled={pending || !plan || plan.blockers.length > 0} onClick={go}>{pending ? "Moving…" : label}</button>
        <button type="button" className="btn" disabled={pending} onClick={onClose}>Cancel</button>
        {error && (
          <span className="hot">
            Not moved: {error.text}.{error.stale && <> <button type="button" className="link-btn" onClick={() => { router.refresh(); onClose(); }}>Reload ›</button></>}
          </span>
        )}
      </div>
    </div>
  );
}
